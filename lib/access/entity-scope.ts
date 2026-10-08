import type { SupabaseClient } from '@supabase/supabase-js'
import { loadAccessContext, type AccessContext } from './effective'
import { visibleCompanyIds, visibleVehicleIds } from './scope'

/**
 * Everything a cross-entity read needs to scope itself, resolved once per request: which entity
 * names (with their legacy aliases — `portfolio_group` strings may carry either) and which companies
 * the caller may see. Null in either means "no filter": the caller sees every entity.
 */
export interface EntityScope {
  access: AccessContext
  vehicleNames: string[] | null
  companyIds: string[] | null
}

export async function loadEntityScope(
  admin: SupabaseClient,
  who: { fundId: string; userId: string; role: string },
): Promise<EntityScope> {
  const access = await loadAccessContext(admin, who.fundId, who.userId, who.role)
  return entityScopeFor(admin, access)
}

/** The same, from an access context the caller already holds (a page's `resolvePageAccess`). */
export async function entityScopeFor(admin: SupabaseClient, access: AccessContext): Promise<EntityScope> {
  const ids = visibleVehicleIds(access)
  if (ids === null) return { access, vehicleNames: null, companyIds: null }
  if (ids.length === 0) return { access, vehicleNames: [], companyIds: [] }
  const [{ data: vehicles, error }, companyIds] = await Promise.all([
    (admin as any).from('fund_vehicles').select('name, aliases').eq('fund_id', access.fundId).in('id', ids),
    visibleCompanyIds(admin, access),
  ])
  // THROWS: a failed read is not "no entity names" — that would show a scoped member an empty
  // portfolio and refuse their writes as if they had no entity.
  if (error) throw new Error(`fund_vehicles read failed: ${error.message}`)
  const vehicleNames = Array.from(new Set(((vehicles as any[]) ?? [])
    .flatMap(v => [v.name as string, ...((v.aliases as string[] | null) ?? [])]))).sort()
  return { access, vehicleNames, companyIds }
}

/**
 * The same, from just a user id — for the routes that look up `fund_members` themselves. Null when
 * they are not a member of any fund (the route's own membership check answers that).
 */
export async function loadEntityScopeForUser(admin: SupabaseClient, userId: string): Promise<EntityScope | null> {
  const { data: m } = await (admin as any).from('fund_members').select('fund_id, role').eq('user_id', userId).maybeSingle()
  if (!m) return null
  return loadEntityScope(admin, { fundId: m.fund_id, userId, role: m.role })
}
