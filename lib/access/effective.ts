// The one resolver. Every surface that can serve fund data — API routes, the nav, the Analyst, the
// MCP server, API keys — answers "may this user touch this?" through `effectiveAccess`, so that
// "can see it" and "can access it" are the same function rather than two that drift.
//
// See plans/plan-access-control.md.

import type { SupabaseClient } from '@supabase/supabase-js'
import { DOMAIN_META, DOMAINS, type Domain } from './domains'
import { vehicleScopeFromRow, type VehicleScope } from './scope'
import {
  DEFAULT_FEATURE_VISIBILITY,
  type FeatureKey,
  type FeatureVisibilityMap,
} from '@/lib/types/features'

export type AccessLevel = 'none' | 'read' | 'write'

const RANK: Record<AccessLevel, number> = { none: 0, read: 1, write: 2 }

export type FundRole = 'admin' | 'member' | 'viewer'

/** Everything the resolver needs, loaded once per request. */
export interface AccessContext {
  fundId: string
  userId: string
  role: FundRole
  /** The fund-level switches. */
  features: FeatureVisibilityMap
  /** This user's explicit per-domain grants. */
  grants: Partial<Record<Domain, AccessLevel>>
  /** The fund's per-domain default for members without an explicit grant. */
  defaults: Partial<Record<Domain, AccessLevel>>
  /** Which of the fund's entities this user may see — the second axis. See lib/access/scope.ts. */
  vehicles: VehicleScope
}

/**
 * What this user may do in this domain.
 *
 * `feature` overrides the domain's primary switch — pass the route's own feature key when its
 * domain spans several (e.g. `relationships` covers both `interactions` and `notes`, and a fund
 * can switch those independently).
 *
 * The order of these checks is the policy. Read it as: the fund-level switch is a ceiling nobody
 * clears, admins get everything that's switched on, and a member's grant can only ever narrow
 * what the fund already allows.
 */
export function effectiveAccess(ctx: AccessContext, domain: Domain, feature?: FeatureKey): AccessLevel {
  const meta = DOMAIN_META[domain]
  const key = feature ?? meta.primaryFeature
  const level = key ? (ctx.features?.[key] ?? DEFAULT_FEATURE_VISIBILITY[key]) : 'everyone'

  // Switched off or hidden: nobody, admins included, and no implication can revive it. This is the
  // gap being closed — hiding something from the nav while its API still serves it is not access
  // control.
  if (level === 'off' || level === 'hidden') return 'none'

  if (meta.adminOnly) return ctx.role === 'admin' ? 'write' : 'none'
  if (ctx.role === 'admin') return 'write'

  // The read-only demo reads everything switched on — including admin-level areas, which is how
  // the demo fund shows off admin pages (it mirrors the old assertReadAccess: admin|viewer pass,
  // plain member does not). Grants never widen it past read.
  if (ctx.role === 'viewer') return 'read'

  // What the fund's own switch allows this member, before any implication.
  const own = level === 'admin' ? 'none' : (ctx.grants[domain] ?? ctx.defaults[domain] ?? 'none')

  // …and what another domain confers on this one. Only lp_capital has this, and only from
  // accounting: the partner capital accounts ARE the ledger, so granting the books grants
  // partners. See DOMAIN_META.lp_capital.impliedBy for why this is stated rather than pretended.
  //
  // Deliberately AFTER the off/hidden check above, so a hard deny on THIS domain still wins, and
  // deliberately not recursive beyond one hop — `accounting` implies nothing, so this terminates.
  if (!meta.impliedBy) return own
  const implied = effectiveAccess(ctx, meta.impliedBy)
  return RANK[implied] > RANK[own] ? implied : own
}

/** Does this user clear `need` in this domain? The form every gate should use. */
export function hasAccess(
  ctx: AccessContext,
  domain: Domain,
  need: 'read' | 'write',
  feature?: FeatureKey,
): boolean {
  return RANK[effectiveAccess(ctx, domain, feature)] >= RANK[need]
}

/** Every domain this user can at least read — for the nav and for filtering the MCP tool list. */
export function readableDomains(ctx: AccessContext): Domain[] {
  return DOMAINS.filter(d => hasAccess(ctx, d, 'read'))
}

/**
 * Can this user change anything at all, anywhere?
 *
 * For the OAuth consent screen. Scope is global ('read' / 'read write') while grants are
 * per-domain, so the honest cap on a token is "may they write SOMEWHERE" — a user with write in
 * one domain legitimately needs a write-scoped token; a user with write in none must never be
 * offered one, or the consent screen promises an access their grants then refuse.
 */
export function canWriteAnywhere(ctx: AccessContext): boolean {
  return DOMAINS.some(d => hasAccess(ctx, d, 'write'))
}

/**
 * Every domain's level, resolved. Handed to the client so components can decide what to render
 * without a round trip — see components/access-context.tsx. Affordances only; the middleware
 * re-resolves this live for every API call.
 */
export function accessMap(ctx: AccessContext): Record<Domain, AccessLevel> {
  return Object.fromEntries(DOMAINS.map(d => [d, effectiveAccess(ctx, d)])) as Record<Domain, AccessLevel>
}

/** Build the context from parts the caller already has, without re-reading the database. */
export function accessContextFrom(args: {
  fundId: string
  userId: string
  role: string | null | undefined
  features: FeatureVisibilityMap
  grants: { domain: string; level: string }[]
  defaults: { domain: string; level: string }[]
  /** Required: a context built without saying which entities it may see would have to guess. */
  vehicles: VehicleScope
}): AccessContext {
  return {
    fundId: args.fundId,
    userId: args.userId,
    role: normalizeRole(args.role),
    features: args.features,
    grants: levelMap(args.grants),
    defaults: levelMap(args.defaults),
    vehicles: args.role === 'admin' ? { ...args.vehicles, all: true } : args.vehicles,
  }
}

/** What the `access_context` RPC returns. */
interface AccessContextRow {
  fund_id: string
  role: string
  features: Partial<FeatureVisibilityMap> | null
  grants: Record<string, string> | null
  defaults: Record<string, string> | null
  /** Absent before 20261007100000_entity_access_grants.sql — see vehicleScopeFromRow. */
  vehicles?: unknown
}

/**
 * Everything the resolver needs, in ONE round trip (`access_context`, migration 20260716000009).
 *
 * This runs in middleware on every /api request, so its cost is the app's cost. Built from the
 * client it was four PostgREST calls across two sequential round trips — grants and defaults need
 * the fund_id membership returns. The RPC does the join server-side.
 *
 * Resolve once per request and thread the result; don't call this per check.
 */
export async function loadAccessContext(
  admin: SupabaseClient,
  fundId: string,
  userId: string,
  role: string,
): Promise<AccessContext> {
  const { data } = await admin.rpc('access_context' as never, { p_user_id: userId } as never)
  const row = (data ?? null) as AccessContextRow | null

  return {
    fundId,
    userId,
    // Prefer what the caller already established; fall back to the RPC.
    role: normalizeRole(role ?? row?.role),
    features: { ...DEFAULT_FEATURE_VISIBILITY, ...(row?.features ?? {}) },
    grants: recordToLevels(row?.grants),
    defaults: recordToLevels(row?.defaults),
    // No row at all (not a member): nothing. A row without the key: the RPC predates entity access.
    vehicles: row ? vehicleScopeFromRow(normalizeRole(role ?? row.role), row.vehicles) : { all: false, ids: [] },
  }
}

/**
 * Resolve a caller from their session alone — fund, role and access in one call, no membership
 * lookup first. For the middleware, which starts with nothing but a user id.
 *
 * Returns null when they belong to no fund: an LP-portal-only user, or a pending join request.
 */
export async function resolveAccessContext(
  client: SupabaseClient,
  userId: string,
): Promise<AccessContext | null> {
  const { data } = await client.rpc('access_context' as never, {} as never)
  const row = (data ?? null) as AccessContextRow | null
  if (!row?.fund_id) return null

  return {
    fundId: row.fund_id,
    userId,
    role: normalizeRole(row.role),
    features: { ...DEFAULT_FEATURE_VISIBILITY, ...(row.features ?? {}) },
    grants: recordToLevels(row.grants),
    defaults: recordToLevels(row.defaults),
    vehicles: vehicleScopeFromRow(normalizeRole(row.role), row.vehicles),
  }
}

/** `fund_members.role` is unconstrained text; anything unrecognised is treated as the least power. */
export function normalizeRole(role: string | null | undefined): FundRole {
  return role === 'admin' || role === 'viewer' || role === 'member' ? role : 'member'
}

/** `{accounting: 'read'}` from the RPC → a typed map, dropping anything unrecognised. */
function recordToLevels(rec: Record<string, string> | null | undefined): Partial<Record<Domain, AccessLevel>> {
  return levelMap(Object.entries(rec ?? {}).map(([domain, level]) => ({ domain, level })))
}

function levelMap(rows: { domain: string; level: string }[] | null): Partial<Record<Domain, AccessLevel>> {
  const out: Partial<Record<Domain, AccessLevel>> = {}
  for (const r of rows ?? []) {
    if (DOMAINS.includes(r.domain as Domain) && r.level in RANK) {
      out[r.domain as Domain] = r.level as AccessLevel
    }
  }
  return out
}
