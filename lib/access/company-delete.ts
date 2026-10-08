import type { SupabaseClient } from '@supabase/supabase-js'
import type { EntityScope } from './entity-scope'
import { canSeeVehicle } from './scope'

/**
 * Why this caller may not delete a company (or fund holding), or null. Deleting removes it for every
 * entity, so a scoped member may delete only a company that is wholly theirs: no other entity linked
 * to it, and no legacy group name on it or its transactions that is not one of theirs. The second
 * check matters because a legacy `portfolio_group` naming no current entity produces no link, so
 * the links alone would let a member delete data only an admin can see.
 */
export async function companyDeleteDenial(
  admin: SupabaseClient,
  scope: Pick<EntityScope, 'access' | 'vehicleNames'>,
  companyId: string,
): Promise<string | null> {
  if (scope.access.vehicles.all || scope.vehicleNames === null) return null
  const names = scope.vehicleNames
  // Neutral on purpose: that another entity holds the company is not the caller's to learn.
  const refusal = 'Only an admin can delete this company.'
  const [{ data: links }, { data: company }, { data: txns }] = await Promise.all([
    (admin as any).from('company_vehicles').select('vehicle_id').eq('company_id', companyId),
    (admin as any).from('companies').select('portfolio_group').eq('id', companyId).maybeSingle(),
    (admin as any).from('investment_transactions').select('portfolio_group').eq('company_id', companyId),
  ])
  if (((links as any[]) ?? []).some(l => !canSeeVehicle(scope.access, l.vehicle_id))) return refusal
  const tags: string[] = ((company as any)?.portfolio_group as string[] | null) ?? []
  if (tags.some(g => !names.includes(g))) return refusal
  if (((txns as any[]) ?? []).some(t => t.portfolio_group && !names.includes(t.portfolio_group))) return refusal
  return null
}
