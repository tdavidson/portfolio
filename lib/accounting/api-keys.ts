// Fund API-key generation and verification for agent access. Only the SHA-256
// hash is stored; the plaintext token (shown once) is what an agent presents as
// a Bearer token to the ledger API / MCP endpoint.

import crypto from 'crypto'
import type { SupabaseClient } from '@supabase/supabase-js'
import { hasAccess, loadAccessContext, type AccessContext } from '@/lib/access/effective'
import { DOMAIN_META, type Domain } from '@/lib/access/domains'
import type { FeatureKey } from '@/lib/types/features'

const PREFIX = 'lk_' // "ledger key"

export interface GeneratedKey {
  token: string   // full plaintext, shown once
  prefix: string  // stored for display
  hash: string    // stored (sha256 hex)
}

/** Mint a new key: 32 random bytes, base64url. Returns token + what to store. */
export function generateApiKey(): GeneratedKey {
  const token = PREFIX + crypto.randomBytes(32).toString('base64url')
  return { token, prefix: token.slice(0, 11), hash: hashApiKey(token) }
}

export function hashApiKey(token: string): string {
  return crypto.createHash('sha256').update(token).digest('hex')
}

/** Extract a Bearer token from a request's Authorization header (or null). */
export function bearerToken(req: Request): string | null {
  const auth = req.headers.get('authorization') ?? req.headers.get('Authorization')
  if (!auth) return null
  const m = auth.match(/^Bearer\s+(.+)$/i)
  return m ? m[1].trim() : null
}

export interface ResolvedKey {
  fundId: string
  keyId: string
  userId: string
  /** The owning member's CURRENT role in the fund (re-checked each call). */
  role: string
  scopes: string[]
  /**
   * Set only for an OAuth connection whose owner is in MASTER_ADMIN_EMAILS (lib/agent/master-admin.ts).
   * When it is, `fundId`/`userId`/`role` above are the ACTIVE pool fund's, not necessarily the
   * fund the connection was authorized for.
   */
  pool?: import('@/lib/agent/master-admin').MasterAdminPool
}

/**
 * Resolve a fund + owner from a Bearer API key. Verifies the hash against a
 * non-revoked key, re-checks the owner is still a fund member (so a removed or
 * demoted user's key loses access immediately), stamps last_used_at, and returns
 * the fund, owner, current role, and scopes — or null if invalid.
 */
export async function resolveFundFromApiKey(admin: SupabaseClient, req: Request): Promise<ResolvedKey | null> {
  const token = bearerToken(req)
  if (!token) return null
  const hash = hashApiKey(token)

  const { data } = await admin
    .from('fund_api_keys' as any)
    .select('id, fund_id, user_id, scopes, revoked_at')
    .eq('key_hash', hash)
    .maybeSingle()

  const row = data as any
  if (!row || row.revoked_at) return null

  // The key acts as its owner: resolve the owner's CURRENT role (membership may
  // have changed since the key was minted). No membership → no access.
  const { data: membership } = await admin
    .from('fund_members')
    .select('role')
    .eq('fund_id', row.fund_id)
    .eq('user_id', row.user_id)
    .maybeSingle()
  if (!membership) return null

  // Best-effort usage stamp; ignore failures.
  await admin.from('fund_api_keys' as any).update({ last_used_at: new Date().toISOString() }).eq('id', row.id)

  return {
    fundId: row.fund_id,
    keyId: row.id,
    userId: row.user_id,
    role: (membership as { role: string }).role,
    scopes: String(row.scopes ?? 'read').split(',').map(s => s.trim()),
  }
}

/**
 * Resolve a Bearer credential of EITHER kind:
 *
 *   lk_…      a static fund API key  — what CLI/headless clients use.
 *   mcp_at_…  an OAuth access token  — what the claude.ai connector obtains.
 *
 * Both collapse to the same {@link ResolvedKey}, so every downstream check —
 * fund scoping, authorizeToolUse, rate limiting — is identical regardless of how
 * the caller authenticated. That is the point: OAuth is a second front door, not
 * a second security model.
 *
 * As with static keys, the owner's role is re-read live from `fund_members` on
 * every call, so demoting or removing someone instantly downgrades every token
 * they hold without anyone having to hunt those tokens down.
 */
export async function resolveAgentAuth(admin: SupabaseClient, req: Request): Promise<ResolvedKey | null> {
  const token = bearerToken(req)
  if (!token) return null

  if (token.startsWith('mcp_at_')) {
    // Imported lazily so the REST agent route, which has no OAuth surface, doesn't
    // pull the OAuth store into its bundle.
    const { resolveAccessToken } = await import('@/lib/oauth/store')
    // SEC-009: 'mcp' is the boundary this resolver serves, and it is the resource the discovery
    // document advertises. A token minted for /api/v1 does not open the agent tools.
    const resolved = await resolveAccessToken(admin, token, 'mcp')
    if (!resolved) return null

    const { data: membership } = await admin
      .from('fund_members')
      .select('role')
      .eq('fund_id', resolved.fundId)
      .eq('user_id', resolved.userId)
      .maybeSingle()
    if (!membership) return null

    const home: ResolvedKey = {
      fundId: resolved.fundId,
      // Not a fund_api_keys row — surfaced this way so audit/rate-limit call sites
      // can still name the credential without pretending it's a static key.
      keyId: `oauth:${resolved.clientId}`,
      userId: resolved.userId,
      role: (membership as { role: string }).role,
      // OAuth scope strings are space-delimited ('read write'); API-key scopes are
      // comma-delimited. Normalize on the way in so authorizeToolUse sees one shape.
      scopes: resolved.scope.split(/[\s,]+/).map(s => s.trim()).filter(Boolean),
    }

    // Master admin: the connection may be working in another pooled fund. There it acts as that
    // fund's listed admin, with that membership's role re-read live like any other.
    const { loadPool } = await import('@/lib/agent/master-admin')
    const pool = await loadPool(admin, { userId: resolved.userId, fundId: resolved.fundId, clientId: resolved.clientId })
    if (!pool) return home
    if (pool.activeFundId === resolved.fundId) return { ...home, pool }

    const target = pool.funds.find(f => f.fundId === pool.activeFundId)!
    const { data: targetMembership } = await admin
      .from('fund_members')
      .select('role')
      .eq('fund_id', target.fundId)
      .eq('user_id', target.userId)
      .maybeSingle()
    if (!targetMembership) return { ...home, pool: { ...pool, activeFundId: resolved.fundId } }
    return {
      ...home,
      fundId: target.fundId,
      userId: target.userId,
      role: (targetMembership as { role: string }).role,
      pool,
    }
  }

  return resolveFundFromApiKey(admin, req)
}

/**
 * Authorization for a tool call: the credential's scope, AND the owner's grant in the domain the
 * tool touches. Returns null if allowed, or an error message.
 *
 * A CREDENTIAL CAN NEVER EXCEED ITS OWNER. Both halves are re-read live on every call — the
 * owner's role and grants come from the database, not from the token — so demoting someone, or
 * revoking their GP-economics grant, instantly narrows every key and token they hold without
 * anyone hunting those tokens down. The scope string is a ceiling the owner chose at mint time;
 * the grants are the ceiling the admin chose. The lower one wins.
 *
 * This used to be the ENTIRE authorization for MCP and the REST agent: "is this a write, and is
 * the owner an admin". Any read credential from any member read the whole fund — LP capital,
 * diligence memos, carry — because nothing narrower existed.
 */
export async function loadCredentialAccess(admin: SupabaseClient, auth: ResolvedKey): Promise<AccessContext> {
  return loadAccessContext(admin, auth.fundId, auth.userId, auth.role)
}

export function authorizeToolUse(
  scope: 'read' | 'write',
  auth: ResolvedKey,
  access: AccessContext,
  domain: Domain,
  feature?: FeatureKey,
): string | null {
  if (scope === 'write' && !auth.scopes.includes('write')) return 'This credential is read-only.'

  // `feature` matters for domains that span several switches: without it the ceiling reads as
  // wide open, so a fund that HID a feature would still serve it over MCP — even to an admin.
  if (!hasAccess(access, domain, scope, feature)) {
    const label = DOMAIN_META[domain].label
    return scope === 'write'
      ? `This credential's owner does not have write access to ${label}.`
      : `This credential's owner does not have access to ${label}.`
  }
  return null
}
