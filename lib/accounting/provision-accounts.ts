import type { SupabaseClient } from '@supabase/supabase-js'
import { chartForVehicleKind } from './chart'
import { vehicleIdByName } from './vehicle-id'
import { vehicleKindByName } from './vehicle-domain'

/** Write operations only. Ignore duplicates atomically; never overwrite customized accounts. */
export async function ensureVehicleAccounts(admin: SupabaseClient, fundId: string, group: string): Promise<void> {
  const [vehicleId, kind] = await Promise.all([
    vehicleIdByName(admin, fundId, group), vehicleKindByName(admin, fundId, group),
  ])
  if (!vehicleId) throw new Error('Unknown entity')
  // The conflict key below carries portfolio_group, which is the vehicle's name when the account
  // was created and is not rewritten on a rename. Keyed on that alone, a renamed vehicle got a
  // second copy of its whole standard chart, and postings landed on the copies. So skip every
  // code the vehicle already has, by vehicle_id; the upsert only settles concurrent creation.
  const { data: existing, error: readError } = await admin.from('chart_of_accounts' as any)
    .select('code').eq('fund_id', fundId).eq('vehicle_id', vehicleId)
  if (readError) throw readError
  const have = new Set(((existing as any[]) ?? []).map(a => a.code as string))
  const chart = chartForVehicleKind(kind).filter(a => !have.has(a.code))
  if (!chart.length) return
  const { error } = await admin.from('chart_of_accounts' as any).upsert(chart.map(a => ({
    fund_id: fundId, vehicle_id: vehicleId, portfolio_group: group,
    code: a.code, name: a.name, type: a.type, subtype: a.subtype ?? null,
  })), { onConflict: 'fund_id,portfolio_group,code', ignoreDuplicates: true })
  if (error) throw error
}
