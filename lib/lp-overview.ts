/**
 * Shared LP-portal overview aggregation. Turns raw lp_investments rows (across
 * snapshots) into a dashboard summary: the totals + per-vehicle breakdown for
 * the single most recent snapshot. Used by both the live portal
 * (/api/portal/overview) and the GP "view as LP" preview so they stay identical.
 */

import { lpRatios } from '@/lib/lp-metrics'

export interface OverviewVehicle {
  name: string
  commitment: number
  called: number | null
  distributed: number | null
  nav: number | null
  dpi: number | null
  tvpi: number | null
  /**
   * The investor's IRR in this vehicle, only when the fund shows IRR on the portal
   * (fund_settings.lp_portal_show_irr); absent otherwise. Null when there is none to show: under a
   * year of history, or several of the investor's entities in the vehicle, whose IRRs can't be
   * combined without their combined cash flows. Never totalled across vehicles for the same reason.
   */
  irr?: number | null
}

export interface OverviewTotals {
  commitment: number
  called: number | null
  distributed: number | null
  nav: number | null
  dpi: number | null
  tvpi: number | null
}

export interface OverviewMetrics {
  asOfDate: string | null
  snapshotName: string | null
  totals: OverviewTotals
  vehicles: OverviewVehicle[]
}

export interface OverviewInvestmentRow {
  portfolio_group: string | null
  commitment: number | string | null
  paid_in_capital: number | string | null
  called_capital: number | string | null
  distributions: number | string | null
  nav: number | string | null
  total_value: number | string | null
  snapshot_id: string | null
  lp_snapshots?: { id: string; name: string | null; as_of_date: string | null } | null
}

// Postgres numerics can arrive as strings; coerce defensively.
const num = (x: number | string | null | undefined): number => {
  const n = typeof x === 'number' ? x : parseFloat(String(x ?? ''))
  return Number.isFinite(n) ? n : 0
}
const add = (a: number | null, b: number | null): number | null => a == null || b == null ? null : a + b
const ratio = (numerator: number | null, denominator: number | null): number | null =>
  numerator != null && denominator != null && denominator > 0 ? numerator / denominator : null

/**
 * Build the overview from investment rows (each row = one entity's position in
 * one vehicle in one snapshot). Picks the most recent snapshot by as_of_date,
 * then sums each metric per vehicle (portfolio_group) and overall. Returns null
 * when there are no rows.
 */
/**
 * @param vehicleDates optional map of vehicle name → its last-updated date (last close for a
 *   ledger vehicle, last position import for a tracked one). When given, the overview's "as of"
 *   is the MOST RECENT of the vehicles THIS LP is actually in — so it reflects real data
 *   freshness per partner rather than the snapshot's date, and differs partner-to-partner.
 */
export function buildOverview(
  rows: OverviewInvestmentRow[],
  vehicleDates?: Map<string, string | null>,
): OverviewMetrics | null {
  if (!rows.length) return null

  // Group by snapshot, then choose the latest by as_of_date (null dates sort oldest).
  const bySnapshot = new Map<string, { asOf: string | null; name: string | null; rows: OverviewInvestmentRow[] }>()
  for (const r of rows) {
    const sid = r.snapshot_id ?? r.lp_snapshots?.id ?? 'none'
    let entry = bySnapshot.get(sid)
    if (!entry) {
      entry = { asOf: r.lp_snapshots?.as_of_date ?? null, name: r.lp_snapshots?.name ?? null, rows: [] }
      bySnapshot.set(sid, entry)
    }
    entry.rows.push(r)
  }

  let latest: { asOf: string | null; name: string | null; rows: OverviewInvestmentRow[] } | null = null
  for (const entry of Array.from(bySnapshot.values())) {
    if (!latest || (entry.asOf ?? '').localeCompare(latest.asOf ?? '') > 0) latest = entry
  }
  if (!latest) return null

  const called = (r: OverviewInvestmentRow) => (r.called_capital != null ? num(r.called_capital) : num(r.paid_in_capital))
  const navOf = (r: OverviewInvestmentRow) => (r.nav != null ? num(r.nav) : num(r.total_value))

  const vehicleMap = new Map<string, OverviewVehicle>()
  const totals: OverviewTotals = { commitment: 0, called: 0, distributed: 0, nav: 0, dpi: null, tvpi: null }

  for (const r of latest.rows) {
    const key = (r.portfolio_group ?? '').trim() || 'Investment'
    let v = vehicleMap.get(key)
    if (!v) {
      v = { name: key, commitment: 0, called: 0, distributed: 0, nav: 0, dpi: null, tvpi: null }
      vehicleMap.set(key, v)
    }
    const c = num(r.commitment), cl = called(r), d = num(r.distributions), n = navOf(r)
    v.commitment += c; v.called = add(v.called, cl); v.distributed = add(v.distributed, d); v.nav = add(v.nav, n)
    totals.commitment += c; totals.called = add(totals.called, cl); totals.distributed = add(totals.distributed, d); totals.nav = add(totals.nav, n)
  }

  for (const v of Array.from(vehicleMap.values())) {
    v.dpi = ratio(v.distributed, v.called)
    v.tvpi = ratio(add(v.distributed, v.nav), v.called)
  }
  totals.dpi = ratio(totals.distributed, totals.called)
  totals.tvpi = ratio(add(totals.distributed, totals.nav), totals.called)

  const vehicles = Array.from(vehicleMap.values()).sort((a, b) => b.commitment - a.commitment)

  // "As of" = the most recent data date across THIS LP's vehicles (per-partner), when we have
  // the per-vehicle dates; otherwise fall back to the snapshot's own date.
  let asOfDate = latest.asOf
  if (vehicleDates) {
    const ds = vehicles
      .map(v => vehicleDates.get(v.name) ?? null)
      .filter((d): d is string => !!d)
    if (ds.length) asOfDate = ds.reduce((a, b) => (a > b ? a : b))
  }

  return { asOfDate, snapshotName: latest.name, totals, vehicles }
}

/** One LP's live investment row, as produced by the live report (paid-in ≡ called). */
export interface LiveOverviewRow {
  portfolio_group: string | null
  commitment: number
  paid_in_capital: number | null
  distributions: number | null
  nav: number | null
  /** The row's IRR from the live report, set only for a fund that shows IRR on the portal. */
  irr?: number | null
}

/**
 * The same dashboard summary as buildOverview, but from LIVE report rows (derived, as-of-today)
 * rather than a frozen snapshot — the portal reads exactly what /lps shows, sliced to this LP.
 * `vehicleDates` sets the per-partner "as of" (last close / last import per vehicle).
 */
export function overviewFromLive(
  rows: LiveOverviewRow[],
  vehicleDates?: Map<string, string | null>,
): OverviewMetrics | null {
  if (!rows.length) return null

  const vehicleMap = new Map<string, OverviewVehicle>()
  const totals: OverviewTotals = { commitment: 0, called: 0, distributed: 0, nav: 0, dpi: null, tvpi: null }
  for (const r of rows) {
    const key = (r.portfolio_group ?? '').trim() || 'Investment'
    let v = vehicleMap.get(key)
    if (!v) { v = { name: key, commitment: 0, called: 0, distributed: 0, nav: 0, dpi: null, tvpi: null }; vehicleMap.set(key, v) }
    const c = num(r.commitment), cl = r.paid_in_capital, d = r.distributions, n = r.nav
    v.commitment += c; v.called = add(v.called, cl); v.distributed = add(v.distributed, d); v.nav = add(v.nav, n)
    totals.commitment += c; totals.called = add(totals.called, cl); totals.distributed = add(totals.distributed, d); totals.nav = add(totals.nav, n)
  }
  for (const v of Array.from(vehicleMap.values())) {
    const rr = lpRatios({ commitment: v.commitment, paidIn: v.called, distributions: v.distributed, nav: v.nav })
    v.dpi = rr.dpi; v.tvpi = rr.tvpi
  }
  // IRR per vehicle, and only one entity's: averaging two IRRs is not the IRR of their cash flows.
  const rowsByVehicle = new Map<string, LiveOverviewRow[]>()
  for (const r of rows) {
    const key = (r.portfolio_group ?? '').trim() || 'Investment'
    rowsByVehicle.set(key, [...(rowsByVehicle.get(key) ?? []), r])
  }
  for (const [key, vr] of Array.from(rowsByVehicle.entries())) {
    if (vr.some(r => r.irr === undefined)) continue
    vehicleMap.get(key)!.irr = vr.length === 1 ? vr[0].irr ?? null : null
  }
  const tr = lpRatios({ commitment: totals.commitment, paidIn: totals.called, distributions: totals.distributed, nav: totals.nav })
  totals.dpi = tr.dpi; totals.tvpi = tr.tvpi

  const vehicles = Array.from(vehicleMap.values()).sort((a, b) => b.commitment - a.commitment)
  let asOfDate: string | null = null
  if (vehicleDates) {
    const ds = vehicles.map(v => vehicleDates.get(v.name) ?? null).filter((d): d is string => !!d)
    if (ds.length) asOfDate = ds.reduce((a, b) => (a > b ? a : b))
  }
  return { asOfDate, snapshotName: null, totals, vehicles }
}
