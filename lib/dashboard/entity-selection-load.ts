import type { SupabaseClient } from '@supabase/supabase-js'
import { hasAccess, type AccessContext } from '@/lib/access/effective'
import { visibleVehicleIds } from '@/lib/access/scope'
import { createTransactionLoader, type LoadTransactions } from './transactions'
import type { InvestmentTransaction } from '@/lib/types/database'
import { activeEntityOptions, DASHBOARD_HOLDING_TYPES, type EntityOption } from './entity-selection'

/**
 * The dashboard's entity options for this viewer: their entities holding an active position.
 * Reads with the service role, so every query is confined to the fund AND to the viewer's
 * entities here — never wider than `access` allows.
 */
export async function loadActiveEntityOptions(admin: SupabaseClient, access: AccessContext, loadTransactions: LoadTransactions = createTransactionLoader(admin, access.fundId)): Promise<EntityOption[]> {
  const fundId = access.fundId
  const ids = visibleVehicleIds(access)
  if (ids !== null && ids.length === 0) return []

  let vehiclesQ = (admin as any).from('fund_vehicles').select('id, name, aliases, kind').eq('fund_id', fundId)
  if (ids !== null) vehiclesQ = vehiclesQ.in('id', ids)
  let holdingsQ = (admin as any).from('company_vehicles').select('company_id, vehicle_id')
    .eq('fund_id', fundId).eq('relation', 'holding')
  if (ids !== null) holdingsQ = holdingsQ.in('vehicle_id', ids)
  const [{ data: vehicles, error: vehiclesError }, { data: holdings, error: holdingsError }] = await Promise.all([vehiclesQ, holdingsQ])
  if (vehiclesError || holdingsError) throw new Error('Could not load portfolio entities')

  const links = ((holdings as any[]) ?? []).map(h => ({ companyId: h.company_id as string, vehicleId: h.vehicle_id as string }))
  const companyIds = Array.from(new Set(links.map(l => l.companyId)))
  if (companyIds.length === 0) return []

  const { data: companies, error: companiesError } = await (admin as any).from('companies').select('id, status, holding_type')
    .eq('fund_id', fundId).in('id', companyIds).eq('status', 'active').in('holding_type', [...DASHBOARD_HOLDING_TYPES])
  if (companiesError) throw new Error('Could not load portfolio holdings')
  const active = ((companies as any[]) ?? []).map(c => ({ id: c.id as string, status: c.status as string, holdingType: c.holding_type as string }))

  // The transactions decide whether an 'active' company's position in a given entity is still open.
  const transactionsByCompany = new Map<string, InvestmentTransaction[]>()
  if (active.length > 0) {
    const txns = await loadTransactions(active.map(c => c.id))
    for (const t of txns ?? []) {
      if (!transactionsByCompany.has(t.company_id)) transactionsByCompany.set(t.company_id, [])
      transactionsByCompany.get(t.company_id)!.push(t)
    }
  }

  return activeEntityOptions({
    access,
    vehicles: (vehicles as any[]) ?? [],
    holdings: links,
    companies: active,
    transactionsByCompany,
    includeManagementCompanies: hasAccess(access, 'management_company', 'read'),
  })
}

/** The fund-wide default exclusions an admin set ([] when none, or before the column exists). */
export async function loadFundDefaultExcluded(admin: SupabaseClient, fundId: string): Promise<string[]> {
  const { data } = await (admin as any).from('fund_settings').select('dashboard_excluded_vehicle_ids')
    .eq('fund_id', fundId).maybeSingle()
  const ids = data?.dashboard_excluded_vehicle_ids
  return Array.isArray(ids) ? ids : []
}

/** The person's saved exclusions, or null when they have never saved a selection. */
export async function loadSavedExcluded(admin: SupabaseClient, fundId: string, userId: string): Promise<string[] | null> {
  const { data } = await (admin as any).from('dashboard_preferences').select('excluded_vehicle_ids')
    .eq('user_id', userId).eq('fund_id', fundId).maybeSingle()
  if (!data) return null
  return Array.isArray(data.excluded_vehicle_ids) ? data.excluded_vehicle_ids : []
}
