import { createHash, randomBytes } from 'crypto'

/**
 * The OAuth client side of the MCP authorization spec, for hosted MCP servers that sign people in
 * rather than issue API keys.
 *
 *   1. discover  — the server's protected-resource metadata names its authorization server, whose
 *                  metadata names the authorize, token and registration endpoints.
 *   2. register  — dynamic client registration (RFC 7591). Each connection registers its own
 *                  public client with this deployment's callback URL, so no client id has to be
 *                  configured per install.
 *   3. authorize — authorization code with PKCE (S256), and the MCP URL as the `resource`
 *                  (RFC 8707) so the token is minted for that server only.
 *   4. exchange / refresh at the token endpoint.
 *
 * Every function takes `fetchImpl` so the tests can run the whole flow without a network.
 */

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>

export interface AuthServerMetadata {
  issuer?: string
  authorization_endpoint: string
  token_endpoint: string
  registration_endpoint?: string
  scopes_supported?: string[]
  code_challenge_methods_supported?: string[]
}

export interface DiscoveredAuth {
  /** The MCP URL, sent as `resource` on authorize, token and refresh requests. */
  resource: string
  authorizationEndpoint: string
  tokenEndpoint: string
  registrationEndpoint: string | null
  /** What to ask for, or null to let the server decide. */
  scope: string | null
}

export interface RegisteredClient {
  clientId: string
  clientSecret: string | null
}

export interface TokenSet {
  accessToken: string
  refreshToken: string | null
  /** Epoch ms, or null when the server didn't say. */
  expiresAt: number | null
  scope: string | null
}

export class McpOAuthError extends Error {
  constructor(public readonly code: string, message: string) {
    super(message)
    this.name = 'McpOAuthError'
  }
}

const TIMEOUT_MS = 10_000

/** Endpoints must be https, except on localhost for development. */
export function isAllowedEndpoint(raw: unknown): raw is string {
  if (typeof raw !== 'string') return false
  try {
    const u = new URL(raw)
    if (u.protocol === 'https:') return true
    return u.protocol === 'http:' && /^(localhost|127\.0\.0\.1|\[::1\])$/.test(u.hostname)
  } catch {
    return false
  }
}

async function getJson(fetchImpl: FetchLike, url: string): Promise<Record<string, unknown> | null> {
  try {
    const res = await fetchImpl(url, {
      headers: { Accept: 'application/json', 'MCP-Protocol-Version': '2025-06-18' },
      signal: AbortSignal.timeout(TIMEOUT_MS),
      redirect: 'error',
    })
    if (!res.ok) return null
    const body = await res.json().catch(() => null)
    return body && typeof body === 'object' ? body as Record<string, unknown> : null
  } catch {
    return null
  }
}

/** RFC 9728 well-known locations for a resource, path-specific first. */
export function protectedResourceMetadataUrls(resource: string): string[] {
  const u = new URL(resource)
  const path = u.pathname.replace(/\/$/, '')
  const urls = [`${u.origin}/.well-known/oauth-protected-resource${path}`]
  if (path) urls.push(`${u.origin}/.well-known/oauth-protected-resource`)
  return urls
}

/** RFC 8414 and OpenID discovery locations for an issuer, in the order the MCP spec gives. */
export function authServerMetadataUrls(issuer: string): string[] {
  const u = new URL(issuer)
  const path = u.pathname.replace(/\/$/, '')
  if (!path) {
    return [
      `${u.origin}/.well-known/oauth-authorization-server`,
      `${u.origin}/.well-known/openid-configuration`,
    ]
  }
  return [
    `${u.origin}/.well-known/oauth-authorization-server${path}`,
    `${u.origin}/.well-known/openid-configuration${path}`,
    `${u.origin}${path}/.well-known/openid-configuration`,
  ]
}

export async function discoverAuth(resource: string, fetchImpl: FetchLike = fetch): Promise<DiscoveredAuth> {
  // 1. Which authorization server guards this resource. A server without the metadata is taken to
  //    be its own authorization server, as the spec's fallback says.
  let issuer = new URL(resource).origin
  let resourceScopes: string[] | null = null
  for (const url of protectedResourceMetadataUrls(resource)) {
    const prm = await getJson(fetchImpl, url)
    if (!prm) continue
    const servers = Array.isArray(prm.authorization_servers) ? prm.authorization_servers : []
    if (isAllowedEndpoint(servers[0])) issuer = servers[0]
    if (Array.isArray(prm.scopes_supported)) resourceScopes = prm.scopes_supported.filter((s): s is string => typeof s === 'string')
    break
  }

  // 2. That server's endpoints.
  let meta: AuthServerMetadata | null = null
  for (const url of authServerMetadataUrls(issuer)) {
    const body = await getJson(fetchImpl, url)
    if (body && isAllowedEndpoint(body.authorization_endpoint) && isAllowedEndpoint(body.token_endpoint)) {
      meta = body as unknown as AuthServerMetadata
      break
    }
  }
  if (!meta) throw new McpOAuthError('discovery_failed', 'Could not find the sign-in server for this connector.')

  const methods = meta.code_challenge_methods_supported
  if (Array.isArray(methods) && methods.length > 0 && !methods.includes('S256')) {
    throw new McpOAuthError('pkce_unsupported', 'The sign-in server does not support PKCE.')
  }

  // Ask for the resource's own scopes when it lists them, plus offline_access when the server
  // offers it, so the token can be refreshed instead of asking the member to sign in hourly.
  const scopes = new Set(resourceScopes ?? [])
  if (meta.scopes_supported?.includes('offline_access')) scopes.add('offline_access')

  return {
    resource,
    authorizationEndpoint: meta.authorization_endpoint,
    tokenEndpoint: meta.token_endpoint,
    registrationEndpoint: isAllowedEndpoint(meta.registration_endpoint) ? meta.registration_endpoint : null,
    scope: scopes.size > 0 ? [...scopes].join(' ') : null,
  }
}

export async function registerClient(
  auth: DiscoveredAuth,
  input: { redirectUri: string; clientName: string },
  fetchImpl: FetchLike = fetch,
): Promise<RegisteredClient> {
  if (!auth.registrationEndpoint) {
    throw new McpOAuthError('registration_unsupported', 'This connector does not let apps register for sign-in.')
  }
  let res: Response
  try {
    res = await fetchImpl(auth.registrationEndpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({
        client_name: input.clientName,
        redirect_uris: [input.redirectUri],
        grant_types: ['authorization_code', 'refresh_token'],
        response_types: ['code'],
        token_endpoint_auth_method: 'none',
        ...(auth.scope ? { scope: auth.scope } : {}),
      }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
      redirect: 'error',
    })
  } catch {
    throw new McpOAuthError('registration_failed', 'Could not reach the sign-in server.')
  }
  const body = await res.json().catch(() => null) as Record<string, unknown> | null
  if (!res.ok || !body || typeof body.client_id !== 'string') {
    throw new McpOAuthError('registration_failed', 'The sign-in server refused to register this app.')
  }
  return {
    clientId: body.client_id,
    clientSecret: typeof body.client_secret === 'string' ? body.client_secret : null,
  }
}

export interface PkcePair {
  verifier: string
  challenge: string
}

export function createPkce(): PkcePair {
  const verifier = randomBytes(32).toString('base64url')
  return { verifier, challenge: createHash('sha256').update(verifier).digest('base64url') }
}

export function buildAuthorizationUrl(input: {
  auth: DiscoveredAuth
  client: RegisteredClient
  redirectUri: string
  state: string
  codeChallenge: string
}): string {
  const url = new URL(input.auth.authorizationEndpoint)
  url.searchParams.set('response_type', 'code')
  url.searchParams.set('client_id', input.client.clientId)
  url.searchParams.set('redirect_uri', input.redirectUri)
  url.searchParams.set('state', input.state)
  url.searchParams.set('code_challenge', input.codeChallenge)
  url.searchParams.set('code_challenge_method', 'S256')
  url.searchParams.set('resource', input.auth.resource)
  if (input.auth.scope) url.searchParams.set('scope', input.auth.scope)
  return url.toString()
}

async function tokenRequest(
  tokenEndpoint: string,
  client: RegisteredClient,
  params: Record<string, string>,
  fetchImpl: FetchLike,
  now: number,
): Promise<TokenSet> {
  const body = new URLSearchParams({ ...params, client_id: client.clientId })
  if (client.clientSecret) body.set('client_secret', client.clientSecret)
  let res: Response
  try {
    res = await fetchImpl(tokenEndpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
      body: body.toString(),
      signal: AbortSignal.timeout(TIMEOUT_MS),
      redirect: 'error',
    })
  } catch {
    throw new McpOAuthError('token_unreachable', 'Could not reach the sign-in server.')
  }
  const json = await res.json().catch(() => null) as Record<string, unknown> | null
  if (!res.ok || !json || typeof json.access_token !== 'string') {
    const code = json && typeof json.error === 'string' ? json.error : 'token_failed'
    throw new McpOAuthError(code, 'The sign-in server did not issue a token.')
  }
  const expiresIn = typeof json.expires_in === 'number' ? json.expires_in : Number(json.expires_in)
  return {
    accessToken: json.access_token,
    refreshToken: typeof json.refresh_token === 'string' ? json.refresh_token : null,
    expiresAt: Number.isFinite(expiresIn) && expiresIn > 0 ? now + expiresIn * 1000 : null,
    scope: typeof json.scope === 'string' ? json.scope : null,
  }
}

export function exchangeCode(input: {
  tokenEndpoint: string
  client: RegisteredClient
  code: string
  codeVerifier: string
  redirectUri: string
  resource: string
  fetchImpl?: FetchLike
  now?: number
}): Promise<TokenSet> {
  return tokenRequest(input.tokenEndpoint, input.client, {
    grant_type: 'authorization_code',
    code: input.code,
    code_verifier: input.codeVerifier,
    redirect_uri: input.redirectUri,
    resource: input.resource,
  }, input.fetchImpl ?? fetch, input.now ?? Date.now())
}

export async function refreshTokens(input: {
  tokenEndpoint: string
  client: RegisteredClient
  refreshToken: string
  resource: string
  fetchImpl?: FetchLike
  now?: number
}): Promise<TokenSet> {
  const tokens = await tokenRequest(input.tokenEndpoint, input.client, {
    grant_type: 'refresh_token',
    refresh_token: input.refreshToken,
    resource: input.resource,
  }, input.fetchImpl ?? fetch, input.now ?? Date.now())
  // A server that doesn't rotate refresh tokens leaves the old one valid.
  return { ...tokens, refreshToken: tokens.refreshToken ?? input.refreshToken }
}
