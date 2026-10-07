// Entity scope: which of the fund's entities (fund_vehicles) this caller may see.
//
// Access has two axes. Domains (effective.ts) say WHAT kind of data — portfolio, accounting, LP
// capital. Entities say WHOSE — Fund I, Fund II, the management company. A member sees a domain's
// data only for the entities they are granted (fund_member_vehicles); an admin sees every entity.
//
// Resolved by the same `access_context` RPC as the domains, so one round trip answers both. The
// SQL mirror for RLS is `public.vehicle_ids_readable()` (20261007100000_entity_access_grants.sql).
// See plans/spec-entity-access-and-portfolio.md.

import type { AccessContext, FundRole } from './effective'

/** The caller's visible entities. `all` = no filter (admin, or the RPC predates entity access). */
export interface VehicleScope {
  all: boolean
  /** fund_vehicles ids. For `all`, whatever the RPC listed — informational, never a filter. */
  ids: string[]
  /**
   * The entity-access migration has run (the RPC returned `vehicles`). Before it, the new columns
   * (inbound_deals.vehicle_id) do not exist yet, so a read that names them would fail. Optional so a
   * hand-built context (tests, the client) need not say; absent means "not known to be enforced".
   */
  enforced?: boolean
}

/**
 * Read `access_context`'s `vehicles` into a scope.
 *
 * A row WITHOUT the key means the RPC predates 20261007100000: everything, exactly as before entity
 * access existed. That is what lets this code deploy before the migration is pushed. Once it is
 * pushed the key is always present, and an empty list means what it says.
 */
export function vehicleScopeFromRow(role: FundRole, vehicles: unknown, vehiclesAll?: unknown): VehicleScope {
  const ids = Array.isArray(vehicles) ? vehicles.filter((v): v is string => typeof v === 'string') : []
  const enforced = vehicles !== undefined
  // An admin, or a member granted every entity (`vehicles_all`): unscoped, so granting everything —
  // as the rollout backfill does — changes nothing for them.
  if (role === 'admin' || !enforced || vehiclesAll === true) return { all: true, ids, enforced }
  return { all: false, ids, enforced }
}

/**
 * May this caller see this entity? `null` is a legacy entity known only by a `portfolio_group`
 * string with no fund_vehicles row: it cannot be granted, so only a caller who sees everything
 * sees it.
 */
export function canSeeVehicle(access: Pick<AccessContext, 'vehicles'>, vehicleId: string | null): boolean {
  if (access.vehicles.all) return true
  return vehicleId != null && access.vehicles.ids.includes(vehicleId)
}

/** The ids to filter on, or null for no filter. An empty array means "sees nothing". */
export function visibleVehicleIds(access: Pick<AccessContext, 'vehicles'>): string[] | null {
  return access.vehicles.all ? null : access.vehicles.ids
}

/**
 * The companies this caller may see: those linked (company_vehicles) to one of their entities. Null
 * means no filter — a caller who sees every entity also sees unassigned companies. Read with the
 * service role, so it filters on the caller's ids itself.
 */
export async function visibleCompanyIds(
  admin: import('@supabase/supabase-js').SupabaseClient,
  access: Pick<AccessContext, 'fundId' | 'vehicles'>,
): Promise<string[] | null> {
  const ids = visibleVehicleIds(access)
  if (ids === null) return null
  if (ids.length === 0) return []
  const { data } = await (admin as any).from('company_vehicles').select('company_id')
    .eq('fund_id', access.fundId).in('vehicle_id', ids)
  return Array.from(new Set(((data as any[]) ?? []).map(r => r.company_id as string)))
}

/**
 * A company's transactions as this caller may see them: rows in their entities, plus company-wide
 * price signals (no `portfolio_group`), which belong to the company rather than to any fund.
 * `visibleNames` null = every entity.
 */
export function scopeTransactions<T extends { portfolio_group?: string | null }>(rows: T[], visibleNames: string[] | null): T[] {
  if (visibleNames === null) return rows
  return rows.filter(r => r.portfolio_group == null || visibleNames.includes(r.portfolio_group))
}

/** A company's entity names as this caller may see them. `visibleNames` null = every entity. */
export function scopeGroups(groups: string[] | null | undefined, visibleNames: string[] | null): string[] {
  if (visibleNames === null) return groups ?? []
  return (groups ?? []).filter(g => visibleNames.includes(g))
}

/**
 * Why this caller may not record a row against `group`, or null when they may. A member writes only
 * to their own entities — never to one they cannot see, nor to one that does not exist yet (the
 * write path would create it, and they could not see what they had made). A company-wide row (no
 * entity) re-prices every entity's position, so only a caller who sees every entity may write one.
 */
export function groupWriteDenial(visibleNames: string[] | null, group: string | null | undefined): string | null {
  if (visibleNames === null) return null
  if (!group) return 'Only someone who can see every entity can record a company-wide row. Pick one of your entities.'
  return visibleNames.includes(group) ? null : "You don't have access to that entity."
}

/**
 * A company's entity names after a member's edit. They were shown only their own entities, so the
 * ones they cannot see are kept exactly as they were — an edit can neither remove another fund's
 * holding nor add the company to a fund the member cannot see.
 */
export function mergeGroupsForWrite(
  current: string[] | null | undefined,
  requested: string[] | null | undefined,
  visibleNames: string[] | null,
): { groups: string[] } | { error: string } {
  const next = requested ?? []
  if (visibleNames === null) return { groups: next }
  if (next.some(g => !visibleNames.includes(g))) return { error: "You don't have access to that entity." }
  const hidden = (current ?? []).filter(g => !visibleNames.includes(g))
  return { groups: Array.from(new Set([...hidden, ...next])) }
}

/**
 * Rows about companies, kept when their company is visible. `key` names the company-id column;
 * `keepUnlinked` keeps rows about no company (a fund-wide note). `companyIds` null = no filter.
 */
export function scopeCompanyRows<T extends Record<string, any>>(
  rows: T[], companyIds: string[] | null, key: keyof T & string = 'id', opts: { keepUnlinked?: boolean } = {},
): T[] {
  if (companyIds === null) return rows
  return rows.filter(r => r[key] == null ? !!opts.keepUnlinked : companyIds.includes(r[key]))
}

/**
 * Why this caller may not set a deal's owning entity to `vehicleId`, or null when they may. A member
 * must pick one of their own entities — leaving it unassigned would hide it from them, since an
 * unassigned deal is visible to admins only.
 */
export function dealEntityProblem(access: Pick<AccessContext, 'vehicles'>, vehicleId: string | null): string | null {
  if (access.vehicles.all) return null
  if (!vehicleId) return 'Choose which of your entities this deal is for.'
  return canSeeVehicle(access, vehicleId) ? null : "You don't have access to that entity."
}

/**
 * Why this caller may not create a company with these entity names, or null. A member must name at
 * least one entity, all of them theirs: a company linked to none is admin-only, so they would lose
 * it the moment they made it, and naming a new one would create an entity they cannot see.
 */
export function newCompanyGroupsProblem(visibleNames: string[] | null, groups: string[] | null | undefined): string | null {
  if (visibleNames === null) return null
  const named = (groups ?? []).filter(Boolean)
  if (named.length === 0) return 'Choose which of your entities this company belongs to.'
  return named.every(g => visibleNames.includes(g)) ? null : "You don't have access to that entity."
}

/**
 * Scope a PostgREST query to the caller's visible companies. `companyIds` null = no filter.
 * `keepUnlinked` also keeps rows about no company (a fund-wide note). Ids are uuids, so they are
 * safe inside the `or` filter string.
 */
export function filterByCompany<Q extends { in: Function; is: Function; or: Function }>(
  query: Q, companyIds: string[] | null, opts: { keepUnlinked?: boolean; column?: string } = {},
): Q {
  if (companyIds === null) return query
  const col = opts.column ?? 'company_id'
  if (!opts.keepUnlinked) return query.in(col, companyIds) as Q
  if (companyIds.length === 0) return query.is(col, null) as Q
  return query.or(`${col}.is.null,${col}.in.(${companyIds.join(',')})`) as Q
}

/**
 * Why this caller may not change an entity's identity, or null. Name-based scoping (portfolio_group
 * strings, aliases) is how a member's entities find their rows — so a member who could rename an
 * entity, add an alias, create one named like a legacy string, or merge one into another could widen
 * their own sight to rows that are not theirs. Only an unscoped caller (an admin, or a member
 * granted every entity) changes those.
 */
export function entityIdentityChangeDenial(
  access: Pick<AccessContext, 'vehicles'>,
  change: { name?: unknown; aliases?: unknown; mergeIntoId?: unknown },
): string | null {
  if (access.vehicles.all) return null
  if (change.name !== undefined || change.aliases !== undefined || change.mergeIntoId !== undefined) {
    return 'Only someone who can see every entity can create, rename, alias or merge entities.'
  }
  return null
}
