// Removing a dated set of LP positions (a whole as-of column of a tracking vehicle), shared by
// DELETE /api/accounting/positions and the `delete_lp_positions` agent tool. Admin-only on every
// surface (lib/access/admin-only.ts). There is no undo: the positions ARE the vehicle's capital
// record (lib/accounting/lp-positions.ts), so the set has to be imported or typed again.

import type { SupabaseClient } from '@supabase/supabase-js'
import { dbFail, done, fail, type Outcome } from '@/lib/service-outcome'
import { vehicleIdByName } from './vehicle-id'

const ISO = /^\d{4}-\d{2}-\d{2}$/

export async function deleteLpPositions(
  admin: SupabaseClient, fundId: string, group: string, asOfDate: string,
): Promise<Outcome<{ ok: true }>> {
  if (!ISO.test(asOfDate)) return fail(400, 'asOfDate required')
  const vehicleId = await vehicleIdByName(admin, fundId, group)
  if (!vehicleId) return fail(400, 'Unknown vehicle')
  const { error } = await (admin as any)
    .from('lp_positions').delete()
    .eq('fund_id', fundId).eq('vehicle_id', vehicleId).eq('as_of_date', asOfDate)
  if (error) return dbFail(error, 'accounting-positions')
  return done({ ok: true })
}
