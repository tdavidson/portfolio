// The capital-tracking producer: dated cumulative LP positions → CapitalPosting[].
//
// A tracking vehicle stores POSITIONS (lp_positions): what each LP's statement said on a
// given date — commitment, called/paid-in, distributions, NAV. This is the source of truth.
//
// Every consumer of LP capital (roll-forward, statement, live report, fund economics) speaks
// `CapitalPosting[]` — the same shape the ledger emits. So this module DERIVES postings from
// the stored positions at read time, by subtracting each LP's consecutive dated positions:
//
//   position(T) − position(T−1)  →  the movements that happened at T
//
// Summing those deltas on-or-before any date reconstructs the cumulative position at the
// latest date ≤ that date; slicing them to a window gives the period's activity. So the
// derived postings behave exactly like real movements for every downstream consumer — while
// nothing but the positions is ever stored, so there is no movement copy to drift.
//
// IRREGULAR DATES ARE FIRST-CLASS. A tracking vehicle may have positions on 3/31 and then
// 11/15 and nothing between; the delta postings land on those actual dates, so a roll-forward
// honestly spans whatever period the data covers. The statement layer labels the span rather
// than implying a regular close cadence it doesn't have.

import type { SupabaseClient } from '@supabase/supabase-js'
import type { CapitalPosting } from './capital-account'
import { vehicleIdByName, type VehicleIdMap } from './vehicle-id'
import { roundCents } from './ledger'
import { ACTUAL_BOOK } from './books'
import { fetchAllRows } from './load'

const TOLERANCE = 0.005

export interface LpPosition {
  id?: string
  lpEntityId: string
  asOfDate: string
  commitment: number | null
  /** = paid-in. May be null (unstated). */
  calledCapital: number | null
  distributions: number | null
  /** Reliable primitive; 0 is valid (fully realized). Null = unstated. */
  nav: number | null
  /** Reported IRR (fraction) as of this date, if stated. Not used to derive postings. */
  irr?: number | null
}

/** One entity's cumulative figures at a point, normalized to numbers. */
interface Cumulative { called: number; distributions: number; nav: number; gain: number }

function cumulativeOf(p: LpPosition): Cumulative {
  const called = roundCents(p.calledCapital ?? 0)
  const distributions = roundCents(p.distributions ?? 0)
  const nav = roundCents(p.nav ?? 0)
  // gain = NAV − contributed + distributed, the cumulative gain/(loss) implied by the position.
  return { called, distributions, nav, gain: roundCents(nav - called + distributions) }
}

/**
 * Turn a set of dated positions (for any number of entities) into delta CapitalPostings.
 *
 * Pure, so it can be pinned by a test. Positions need not be sorted or grouped; this groups
 * by entity and walks each entity's dates in order, emitting the change since the prior date.
 * The very first position for an entity emits its full cumulative figures (delta from zero) —
 * which is exactly the one-time cutover decomposition, generalized to every subsequent date.
 */
export function positionsToPostings(positions: LpPosition[]): CapitalPosting[] {
  const byEntity = new Map<string, LpPosition[]>()
  for (const p of positions) {
    if (!byEntity.has(p.lpEntityId)) byEntity.set(p.lpEntityId, [])
    byEntity.get(p.lpEntityId)!.push(p)
  }

  const out: CapitalPosting[] = []
  for (const [lpEntityId, rows] of Array.from(byEntity.entries())) {
    const sorted = rows.slice().sort((a, b) => a.asOfDate.localeCompare(b.asOfDate))
    let prev: Cumulative = { called: 0, distributions: 0, nav: 0, gain: 0 }
    for (const p of sorted) {
      const cur = cumulativeOf(p)
      const dCalled = roundCents(cur.called - prev.called)
      const dDist = roundCents(cur.distributions - prev.distributions)
      const dGain = roundCents(cur.gain - prev.gain)

      // Debit-positive, the CapitalPosting convention. Capital is a credit balance, so a
      // contribution is negative and a distribution is positive.
      if (Math.abs(dCalled) > TOLERANCE) {
        out.push({ lpEntityId, entryDate: p.asOfDate, amount: -dCalled, sourceType: 'capital_call' })
      }
      if (Math.abs(dDist) > TOLERANCE) {
        out.push({ lpEntityId, entryDate: p.asOfDate, amount: dDist, sourceType: 'distribution' })
      }
      if (Math.abs(dGain) > TOLERANCE) {
        out.push({ lpEntityId, entryDate: p.asOfDate, amount: -dGain, sourceType: 'valuation' })
      }
      prev = cur
    }
  }
  return out
}

/** Load a vehicle's stored positions, up to `asOf` (inclusive) if given. */
export async function loadPositions(
  admin: SupabaseClient,
  fundId: string,
  group: string,
  asOf?: string,
  idMap?: VehicleIdMap
): Promise<LpPosition[]> {
  const vehicleId = await vehicleIdByName(admin, fundId, group, idMap)
  if (!vehicleId) return []
  // Paged: a vehicle with quarterly history passes PostgREST's 1000-row cap, and a truncated read
  // drops LPs' latest positions so they fall back to an empty ledger and report as zero.
  const rows = await fetchAllRows<any>((from, to) => {
    let q = admin
      .from('lp_positions' as any)
      .select('id, lp_entity_id, as_of_date, commitment, called_capital, distributions, nav, irr')
      .eq('fund_id', fundId)
      .eq('vehicle_id', vehicleId)
    if (asOf) q = q.lte('as_of_date', asOf)
    return q.order('id').range(from, to)
  })
  return rows.map(toLpPosition)
}

export function toLpPosition(r: any): LpPosition {
  return {
    id: r.id as string | undefined,
    lpEntityId: r.lp_entity_id as string,
    asOfDate: r.as_of_date as string,
    commitment: r.commitment == null ? null : Number(r.commitment),
    calledCapital: r.called_capital == null ? null : Number(r.called_capital),
    distributions: r.distributions == null ? null : Number(r.distributions),
    nav: r.nav == null ? null : Number(r.nav),
    irr: r.irr == null ? null : Number(r.irr),
  }
}

/**
 * Batch-load dated positions for MANY vehicles: one `vehicle_id IN (...)` query, grouped by
 * vehicle_id. Lets the report paths read every tracking vehicle's positions in one round-trip
 * instead of one per vehicle (and per consumer). Each slice matches `loadPositions`'s output.
 */
export async function loadPositionsBatch(
  admin: SupabaseClient,
  fundId: string,
  vehicleIds: string[],
  asOf?: string
): Promise<Map<string, LpPosition[]>> {
  const out = new Map<string, LpPosition[]>()
  if (vehicleIds.length === 0) return out
  for (const id of vehicleIds) out.set(id, [])
  // Paged for the same reason as loadPositions: one query across every vehicle passes the cap fastest.
  const rows = await fetchAllRows<any>((from, to) => {
    let q = admin
      .from('lp_positions' as any)
      .select('id, lp_entity_id, as_of_date, commitment, called_capital, distributions, nav, irr, vehicle_id')
      .eq('fund_id', fundId)
      .in('vehicle_id', vehicleIds)
    if (asOf) q = q.lte('as_of_date', asOf)
    return q.order('id').range(from, to)
  })
  for (const r of rows) out.get(r.vehicle_id)?.push(toLpPosition(r))
  return out
}

/** Latest position per entity from a preloaded slice — same reduction as `latestPositionIrr`. */
export function latestPositionIrrFrom(positions: LpPosition[]): Map<string, number> {
  const latest = new Map<string, LpPosition>()
  for (const p of positions) {
    const cur = latest.get(p.lpEntityId)
    if (!cur || p.asOfDate.localeCompare(cur.asOfDate) > 0) latest.set(p.lpEntityId, p)
  }
  const out = new Map<string, number>()
  for (const [id, p] of Array.from(latest.entries())) if (p.irr != null) out.set(id, p.irr)
  return out
}

/** Latest commitment per entity from a preloaded slice — same reduction as `commitmentsFromPositions`. */
export function commitmentsFromPositionsList(positions: LpPosition[]): Map<string, number> {
  const latest = new Map<string, LpPosition>()
  for (const p of positions) {
    const cur = latest.get(p.lpEntityId)
    if (!cur || p.asOfDate.localeCompare(cur.asOfDate) > 0) latest.set(p.lpEntityId, p)
  }
  const out = new Map<string, number>()
  for (const [id, p] of Array.from(latest.entries())) if (p.commitment != null) out.set(id, roundCents(p.commitment))
  return out
}

/**
 * Each entity's stored IRR from its most recent position on-or-before `asOf`. Only entities that
 * actually have a stored IRR appear. Read paths prefer this over the derived IRR — a single-date
 * cutover has no time spread to imply one, so the pasted figure is what we can show.
 */
export async function latestPositionIrr(
  admin: SupabaseClient,
  fundId: string,
  group: string,
  asOf?: string,
  idMap?: VehicleIdMap,
  positions?: LpPosition[]
): Promise<Map<string, number>> {
  return latestPositionIrrFrom(positions ?? await loadPositions(admin, fundId, group, asOf, idMap))
}

/** The tracking producer: dated positions → CapitalPosting[]. Wired into loadCapitalPostings.
 *  Pass `positions` (a preloaded slice) to skip the query. */
export async function loadPositionPostings(
  admin: SupabaseClient,
  fundId: string,
  group: string,
  asOf?: string,
  idMap?: VehicleIdMap,
  positions?: LpPosition[]
): Promise<CapitalPosting[]> {
  return positionsToPostings(positions ?? await loadPositions(admin, fundId, group, asOf, idMap))
}

/** Each entity's latest commitment, from its most recent position on-or-before `asOf`. */
export async function commitmentsFromPositions(
  admin: SupabaseClient,
  fundId: string,
  group: string,
  asOf?: string,
  idMap?: VehicleIdMap,
  positions?: LpPosition[]
): Promise<Map<string, number>> {
  return commitmentsFromPositionsList(positions ?? await loadPositions(admin, fundId, group, asOf, idMap))
}

/** The distinct as-of dates a vehicle has positions for, ascending — the record over time. */
export async function positionDates(
  admin: SupabaseClient,
  fundId: string,
  group: string
): Promise<string[]> {
  const positions = await loadPositions(admin, fundId, group)
  return Array.from(new Set(positions.map(p => p.asOfDate))).sort()
}

/**
 * When a vehicle's LP capital data was last updated — for the "data as of" footnote on
 * reports. Source-aware: the latest dated position for a tracking vehicle, the latest posted
 * journal entry for a ledger one. Null when the vehicle has no data yet.
 *
 * This matters most on an AGGREGATED report spanning many vehicles, where some are updated
 * every quarter and others only sporadically — so the footnote states it PER VEHICLE rather
 * than implying one report-wide "as of".
 */
export async function lastDataDate(
  admin: SupabaseClient,
  fundId: string,
  group: string
): Promise<string | null> {
  // Use the dates of the resolved figures, not the latest unrelated accounting activity.
  const { loadCapitalPostings } = await import('./capital-source')
  const resolved = await loadCapitalPostings(admin, fundId, group)
  const dates = Array.from(resolved.evidenceByLp.values()).map(e => e.asOf).filter((d): d is string => !!d).sort()
  return dates[0] ?? null

}

/** Last-updated date per vehicle NAME, for a report spanning several vehicles. */
export async function lastDataDates(
  admin: SupabaseClient,
  fundId: string,
  groups: string[]
): Promise<Map<string, string | null>> {
  const out = new Map<string, string | null>()
  await Promise.all(groups.map(async g => { out.set(g, await lastDataDate(admin, fundId, g)) }))
  return out
}

/** Separate freshness dimensions; a new expense does not revalue an LP statement. */
export async function dataDates(admin: SupabaseClient, fundId: string, group: string) {
  const vehicleId = await vehicleIdByName(admin, fundId, group)
  const [positions, entries, periods] = await Promise.all([
    admin.from('lp_positions' as any).select('as_of_date').eq('fund_id', fundId).eq('vehicle_id', vehicleId).order('as_of_date', { ascending: false }).limit(1).maybeSingle(),
    admin.from('journal_entries' as any).select('entry_date').eq('book', ACTUAL_BOOK).eq('fund_id', fundId).eq('vehicle_id', vehicleId).eq('status', 'posted').order('entry_date', { ascending: false }).limit(1).maybeSingle(),
    admin.from('fiscal_periods' as any).select('period_end').eq('fund_id', fundId).eq('vehicle_id', vehicleId).eq('status', 'closed').order('period_end', { ascending: false }).limit(1).maybeSingle(),
  ])
  for (const result of [positions, entries, periods]) if (result.error) throw result.error
  return { reportedAsOf: (positions.data as any)?.as_of_date ?? null, bookActivityThrough: (entries.data as any)?.entry_date ?? null, closedThrough: (periods.data as any)?.period_end ?? null }
}
