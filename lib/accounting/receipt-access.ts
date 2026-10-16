import { NextResponse } from 'next/server'
import type { SupabaseClient } from '@supabase/supabase-js'
import { resolveGroupOr400 } from './http-vehicle'
import { vehicleNameById } from './vehicle-id'
import { loadAccessContext } from '@/lib/access/effective'
import type { VehicleGate } from './vehicle-domain'
import type { ReceiptRow } from './receipts'

/**
 * May this caller act on this receipt? A receipt filed under an entity is that entity's paperwork,
 * so it is resolved exactly like the entity's books (resolveGroupOr400: visibility, and the
 * management-company grant for a manco). A receipt with NO entity yet, straight from the mailbox,
 * could belong to anyone's books, so only a caller who sees every entity may open it.
 *
 * Returns the entity's name (null for an unassigned receipt) or the refusal.
 */
export async function authorizeReceipt(
  admin: SupabaseClient,
  gate: VehicleGate,
  r: Pick<ReceiptRow, 'vehicle_id'>,
): Promise<{ group: string | null } | NextResponse> {
  if (r.vehicle_id) {
    const name = await vehicleNameById(admin, gate.fundId, r.vehicle_id)
    if (!name) return NextResponse.json({ error: 'Receipt not found' }, { status: 404 })
    const group = await resolveGroupOr400(admin, gate, name)
    if (group instanceof NextResponse) return group
    return { group }
  }
  if (await seesEveryEntity(admin, gate)) return { group: null }
  return NextResponse.json({ error: 'Receipt not found' }, { status: 404 })
}

export async function seesEveryEntity(admin: SupabaseClient, gate: VehicleGate): Promise<boolean> {
  const access = await loadAccessContext(admin, gate.fundId, gate.userId, gate.role)
  return access.vehicles.all
}
