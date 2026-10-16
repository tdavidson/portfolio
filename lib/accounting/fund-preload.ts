import type { OpeningLink, ReviewedPeriod } from './capital-evidence'
import type { SupabaseClient } from '@supabase/supabase-js'
import { currentOwnership, loadLedgerRowsBatch, type InvestmentRow, type Ownership, type LedgerRows } from './load'
import { loadPositionsBatch, type LpPosition } from './lp-positions'
import { loadCommitmentEventsBatch, type CommitmentEvent } from './terms'
import type { VehicleIdMap } from './vehicle-id'
import { loadOpeningLinksBatch, type CapitalSource, type VehicleCapitalPreload } from './capital-source'

/**
 * One fund-wide read of the lookups the report paths otherwise re-run once PER VEHICLE.
 *
 * `/funds` (`fundEconomics`) and `/lps` (`generateLiveReport`) derive every vehicle's LP capital
 * on each request, and the per-vehicle loaders (`loadOwnership`, `loadEntityNames`,
 * `loadEntityClasses`, `loadVintage`) each issue their own query for every
 * vehicle — so a 20-vehicle fund pays ~6× that in round-trips before any ledger row is read.
 * This loads all of it in one batch of fund-scoped queries, grouped in memory by vehicle or
 * entity, so the orchestrators can hand each vehicle its slice. Nothing here changes a result;
 * it only removes round-trips (the per-vehicle loaders remain, for callers that don't preload).
 */
export interface FundPreload {
  idMap: VehicleIdMap
  /** entity id → display name (every entity in the fund). */
  entityNames: Map<string, string>
  /** entity id → partner_class ('lp' | 'gp' | …). */
  entityClasses: Map<string, string>
  /** portfolio_group → current ownership, already reduced through `currentOwnership`. */
  ownershipByGroup: Map<string, Ownership[]>
  /** vehicle_id → capital source ('ledger' | 'events'). Absent ⇒ 'events' (the default). */
  closedThroughByVehicleId: Map<string, string>
  reviewedPeriodsByVehicleId?: Map<string, ReviewedPeriod[]>
  /** vehicle name → stated vintage year (or null). */
  vintageByName: Map<string, number | null>
  /** vehicle_id → its posted-ledger raw rows (batched). Present when `asOf`-scoped loads ran. */
  ledgerByVehicleId: Map<string, LedgerRows>
  /** vehicle_id → its dated positions (batched). */
  positionsByVehicleId: Map<string, LpPosition[]>
  /** Which statement observation each vehicle's opening entries represent. */
  openingLinksByVehicleId: Map<string, OpeningLink[]>
  /** vehicle_id → its commitment events, oldest first (batched). */
  commitmentEventsByVehicleId: Map<string, CommitmentEvent[]>
}

export async function loadFundPreload(admin: SupabaseClient, fundId: string, asOf?: string, groups?: string[]): Promise<FundPreload> {
  const [vehRes, entRes, invRes, periodRes] = await Promise.all([
    (admin as any).from('fund_vehicles').select('id, name, aliases, vintage_year').eq('fund_id', fundId),
    (admin as any).from('lp_entities').select('id, entity_name, partner_class').eq('fund_id', fundId),
    (admin as any).from('lp_investments')
      .select('entity_id, portfolio_group, commitment, paid_in_capital, distributions, snapshot_id, updated_at, lp_snapshots(as_of_date, created_at)')
      .eq('fund_id', fundId),
    (admin as any).from('fiscal_periods').select('vehicle_id, period_start, period_end').eq('fund_id', fundId).eq('status', 'closed'),
  ])

  // fund_vehicles → idMap (name + aliases) and vintage, from the one read.
  const idMap: VehicleIdMap = new Map()
  const vintageByName = new Map<string, number | null>()
  for (const v of ((vehRes.data as any[]) ?? [])) {
    if (v.name) {
      idMap.set(v.name as string, v.id as string)
      vintageByName.set(v.name as string, v.vintage_year == null ? null : Number(v.vintage_year))
    }
    for (const a of ((v.aliases as string[] | null) ?? [])) if (a && !idMap.has(a)) idMap.set(a, v.id as string)
  }

  const entityNames = new Map<string, string>()
  const entityClasses = new Map<string, string>()
  for (const e of ((entRes.data as any[]) ?? [])) {
    entityNames.set(e.id as string, (e.entity_name ?? e.id) as string)
    entityClasses.set(e.id as string, (e.partner_class ?? 'lp') as string)
  }

  // lp_investments grouped by portfolio_group, each group reduced to current ownership.
  const invByGroup = new Map<string, InvestmentRow[]>()
  for (const r of ((invRes.data as any[]) ?? [])) {
    const g = r.portfolio_group as string
    if (!g) continue
    const list = invByGroup.get(g) ?? []
    list.push(r as InvestmentRow)
    invByGroup.set(g, list)
  }
  const ownershipByGroup = new Map<string, Ownership[]>()
  for (const [g, rows] of Array.from(invByGroup.entries())) ownershipByGroup.set(g, currentOwnership(rows))

  const reviewedPeriodsByVehicleId = new Map<string, ReviewedPeriod[]>()
  const closedThroughByVehicleId = new Map<string, string>()
  if (periodRes.error) throw periodRes.error
  for (const row of periodRes.data ?? []) {
    const periods = reviewedPeriodsByVehicleId.get(row.vehicle_id) ?? []
    if (row.period_start && row.period_end) periods.push({ start: row.period_start, end: row.period_end })
    reviewedPeriodsByVehicleId.set(row.vehicle_id, periods)
    const previous = closedThroughByVehicleId.get(row.vehicle_id)
    if (!previous || row.period_end > previous) closedThroughByVehicleId.set(row.vehicle_id, row.period_end)
  }

  // The heavy per-vehicle data, batched once by `vehicle_id IN (...)` now that the id set is
  // known. Ledger vehicles have journal rows and no positions; tracking vehicles the reverse —
  // an IN(...) query simply returns rows only for those that have them, so we load both for all.
  const vehicleIds = Array.from(new Set(groups === undefined
    ? idMap.values()
    : groups.flatMap(group => { const id = idMap.get(group); return id ? [id] : [] })))
  const [ledgerByVehicleId, positionsByVehicleId, commitmentEventsByVehicleId, openingLinksByVehicleId] = await Promise.all([
    loadLedgerRowsBatch(admin, fundId, vehicleIds, asOf),
    loadPositionsBatch(admin, fundId, vehicleIds, asOf),
    loadCommitmentEventsBatch(admin, fundId, vehicleIds),
    loadOpeningLinksBatch(admin, fundId, vehicleIds),
  ])

  return { idMap, entityNames, entityClasses, ownershipByGroup, closedThroughByVehicleId, reviewedPeriodsByVehicleId, vintageByName, ledgerByVehicleId, positionsByVehicleId, commitmentEventsByVehicleId, openingLinksByVehicleId }
}

/** A group's preloaded commitment events (empty if none / not in the id map). */
export function commitmentEventsForGroup(preload: FundPreload, group: string): CommitmentEvent[] {
  const vehicleId = preload.idMap.get(group)
  return (vehicleId ? preload.commitmentEventsByVehicleId.get(vehicleId) : undefined) ?? []
}

/** The per-vehicle capital inputs (source + batched ledger rows + batched positions) for a group,
 *  as the bundle `loadCapitalPostings` accepts — so it runs without any per-vehicle query. */
export function vehicleCapitalPreload(preload: FundPreload, group: string): VehicleCapitalPreload {
  const vehicleId = preload.idMap.get(group)
  return {
    reviewedPeriods: preload.reviewedPeriodsByVehicleId ? (vehicleId ? preload.reviewedPeriodsByVehicleId.get(vehicleId) ?? [] : []) : undefined,
    closedThrough: vehicleId ? preload.closedThroughByVehicleId.get(vehicleId) ?? null : null,
    ledgerRows: vehicleId ? preload.ledgerByVehicleId.get(vehicleId) : undefined,
    positions: vehicleId ? preload.positionsByVehicleId.get(vehicleId) : undefined,
    openingLinks: vehicleId ? preload.openingLinksByVehicleId?.get(vehicleId) ?? [] : [],
  }
}
