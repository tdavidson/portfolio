// Reads for admin-reported vehicles (see figures.ts and the 20261119150000 migration).
//
// Every read here tolerates a database the migration has not reached yet: a missing column or
// table reads as "every vehicle keeps its own books", which is what every vehicle did before.
// Service-role client only; callers have passed their gate.

import type { SupabaseClient } from '@supabase/supabase-js'
import { fetchAllRows } from '@/lib/accounting/load'
import { adminRows, type AdminFundFigures, type AdminProvider, type AdminRow, type RecordSource, type StoredAdminPosition } from './figures'

export interface VehicleRecordSource {
  recordSource: RecordSource
  provider: AdminProvider | null
  fundRef: string | null
}

/** Each vehicle's record source, keyed by vehicle id. Vehicles that keep their own books are left out. */
export async function loadAdminVehicles(admin: SupabaseClient, fundId: string): Promise<Map<string, VehicleRecordSource>> {
  const out = new Map<string, VehicleRecordSource>()
  try {
    const { data, error } = await (admin as any)
      .from('fund_vehicles')
      .select('id, record_source, admin_provider, admin_fund_ref')
      .eq('fund_id', fundId)
      .eq('record_source', 'admin')
    if (error || !Array.isArray(data)) return out
    for (const v of data as any[]) {
      out.set(v.id as string, { recordSource: 'admin', provider: (v.admin_provider ?? null) as AdminProvider | null, fundRef: v.admin_fund_ref ?? null })
    }
  } catch {
    // Not migrated: no admin vehicles.
  }
  return out
}

/** One vehicle's record source. A books vehicle (or an unmigrated database) reads as books. */
export async function loadVehicleRecordSource(admin: SupabaseClient, fundId: string, vehicleId: string): Promise<VehicleRecordSource> {
  try {
    const { data, error } = await (admin as any)
      .from('fund_vehicles')
      .select('record_source, admin_provider, admin_fund_ref')
      .eq('fund_id', fundId)
      .eq('id', vehicleId)
      .maybeSingle()
    if (!error && data?.record_source === 'admin') {
      return { recordSource: 'admin', provider: data.admin_provider ?? null, fundRef: data.admin_fund_ref ?? null }
    }
  } catch { /* not migrated */ }
  return { recordSource: 'books', provider: null, fundRef: null }
}

/** The stored positions of admin vehicles, keyed by vehicle id, up to `asOf` when given. */
export async function loadAdminPositions(
  admin: SupabaseClient, fundId: string, vehicleIds: string[], asOf?: string,
): Promise<Map<string, StoredAdminPosition[]>> {
  const out = new Map<string, StoredAdminPosition[]>()
  if (vehicleIds.length === 0) return out
  for (const id of vehicleIds) out.set(id, [])
  const rows = await fetchAllRows<any>((from, to) => {
    let q = (admin as any)
      .from('lp_positions')
      .select('id, vehicle_id, lp_entity_id, as_of_date, commitment, called_capital, distributions, nav, receivable')
      .eq('fund_id', fundId)
      .in('vehicle_id', vehicleIds)
    if (asOf) q = q.lte('as_of_date', asOf)
    return q.order('id').range(from, to)
  })
  const num = (v: unknown) => (v == null ? null : Number(v))
  for (const r of rows) {
    out.get(r.vehicle_id)?.push({
      lpEntityId: r.lp_entity_id,
      asOfDate: r.as_of_date,
      commitment: num(r.commitment),
      calledCapital: num(r.called_capital),
      distributions: num(r.distributions),
      nav: num(r.nav),
      receivable: num(r.receivable),
    })
  }
  return out
}

export interface FundFiguresOnDate extends Partial<AdminFundFigures> {
  source?: string
}

/**
 * The administrator's net fund figures for admin vehicles, keyed by vehicle id then date. Read from
 * vehicle_reported_figures, where a saved pull records them (net basis).
 */
export async function loadAdminFundFigures(
  admin: SupabaseClient, fundId: string, vehicleIds: string[], asOf?: string,
): Promise<Map<string, Map<string, FundFiguresOnDate>>> {
  const out = new Map<string, Map<string, FundFiguresOnDate>>()
  if (vehicleIds.length === 0) return out
  try {
    let q = (admin as any)
      .from('vehicle_reported_figures')
      .select('vehicle_id, as_of, metric, basis, value, source')
      .eq('fund_id', fundId)
      .eq('basis', 'net')
      .in('vehicle_id', vehicleIds)
    if (asOf) q = q.lte('as_of', asOf)
    const { data, error } = await q
    if (error || !Array.isArray(data)) return out
    for (const r of data as any[]) {
      if (!['irr', 'tvpi', 'dpi'].includes(r.metric)) continue
      const byDate = out.get(r.vehicle_id) ?? new Map<string, FundFiguresOnDate>()
      const entry = byDate.get(r.as_of) ?? {}
      ;(entry as any)[r.metric] = Number(r.value)
      entry.source = entry.source ?? r.source
      byDate.set(r.as_of, entry)
      out.set(r.vehicle_id, byDate)
    }
  } catch { /* not migrated */ }
  return out
}

/** One admin vehicle's report rows on a date, with the administrator named where it is recorded. */
export async function adminVehicleRows(
  admin: SupabaseClient, fundId: string, vehicleId: string, asOf?: string,
  preloaded?: { positions?: StoredAdminPosition[]; fundByDate?: Map<string, FundFiguresOnDate> },
): Promise<(AdminRow & { reportedBy: string | null })[]> {
  const [positions, fundByDate] = await Promise.all([
    preloaded?.positions ?? loadAdminPositions(admin, fundId, [vehicleId], asOf).then(m => m.get(vehicleId) ?? []),
    preloaded?.fundByDate ?? loadAdminFundFigures(admin, fundId, [vehicleId], asOf).then(m => m.get(vehicleId) ?? new Map()),
  ])
  return adminRows(positions, fundByDate, asOf).map(r => ({ ...r, reportedBy: fundByDate.get(r.asOf)?.source ?? null }))
}
