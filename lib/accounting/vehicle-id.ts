import type { SupabaseClient } from '@supabase/supabase-js'

/** A resolved name/alias → fund_vehicles.id map for one fund. */
export type VehicleIdMap = Map<string, string>

/**
 * Load every vehicle's name AND aliases → id once, for a fund. The hot report paths
 * (`fundEconomics`, `generateLiveReport`) resolve the same handful of vehicle names 3–4×
 * each across their loaders; passing this map into `vehicleIdByName` turns ~3V per-name
 * lookups into a single fund-wide query. Aliases are indexed too so a legacy name still
 * resolves, exactly as the per-name path does.
 */
export async function loadVehicleIdMap(admin: SupabaseClient, fundId: string): Promise<VehicleIdMap> {
  const { data, error } = await (admin as any)
    .from('fund_vehicles')
    .select('id, name, aliases')
    .eq('fund_id', fundId)
  if (error) throw new Error(`fund_vehicles read failed: ${error.message}`)
  const map: VehicleIdMap = new Map()
  for (const v of ((data as any[]) ?? [])) {
    if (v.name) map.set(v.name as string, v.id as string)
    for (const a of ((v.aliases as string[] | null) ?? [])) if (a && !map.has(a)) map.set(a, v.id as string)
  }
  return map
}

/**
 * Resolve a vehicle name (or legacy alias) to its fund_vehicles.id. The accounting
 * tables key off this id, so callers keep passing the vehicle name (from the
 * picker) and we resolve it here — a rename changes the registry name, not the
 * ledger rows. Returns null if the fund has no matching vehicle; THROWS if the registry read fails (a failed read is not "no vehicle").
 *
 * Pass `idMap` (from `loadVehicleIdMap`) to resolve from memory and skip the DB — used
 * by the report paths that already loaded the whole fund's vehicles.
 */
export async function vehicleIdByName(
  admin: SupabaseClient,
  fundId: string,
  name: string,
  idMap?: VehicleIdMap,
): Promise<string | null> {
  if (idMap) return idMap.get(name) ?? null
  const { data, error } = await (admin as any).from('fund_vehicles').select('id').eq('fund_id', fundId).eq('name', name).maybeSingle()
  if (error) throw new Error(`fund_vehicles read failed: ${error.message}`)
  if (data) return data.id as string
  const { data: alias, error: aliasError } = await (admin as any).from('fund_vehicles').select('id').eq('fund_id', fundId).contains('aliases', [name]).limit(1).maybeSingle()
  if (aliasError) throw new Error(`fund_vehicles read failed: ${aliasError.message}`)
  return (alias?.id as string) ?? null
}

/**
 * Guarantee every given vehicle name has a `fund_vehicles` row. Names that already match a vehicle
 * (by name or alias, case/whitespace-insensitive) are left as-is; names with no match get a new
 * LIGHTWEIGHT vehicle — `kind: 'other'` (the uncategorized bucket), a bare name the user enriches
 * later (set the kind, add LP/fund/accounting details).
 *
 * This is the invariant that stops a vehicle name from ever being a disconnected string: every write
 * path that stores one (company save, investment save, import) calls this first, so the registry is
 * always the source of truth and the stored `portfolio_group` string is a projection of a real
 * vehicle. Empty/blank input creates nothing — a company or investment may have NO vehicle.
 */
export async function ensureVehiclesByName(
  admin: SupabaseClient,
  fundId: string,
  names: (string | null | undefined)[],
): Promise<void> {
  const wanted = Array.from(new Set(
    names.map(n => (typeof n === 'string' ? n.trim() : '')).filter(Boolean),
  ))
  if (wanted.length === 0) return

  const { data } = await (admin as any)
    .from('fund_vehicles').select('name, aliases').eq('fund_id', fundId)
  const existing = new Set<string>()
  for (const v of ((data as any[]) ?? [])) {
    if (v.name) existing.add((v.name as string).trim().toLowerCase())
    for (const a of ((v.aliases as string[] | null) ?? [])) if (a) existing.add(a.trim().toLowerCase())
  }

  const toCreate = wanted.filter(n => !existing.has(n.toLowerCase()))
  if (toCreate.length === 0) return

  // ignoreDuplicates on the unique(fund_id, name) so a concurrent create (two saves racing to name
  // the same new vehicle) is a no-op rather than an error.
  await (admin as any)
    .from('fund_vehicles')
    .upsert(
      toCreate.map(name => ({ fund_id: fundId, name, kind: 'other', aliases: [], active: true })),
      { onConflict: 'fund_id,name', ignoreDuplicates: true },
    )
}

/**
 * Resolve a `fund_vehicles.id` back to its current name, scoped to the fund. The inverse of
 * `vehicleIdByName`, for the URL-addressable surfaces (e.g. /funds/[id]) that route on the stable
 * UUID — like companies and LPs — rather than the mutable name. Returns null when the id isn't a
 * vehicle in this fund, so a stale or cross-fund link resolves to "not found" instead of leaking.
 */
export async function vehicleNameById(
  admin: SupabaseClient,
  fundId: string,
  id: string,
): Promise<string | null> {
  const { data } = await (admin as any)
    .from('fund_vehicles').select('name').eq('id', id).eq('fund_id', fundId).maybeSingle()
  return (data?.name as string) ?? null
}
