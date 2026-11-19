// GP-of-vehicle links: which GP/associate entity is the GP of which vehicle (many-to-many).
//
// Backed by `vehicle_gp_links`. Falls back to the legacy `fund_vehicles.serves_vehicle_id` /
// `lp_entity_id` columns only when the table doesn't exist yet (migration unapplied) — once the
// table is present it is authoritative, so a deliberately-empty set means "no GP links", not
// "look at the old columns".

import type { SupabaseClient } from '@supabase/supabase-js'

export interface GpLink {
  /** The GP/associate entity (its own fund_vehicle). */
  gpVehicleId: string
  /** The vehicle it is the GP of. */
  servedVehicleId: string
  /** As which partner the GP appears in the served vehicle. */
  lpEntityId: string | null
}

/** All GP links for a fund. */
export async function loadVehicleGpLinks(admin: SupabaseClient, fundId: string): Promise<GpLink[]> {
  const { data, error } = await admin
    .from('vehicle_gp_links' as any)
    .select('gp_vehicle_id, served_vehicle_id, lp_entity_id')
    .eq('fund_id', fundId)

  if (!error) {
    return ((data as any[]) ?? []).map(r => ({
      gpVehicleId: r.gp_vehicle_id,
      servedVehicleId: r.served_vehicle_id,
      lpEntityId: r.lp_entity_id ?? null,
    }))
  }

  // Fall back to the legacy columns ONLY when the table doesn't exist yet (undefined_table).
  // On any other error we must NOT read the frozen legacy columns — the write endpoint never
  // updates them, so doing so would resurrect links the user has since deleted. Degrade to empty.
  if ((error as any)?.code !== '42P01') return []

  const { data: veh } = await admin
    .from('fund_vehicles' as any)
    .select('id, serves_vehicle_id, lp_entity_id')
    .eq('fund_id', fundId)
  return ((veh as any[]) ?? [])
    .filter(v => v.serves_vehicle_id)
    .map(v => ({ gpVehicleId: v.id, servedVehicleId: v.serves_vehicle_id, lpEntityId: v.lp_entity_id ?? null }))
}

/** The GP entities of one served vehicle. */
export function gpsOfVehicle(links: GpLink[], servedVehicleId: string): GpLink[] {
  return links.filter(l => l.servedVehicleId === servedVehicleId)
}

/** The vehicles a GP/associate entity serves. */
export function vehiclesServedBy(links: GpLink[], gpVehicleId: string): GpLink[] {
  return links.filter(l => l.gpVehicleId === gpVehicleId)
}

export interface SetGpLinkInput {
  servedVehicleId: string
  gpVehicleId: string
  /** As which partner of the served vehicle the GP appears; null leaves it unset. */
  lpEntityId: string | null
}

/**
 * Add a GP link, or change the partner on an existing one (one link per GP and served vehicle).
 * The GP vehicle and the partner must both belong to this fund: lp_entities is a cross-fund table,
 * so an unchecked id could plant another fund's entity on the link. Returns an error message, or
 * null when the link was written.
 */
export async function setVehicleGpLink(admin: SupabaseClient, fundId: string, input: SetGpLinkInput): Promise<string | null> {
  if (input.gpVehicleId === input.servedVehicleId) return 'An entity cannot be its own GP.'
  const { data: gp, error: gpError } = await (admin as any)
    .from('fund_vehicles').select('id').eq('fund_id', fundId).eq('id', input.gpVehicleId).maybeSingle()
  if (gpError) throw new Error(`fund_vehicles read failed: ${gpError.message}`)
  if (!gp) return 'That GP entity is not a vehicle in this fund.'
  if (input.lpEntityId) {
    const { data: ent, error: entError } = await (admin as any)
      .from('lp_entities').select('id').eq('fund_id', fundId).eq('id', input.lpEntityId).maybeSingle()
    if (entError) throw new Error(`lp_entities read failed: ${entError.message}`)
    if (!ent) return 'That partner is not in this fund.'
  }
  const { error } = await (admin as any).from('vehicle_gp_links').upsert(
    { fund_id: fundId, gp_vehicle_id: input.gpVehicleId, served_vehicle_id: input.servedVehicleId, lp_entity_id: input.lpEntityId },
    { onConflict: 'gp_vehicle_id,served_vehicle_id' },
  )
  if (error) throw new Error(`vehicle_gp_links write failed: ${error.message}`)
  return null
}

/** Remove the link between a GP entity and a served vehicle. Returns how many rows went. */
export async function removeVehicleGpLink(admin: SupabaseClient, fundId: string, servedVehicleId: string, gpVehicleId: string): Promise<number> {
  const { data, error } = await (admin as any).from('vehicle_gp_links').delete()
    .eq('fund_id', fundId).eq('served_vehicle_id', servedVehicleId).eq('gp_vehicle_id', gpVehicleId).select('id')
  if (error) throw new Error(`vehicle_gp_links delete failed: ${error.message}`)
  return ((data as any[]) ?? []).length
}
