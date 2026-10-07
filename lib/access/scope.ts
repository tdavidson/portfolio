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
}

/**
 * Read `access_context`'s `vehicles` into a scope.
 *
 * A row WITHOUT the key means the RPC predates 20261007100000: everything, exactly as before entity
 * access existed. That is what lets this code deploy before the migration is pushed. Once it is
 * pushed the key is always present, and an empty list means what it says.
 */
export function vehicleScopeFromRow(role: FundRole, vehicles: unknown): VehicleScope {
  const ids = Array.isArray(vehicles) ? vehicles.filter((v): v is string => typeof v === 'string') : []
  if (role === 'admin' || vehicles === undefined) return { all: true, ids }
  return { all: false, ids }
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
