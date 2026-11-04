// Unified capital reads. Source labels describe evidence; they never enable accounting.
import type { SupabaseClient } from '@supabase/supabase-js'
import type { CapitalPosting } from './capital-account'
import { loadPostedLedger, type LedgerRows, type LoadedLedger } from './load'
import { vehicleIdByName, type VehicleIdMap } from './vehicle-id'
import { RECEIVABLE_CODE } from './chart'
import { roundCents } from './ledger'
import { loadPositions, type LpPosition } from './lp-positions'

import { resolveCapitalEvidence, type CapitalEvidence, type OpeningLink, type ReviewedPeriod } from './capital-evidence'

/** Data provenance, never a feature or write gate. */
export type CapitalSource = 'ledger' | 'events' | 'mixed'

export interface VehicleCapital {
  source: CapitalSource
  postings: CapitalPosting[]
  evidenceByLp: Map<string, CapitalEvidence>
  /**
   * Per-LP balance on the "Due from LPs" receivable (1300) — capital that has been CALLED
   * but not yet WIRED. `funded = called - receivable`.
   *
   * An absent receivable is not evidence of zero when capital comes from a statement.
   * Consumers use per-partner evidence to distinguish unsupported receipts from zero.
   */
  receivableByLp: Map<string, number>
}

/** Per-LP balance on the receivable account. Pure, so the ledger is loaded only once. */
export function receivablesFromLedger(
  accounts: { id: string; code: string }[],
  postings: { accountId: string; amount: number; lpEntityId?: string | null }[]
): Map<string, number> {
  const out = new Map<string, number>()
  const receivable = accounts.find(a => a.code === RECEIVABLE_CODE)
  if (!receivable) return out
  for (const p of postings) {
    if (p.accountId !== receivable.id || !p.lpEntityId) continue
    out.set(p.lpEntityId, roundCents((out.get(p.lpEntityId) ?? 0) + p.amount))
  }
  return out
}

/**
 * A vehicle's LP capital data, from whichever producer it uses. This is what an LP-capital
 * consumer should call instead of reaching for `loadPostedLedger` directly — doing so is
 * exactly what limits a report to booked vehicles only.
 *
 * `asOf` (ISO date, inclusive) scopes to activity on or before that date, so a report can
 * be generated as of any point in time from either source.
 */
/**
 * Preloaded per-vehicle inputs (from a FundPreload) that let `loadCapitalPostings` skip its
 * queries: the resolved capital `source`, the batched ledger `ledgerRows`, and the batched
 * `positions`. Any subset may be present; a missing piece falls back to a query.
 */
export interface VehicleCapitalPreload {
  source?: CapitalSource
  ledgerRows?: LedgerRows
  /** The vehicle's ledger, already loaded through `asOf`: used as is instead of reading it again. */
  ledger?: LoadedLedger
  positions?: LpPosition[]
  closedThrough?: string | null
  reviewedPeriods?: ReviewedPeriod[]
  openingLinks?: OpeningLink[]
}

/**
 * Which statement observations this vehicle's opening entries represent.
 *
 * Service-role only (`capital_opening_links`), like the settlement reviews: the rows name partners
 * and their capital, and the only reader is this resolver running behind a gated route.
 */
export async function loadOpeningLinks(
  admin: SupabaseClient,
  fundId: string,
  vehicleId: string | null,
): Promise<OpeningLink[]> {
  if (!vehicleId) return []
  const { data, error } = await (admin as any)
    .from('capital_opening_links')
    .select('lp_entity_id, position_id, journal_entry_id, observed_on, observed_nav, booked_amount')
    .eq('fund_id', fundId).eq('vehicle_id', vehicleId)
  if (error) throw error
  return ((data as any[]) ?? []).map(row => ({
    lpEntityId: row.lp_entity_id as string,
    positionId: row.position_id as string,
    entryId: row.journal_entry_id as string,
    observedOn: row.observed_on as string,
    observedNav: row.observed_nav == null ? null : Number(row.observed_nav),
    bookedAmount: Number(row.booked_amount),
  }))
}

/** Every vehicle's opening links in one query, for the batched fund preload. */
export async function loadOpeningLinksBatch(
  admin: SupabaseClient,
  fundId: string,
  vehicleIds: string[],
): Promise<Map<string, OpeningLink[]>> {
  const out = new Map<string, OpeningLink[]>()
  for (const id of vehicleIds) out.set(id, [])
  if (vehicleIds.length === 0) return out
  const { data, error } = await (admin as any)
    .from('capital_opening_links')
    .select('vehicle_id, lp_entity_id, position_id, journal_entry_id, observed_on, observed_nav, booked_amount')
    .eq('fund_id', fundId).in('vehicle_id', vehicleIds)
  if (error) throw error
  for (const row of ((data as any[]) ?? [])) {
    const list = out.get(row.vehicle_id as string) ?? []
    list.push({
      lpEntityId: row.lp_entity_id as string,
      positionId: row.position_id as string,
      entryId: row.journal_entry_id as string,
      observedOn: row.observed_on as string,
      observedNav: row.observed_nav == null ? null : Number(row.observed_nav),
      bookedAmount: Number(row.booked_amount),
    })
    out.set(row.vehicle_id as string, list)
  }
  return out
}

export async function loadCapitalPostings(
  admin: SupabaseClient,
  fundId: string,
  group: string,
  asOf?: string,
  idMap?: VehicleIdMap,
  pre?: VehicleCapitalPreload
): Promise<VehicleCapital> {
  const vehicleId = await vehicleIdByName(admin, fundId, group, idMap)
  const rows = pre?.ledgerRows && asOf
    ? { ...pre.ledgerRows, entryRows: pre.ledgerRows.entryRows.filter(e => e.entry_date <= asOf) }
    : pre?.ledgerRows
  const [ledger, positions, reviewedPeriods, openingLinks] = await Promise.all([
    pre?.ledger ? Promise.resolve(pre.ledger) : loadPostedLedger(admin, fundId, group, asOf, idMap, rows),
    pre?.positions ? Promise.resolve(pre.positions) : loadPositions(admin, fundId, group, asOf, idMap),
    pre?.reviewedPeriods !== undefined ? Promise.resolve(pre.reviewedPeriods) : pre?.closedThrough !== undefined ? Promise.resolve(undefined) : admin.from('fiscal_periods' as any)
      .select('period_start, period_end').eq('fund_id', fundId).eq('vehicle_id', vehicleId).eq('status', 'closed')
      .then(({ data, error }) => { if (error) throw error; return ((data ?? []) as any[]).map(row => ({ start: row.period_start, end: row.period_end })) }),
    pre?.openingLinks !== undefined ? Promise.resolve(pre.openingLinks) : loadOpeningLinks(admin, fundId, vehicleId),
  ])
  const resolved = resolveCapitalEvidence(ledger.capitalPostings, positions, asOf, pre?.closedThrough, reviewedPeriods, openingLinks)
  const bases = new Set(Array.from(resolved.evidenceByLp.values()).map(e => e.basis))
  const source: CapitalSource = bases.size > 1 ? 'mixed' : bases.has('reported') ? 'events' : 'ledger'
  return { source, ...resolved, receivableByLp: receivablesFromLedger(ledger.accounts, ledger.postings) }
}
