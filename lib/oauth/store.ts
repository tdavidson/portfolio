import crypto from 'crypto'
import type { SupabaseClient } from '@supabase/supabase-js'
import { audienceOf, tokenAllowedAt, type OAuthAudience } from './audience'

/**
 * OAuth 2.1 authorization-server primitives for the MCP endpoint.
 *
 * Every credential here — client secrets, authorization codes, access tokens,
 * refresh tokens — is stored as a SHA-256 hash and never in plaintext, the same
 * posture as `fund_api_keys.key_hash`. Unsalted SHA-256 is the right choice for
 * these and NOT for passwords: each value is 32 bytes of CSPRNG output, so there
 * is no dictionary to attack, and lookup has to be deterministic.
 */

const ACCESS_TTL_MS  = 60 * 60 * 1000            // 1 hour
const REFRESH_TTL_MS = 30 * 24 * 60 * 60 * 1000  // 30 days
// Deliberately far shorter than the spec's 10-minute ceiling: the code travels
// only from our redirect to the client's callback, which takes milliseconds.
const CODE_TTL_MS    = 60 * 1000                 // 1 minute

export const SCOPES_SUPPORTED = ['read', 'write'] as const

export function hashToken(token: string): string {
  return crypto.createHash('sha256').update(token).digest('hex')
}

function mint(prefix: string): { token: string; hash: string } {
  const token = prefix + crypto.randomBytes(32).toString('base64url')
  return { token, hash: hashToken(token) }
}

/**
 * Normalize a requested scope string down to what we actually support, and cap it
 * at what the user is allowed to have.
 *
 * A non-admin who requests more than they can have is silently downgraded rather than refused —
 * OAuth's model is that the authorization server grants a subset and tells the client which
 * scopes it actually got. Refusing outright would just make Claude's connector look broken.
 *
 * The read-only demo can never hold a write token. Everyone else may, because THIS IS ONLY A
 * CEILING: every call re-reads the owner's live grants and checks the domain the tool touches
 * (see authorizeToolUse), so a write token held by someone with read-only grants writes nothing.
 * That per-domain check is what makes it safe to stop asking about the role here — and it's why a
 * member granted write in a domain can drive it from a connector, exactly as from the UI.
 */
export function grantableScope(
  requested: string | null | undefined,
  role: string,
  /**
   * Whether the caller's GRANTS let them write anywhere (lib/access/effective.ts:canWriteAnywhere).
   * Defaults true so callers that genuinely only know the role still behave as before.
   *
   * Without it, a member whose grants are read-only would be handed a write-scoped token and a
   * consent screen saying "this app can change your data" — while every write was then refused
   * per-domain. The refusal is correct; the promise was the bug.
   */
  canWriteAnywhere: boolean = true,
): string {
  const asked = (requested ?? 'read')
    .split(/[\s,]+/)
    .map(s => s.trim())
    .filter(s => (SCOPES_SUPPORTED as readonly string[]).includes(s))

  const wantsWrite = asked.includes('write') && role !== 'viewer' && canWriteAnywhere
  return wantsWrite ? 'read write' : 'read'
}

// ---------------------------------------------------------------------------
// Clients (RFC 7591 Dynamic Client Registration)
// ---------------------------------------------------------------------------

export interface RegisteredClient {
  client_id: string
  client_secret?: string
  client_name: string | null
  redirect_uris: string[]
  token_endpoint_auth_method: string
}

export async function registerClient(
  admin: SupabaseClient,
  params: {
    clientName?: string | null
    clientUri?: string | null
    logoUri?: string | null
    redirectUris: string[]
    tokenEndpointAuthMethod: string
    scope?: string | null
  }
): Promise<RegisteredClient> {
  const clientId = 'mcp_' + crypto.randomBytes(16).toString('base64url')

  // Public clients (Claude) hold no secret and prove themselves with PKCE. Only
  // mint a secret if the client explicitly asked to be confidential.
  const isConfidential = params.tokenEndpointAuthMethod !== 'none'
  const secret = isConfidential ? mint('mcs_') : null

  const { error } = await (admin as any).from('oauth_clients').insert({
    client_id: clientId,
    client_secret_hash: secret?.hash ?? null,
    client_name: params.clientName ?? null,
    client_uri: params.clientUri ?? null,
    logo_uri: params.logoUri ?? null,
    redirect_uris: params.redirectUris,
    token_endpoint_auth_method: params.tokenEndpointAuthMethod,
    scope: params.scope ?? 'read',
  })
  if (error) throw new Error(`Failed to register client: ${error.message}`)

  return {
    client_id: clientId,
    client_secret: secret?.token,
    client_name: params.clientName ?? null,
    redirect_uris: params.redirectUris,
    token_endpoint_auth_method: params.tokenEndpointAuthMethod,
  }
}

export interface OAuthClient {
  client_id: string
  client_secret_hash: string | null
  client_name: string | null
  redirect_uris: string[]
  token_endpoint_auth_method: string
}

export async function getClient(admin: SupabaseClient, clientId: string): Promise<OAuthClient | null> {
  const { data } = await (admin as any)
    .from('oauth_clients')
    .select('client_id, client_secret_hash, client_name, redirect_uris, token_endpoint_auth_method')
    .eq('client_id', clientId)
    .maybeSingle()
  return (data as OAuthClient) ?? null
}

/**
 * Exact-match the redirect URI against the client's registered set.
 *
 * Verbatim comparison, no prefix matching and no wildcards — a loose check here
 * is an open redirect that hands authorization codes to whoever asks.
 */
export function redirectUriAllowed(client: OAuthClient, redirectUri: string): boolean {
  return client.redirect_uris.includes(redirectUri)
}

/** Constant-time secret check for confidential clients. */
export function clientSecretValid(client: OAuthClient, presented: string | null): boolean {
  if (client.token_endpoint_auth_method === 'none') return true // public client, PKCE is the proof
  if (!client.client_secret_hash || !presented) return false

  const a = Buffer.from(hashToken(presented), 'hex')
  const b = Buffer.from(client.client_secret_hash, 'hex')
  return a.length === b.length && crypto.timingSafeEqual(a, b)
}

// ---------------------------------------------------------------------------
// Authorization codes
// ---------------------------------------------------------------------------

export async function issueAuthorizationCode(
  admin: SupabaseClient,
  params: {
    clientId: string
    userId: string
    fundId: string
    redirectUri: string
    scope: string
    codeChallenge: string
    resource?: string | null
  }
): Promise<string> {
  const code = mint('mcc_')

  const { error } = await (admin as any).from('oauth_authorization_codes').insert({
    code_hash: code.hash,
    client_id: params.clientId,
    user_id: params.userId,
    fund_id: params.fundId,
    redirect_uri: params.redirectUri,
    scope: params.scope,
    code_challenge: params.codeChallenge,
    code_challenge_method: 'S256',
    resource: params.resource ?? null,
    expires_at: new Date(Date.now() + CODE_TTL_MS).toISOString(),
  })
  if (error) throw new Error(`Failed to issue code: ${error.message}`)

  return code.token
}

export interface ConsumedCode {
  clientId: string
  userId: string
  fundId: string
  redirectUri: string
  scope: string
  codeChallenge: string
  resource: string | null
}

/**
 * Consume an authorization code, atomically.
 *
 * The single-use guarantee comes from the conditional UPDATE, not from a
 * read-then-write: `.is('consumed_at', null)` in the same statement that sets it
 * means two concurrent exchanges of the same code cannot both win — the second
 * updates zero rows and gets null back. Checking first and writing after would be
 * a race, and the prize for winning it is someone else's access token.
 */
export async function consumeAuthorizationCode(
  admin: SupabaseClient,
  code: string
): Promise<ConsumedCode | null> {
  const { data } = await (admin as any)
    .from('oauth_authorization_codes')
    .update({ consumed_at: new Date().toISOString() })
    .eq('code_hash', hashToken(code))
    .is('consumed_at', null)
    .gt('expires_at', new Date().toISOString())
    .select('client_id, user_id, fund_id, redirect_uri, scope, code_challenge, resource')
    .maybeSingle()

  if (!data) return null

  return {
    clientId: (data as any).client_id,
    userId: (data as any).user_id,
    fundId: (data as any).fund_id,
    redirectUri: (data as any).redirect_uri,
    scope: (data as any).scope,
    codeChallenge: (data as any).code_challenge,
    resource: (data as any).resource ?? null,
  }
}

/**
 * PKCE S256 verification: BASE64URL(SHA256(verifier)) must equal the challenge
 * that was registered when the code was issued.
 */
export function pkceValid(verifier: string, challenge: string): boolean {
  if (!verifier || verifier.length < 43 || verifier.length > 128) return false
  const computed = crypto.createHash('sha256').update(verifier).digest('base64url')

  const a = Buffer.from(computed)
  const b = Buffer.from(challenge)
  return a.length === b.length && crypto.timingSafeEqual(a, b)
}

// ---------------------------------------------------------------------------
// Access + refresh tokens
// ---------------------------------------------------------------------------

export interface IssuedTokens {
  accessToken: string
  refreshToken: string
  expiresIn: number
  scope: string
}

export async function issueTokens(
  admin: SupabaseClient,
  params: {
    clientId: string
    userId: string
    fundId: string
    scope: string
    resource?: string | null
  }
): Promise<IssuedTokens> {
  const access = mint('mcp_at_')
  const refresh = mint('mcp_rt_')
  const now = Date.now()

  const rows = [
    {
      token_hash: access.hash,
      kind: 'access',
      client_id: params.clientId,
      user_id: params.userId,
      fund_id: params.fundId,
      scope: params.scope,
      resource: params.resource ?? null,
      expires_at: new Date(now + ACCESS_TTL_MS).toISOString(),
    },
    {
      token_hash: refresh.hash,
      kind: 'refresh',
      client_id: params.clientId,
      user_id: params.userId,
      fund_id: params.fundId,
      scope: params.scope,
      resource: params.resource ?? null,
      expires_at: new Date(now + REFRESH_TTL_MS).toISOString(),
    },
  ]

  const { error } = await (admin as any).from('oauth_tokens').insert(rows)
  if (error) throw new Error(`Failed to issue tokens: ${error.message}`)

  return {
    accessToken: access.token,
    refreshToken: refresh.token,
    expiresIn: Math.floor(ACCESS_TTL_MS / 1000),
    scope: params.scope,
  }
}

export interface ResolvedAccessToken {
  userId: string
  fundId: string
  clientId: string
  scope: string
  /** RFC 8707: the boundary this token was issued for. Null when the client claimed none. */
  resource: string | null
}

/**
 * Verify an access token presented at a protected boundary. Returns null for anything
 * unusable — unknown, expired, revoked, or issued for a DIFFERENT boundary — so the caller
 * emits one undifferentiated 401 and a prober learns nothing from the difference.
 *
 * `audience` is the boundary doing the asking (SEC-009). Omitting it keeps the old behaviour of
 * accepting any token, which is why it is a required decision at each call site rather than a
 * default: see lib/oauth/audience.ts.
 */
export async function resolveAccessToken(
  admin: SupabaseClient,
  token: string,
  audience?: OAuthAudience
): Promise<ResolvedAccessToken | null> {
  const { data } = await (admin as any)
    .from('oauth_tokens')
    .select('user_id, fund_id, client_id, scope, resource, expires_at, revoked_at')
    .eq('token_hash', hashToken(token))
    .eq('kind', 'access')
    .maybeSingle()

  if (!data) return null
  if ((data as any).revoked_at) return null
  if (new Date((data as any).expires_at).getTime() < Date.now()) return null

  const resource = (data as any).resource ?? null
  if (audience && !tokenAllowedAt(resource, audience)) return null

  return {
    userId: (data as any).user_id,
    fundId: (data as any).fund_id,
    clientId: (data as any).client_id,
    scope: (data as any).scope ?? 'read',
    resource,
  }
}

/**
 * Rotate a refresh token: revoke the presented one, mint a fresh pair.
 *
 * REPLAY DETECTION. If the presented refresh token exists but is already revoked,
 * it was rotated earlier and has now been presented a second time — which means
 * it leaked. The honest holder and the attacker are indistinguishable at this
 * point, so we revoke every live token for that (client, user) pair and force a
 * re-authorization. Silently issuing a new pair would hand the attacker a durable
 * foothold; this is the standard OAuth 2.1 refresh-reuse response.
 */
export async function rotateRefreshToken(
  admin: SupabaseClient,
  params: { clientId: string; refreshToken: string }
): Promise<IssuedTokens | null> {
  const hash = hashToken(params.refreshToken)

  const { data: existing } = await (admin as any)
    .from('oauth_tokens')
    .select('id, user_id, fund_id, client_id, scope, resource, expires_at, revoked_at')
    .eq('token_hash', hash)
    .eq('kind', 'refresh')
    .maybeSingle()

  if (!existing) return null

  const row = existing as any

  // The token must belong to the client presenting it.
  if (row.client_id !== params.clientId) return null

  if (row.revoked_at) {
    await revokeAllForClient(admin, row.client_id, row.user_id)
    return null
  }

  if (new Date(row.expires_at).getTime() < Date.now()) return null

  // Claim the token BEFORE minting, conditionally on it still being live. Two requests presenting
  // the same refresh token at once both pass the revoked_at read above; without this only-if-live
  // update both would get a fresh pair and the replay below would never be detected.
  const now = new Date().toISOString()
  const { data: claimed } = await (admin as any)
    .from('oauth_tokens')
    .update({ revoked_at: now, last_used_at: now })
    .eq('id', row.id)
    .is('revoked_at', null)
    .select('id')
    .maybeSingle()
  if (!claimed) {
    await revokeAllForClient(admin, row.client_id, row.user_id)
    return null
  }

  // An investor connector token: the holder is an LP, not a fund member, so the check is theirs —
  // still an active LP investing in this fund, and the fund's connector still on. The scope is the
  // investor's own (read, or read and act), carried forward as it was granted.
  if (audienceOf(row.resource) === 'portal') {
    const { connectorPrincipal, lpConnectorEnabled } = await import('@/lib/portal/principal')
    const stillAllowed = (await lpConnectorEnabled(admin, row.fund_id)) && !!(await connectorPrincipal(admin, row.user_id, row.fund_id))
    if (!stillAllowed) {
      await revokeAllForClient(admin, row.client_id, row.user_id)
      return null
    }
    return issueTokens(admin, { clientId: row.client_id, userId: row.user_id, fundId: row.fund_id, scope: row.scope, resource: row.resource })
  }

  // The user may have been demoted or removed from the fund since the token was
  // issued. Re-derive the scope ceiling from their CURRENT role rather than
  // carrying the old grant forward — a refresh must never launder a stale
  // privilege into a fresh hour of access.
  const { data: membership } = await admin
    .from('fund_members')
    .select('role')
    .eq('fund_id', row.fund_id)
    .eq('user_id', row.user_id)
    .maybeSingle()

  if (!membership) {
    await revokeAllForClient(admin, row.client_id, row.user_id)
    return null
  }

  const scope = grantableScope(row.scope, (membership as { role: string }).role)

  const issued = await issueTokens(admin, {
    clientId: row.client_id,
    userId: row.user_id,
    fundId: row.fund_id,
    scope,
    resource: row.resource,
  })

  return issued
}

async function revokeAllForClient(
  admin: SupabaseClient,
  clientId: string,
  userId: string
): Promise<void> {
  await (admin as any)
    .from('oauth_tokens')
    .update({ revoked_at: new Date().toISOString() })
    .eq('client_id', clientId)
    .eq('user_id', userId)
    .is('revoked_at', null)
}
