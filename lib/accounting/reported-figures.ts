// Fund performance figures another system reports (vehicle_reported_figures): the fund
// administrator's net TVPI, DPI and IRR, recorded as stated, as of a date, with the source named.
//
// This app never computes, reconciles or overwrites them. The investor letter's brief takes them
// exactly as recorded for the quarter end, and when one is missing it says so rather than falling
// back to a figure of the app's own. The fund performance surfaces show them beside their own
// figures, each labelled with where it came from.
//
// Read and written with the service-role key only; every caller has already passed its gate.

import type { SupabaseClient } from '@supabase/supabase-js'
import { groupWriteDenial } from '@/lib/access/scope'
import { vehicleIdByName } from '@/lib/accounting/vehicle-id'
import { done, dbFail, fail, type Outcome } from '@/lib/service-outcome'

export * from './reported-figures-shared'
import { REPORTED_METRICS, type ReportedBasis, type ReportedFigure, type ReportedMetric } from './reported-figures-shared'

const isDate = (v: unknown): v is string => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v) && !Number.isNaN(Date.parse(v))
const str = (v: unknown, max: number): string | null => (typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : null)

/**
 * One figure from what a person or an assistant passed. An IRR may come as a percent ("4.73%",
 * 4.73) or a fraction (0.0473); a multiple as "1.16x" or 1.16. Returns an error message for a bad one.
 */
export function cleanReportedFigure(x: any): Omit<ReportedFigure, 'as_of' | 'source' | 'recorded_at'> | string {
  const metric = String(x?.metric ?? '').trim().toLowerCase() as ReportedMetric
  if (!REPORTED_METRICS.includes(metric)) return `metric must be one of ${REPORTED_METRICS.join(', ')}`
  const basis = String(x?.basis ?? 'net').trim().toLowerCase()
  if (basis !== 'net' && basis !== 'gross') return 'basis must be net or gross'
  const raw = typeof x?.value === 'number' ? String(x.value) : String(x?.value ?? '').trim()
  const percent = /%\s*$/.test(raw)
  const n = Number(raw.replace(/[%x×,\s]/gi, ''))
  if (!raw || !Number.isFinite(n)) return `${metric}: value must be a number`
  let value = n
  if (metric === 'irr') {
    // "4.73%" or 4.73 is a percent; 0.0473 is already a fraction. An IRR above 100% must say "%".
    if (percent || Math.abs(n) > 1) value = n / 100
  } else if (n < 0) {
    return `${metric}: a multiple can't be negative`
  }
  return { metric, basis: basis as ReportedBasis, value: Math.round(value * 1e8) / 1e8, note: str(x?.note, 1000) }
}

/**
 * The figures recorded for a vehicle as of exactly one date: a figure as of another date is not
 * the quarter's, however close, so it is never taken in its place.
 */
export async function reportedFiguresAsOf(
  admin: SupabaseClient, fundId: string, vehicle: string, asOf: string,
): Promise<ReportedFigure[]> {
  const vehicleId = await vehicleIdByName(admin, fundId, vehicle).catch(() => null)
  if (!vehicleId) return []
  const { data, error } = await (admin as any).from('vehicle_reported_figures')
    .select('metric, basis, value, source, as_of, note, recorded_at')
    .eq('fund_id', fundId).eq('vehicle_id', vehicleId).eq('as_of', asOf)
  // A read that fails (the table not yet migrated, say) reads as nothing recorded: the brief then
  // lists the figures as missing, which is the truth as far as it can tell.
  if (error || !Array.isArray(data)) return []
  return (data as any[]).map(r => ({
    metric: r.metric, basis: r.basis, value: Number(r.value), source: r.source, as_of: r.as_of,
    note: r.note ?? null, recorded_at: r.recorded_at ?? null,
  }))
}

/** The latest date with figures recorded for each vehicle (on or before `asOf`), and those figures. */
export async function latestReportedFigures(
  admin: SupabaseClient, fundId: string, asOf?: string,
): Promise<Map<string, ReportedFigure[]>> {
  const out = new Map<string, ReportedFigure[]>()
  let rows: any[] | null = null
  let vehicles: any[] | null = null
  try {
    let q = (admin as any).from('vehicle_reported_figures')
      .select('vehicle_id, metric, basis, value, source, as_of, note, recorded_at')
      .eq('fund_id', fundId)
    if (asOf) q = q.lte('as_of', asOf)
    const [r, v] = await Promise.all([q.order('as_of', { ascending: false }), (admin as any).from('fund_vehicles').select('id, name').eq('fund_id', fundId)])
    if (r?.error || !Array.isArray(r?.data)) return out
    rows = r.data
    vehicles = v?.data ?? []
  } catch {
    // Not migrated yet, or a client without the table: nothing recorded.
    return out
  }
  if (!rows) return out
  const names = new Map(((vehicles as any[]) ?? []).map(v => [v.id as string, v.name as string]))
  const latest = new Map<string, string>()
  for (const r of rows as any[]) {
    const name = names.get(r.vehicle_id)
    if (!name) continue
    if (!latest.has(name)) latest.set(name, r.as_of)
    if (latest.get(name) !== r.as_of) continue
    const list = out.get(name) ?? []
    list.push({ metric: r.metric, basis: r.basis, value: Number(r.value), source: r.source, as_of: r.as_of, note: r.note ?? null, recorded_at: r.recorded_at ?? null })
    out.set(name, list)
  }
  return out
}

/**
 * Record figures for a vehicle as of a date, as the source reports them. A figure already recorded
 * for that date, metric and basis is replaced; the others are left as they were.
 */
export async function recordReportedFigures(
  admin: SupabaseClient, ctx: { fundId: string; userId: string | null; vehicleNames: string[] | null },
  input: { vehicle: unknown; as_of: unknown; source: unknown; figures: unknown },
): Promise<Outcome<{ vehicle: string; as_of: string; source: string; figures: ReportedFigure[] }>> {
  const vehicle = str(input.vehicle, 200)
  if (!vehicle) return fail(400, 'vehicle is required')
  const denied = groupWriteDenial(ctx.vehicleNames, vehicle)
  if (denied) return fail(403, denied)
  if (!isDate(input.as_of)) return fail(400, 'as_of must be a date (YYYY-MM-DD)')
  const source = str(input.source, 200)
  if (!source) return fail(400, 'source is required: name the system the figures come from')
  const list = Array.isArray(input.figures) ? input.figures : []
  if (!list.length) return fail(400, 'figures is required: at least one { metric, basis, value }')
  if (list.length > 20) return fail(400, 'At most 20 figures at a time.')
  const cleaned = []
  for (const f of list) {
    const c = cleanReportedFigure(f)
    if (typeof c === 'string') return fail(400, c)
    cleaned.push(c)
  }
  const seen = new Set<string>()
  for (const c of cleaned) {
    const k = `${c.metric}|${c.basis}`
    if (seen.has(k)) return fail(400, `${c.basis} ${c.metric} is given twice`)
    seen.add(k)
  }
  let vehicleId: string | null
  try { vehicleId = await vehicleIdByName(admin, ctx.fundId, vehicle) } catch (e: any) { return fail(500, e?.message ?? 'Could not read the vehicles.') }
  if (!vehicleId) return fail(404, `No vehicle named "${vehicle}". list_vehicles gives the names.`)
  const now = new Date().toISOString()
  const rows = cleaned.map(c => ({
    fund_id: ctx.fundId, vehicle_id: vehicleId, as_of: input.as_of, metric: c.metric, basis: c.basis,
    value: c.value, source, note: c.note, recorded_by: ctx.userId, recorded_at: now,
  }))
  const { error } = await (admin as any).from('vehicle_reported_figures')
    .upsert(rows, { onConflict: 'vehicle_id,as_of,metric,basis' })
  if (error) return dbFail(error, 'reported-figures')
  return done({
    vehicle, as_of: input.as_of as string, source,
    figures: cleaned.map(c => ({ ...c, source, as_of: input.as_of as string, recorded_at: now })),
  })
}
