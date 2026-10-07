import { NextResponse } from 'next/server'
import type { SupabaseClient } from '@supabase/supabase-js'
import { loadAccessContext } from '@/lib/access/effective'
import { canSeeVehicle, visibleVehicleIds } from '@/lib/access/scope'
import { vehicleIdByName } from './vehicle-id'
import type { VehicleGate } from './vehicle-domain'

/**
 * The entity half of the vehicle check. `assertVehicleDomain` asks "may this caller have a
 * management company's books at all?" — a question about the KIND of entity. This asks "is this
 * one of THEIR entities?" — fund_member_vehicles, or every entity for an admin.
 *
 * Name in, because every vehicle-scoped route still keys on the name the client sends; resolved to
 * the registry id (alias-aware) before deciding. A legacy name with no registry row cannot be
 * granted, so only a caller who sees everything reaches it.
 */
export async function assertVehicleVisible(
  admin: SupabaseClient,
  gate: VehicleGate,
  name: string,
): Promise<NextResponse | null> {
  const access = await loadAccessContext(admin, gate.fundId, gate.userId, gate.role)
  if (access.vehicles.all) return null
  const id = await vehicleIdByName(admin, gate.fundId, name)
  if (canSeeVehicle(access, id)) return null
  return NextResponse.json({ error: "You don't have access to that entity." }, { status: 403 })
}

/**
 * The names of the entities this caller may see, or null when they see every entity. Names, not
 * ids, because the vehicle-scoped tables and routes still key on `portfolio_group`.
 */
export async function visibleVehicleNames(
  admin: SupabaseClient,
  gate: Pick<VehicleGate, 'fundId' | 'userId' | 'role'>,
): Promise<string[] | null> {
  const access = await loadAccessContext(admin, gate.fundId, gate.userId, gate.role)
  const ids = visibleVehicleIds(access)
  if (ids === null) return null
  if (ids.length === 0) return []
  const { data } = await (admin as any).from('fund_vehicles').select('id, name').eq('fund_id', gate.fundId).in('id', ids)
  return ((data as any[]) ?? []).map(v => v.name as string).sort()
}
