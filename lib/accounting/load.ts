import { cashCapitalSource } from './cash-capital-source'
// Server-side loaders that adapt DB rows into the pure-logic inputs. Kept out of
// the route files so capital-accounts, reconciliation, and statements all derive
// from the same posted-ledger snapshot. Everything is scoped to one vehicle
// (fund_id + portfolio_group).

import type { SupabaseClient } from '@supabase/supabase-js'
import type { Account, AccountType, Posting } from './types'
import type { CapitalPosting } from './capital-account'
import { vehicleIdByName, type VehicleIdMap } from './vehicle-id'
import { ACTUAL_BOOK, type LedgerBook } from './books'
import { MANCO_KIND } from '@/lib/vehicle-kinds'
import { isExternalBookSource } from './quickbooks/sources'

export type SourcedPosting = Posting & { sourceType: string | null; entryId: string; memo: string | null }

/**
 * Fetch every row of a query, paging past PostgREST's 1000-row default cap. A vehicle with more
 * than 1000 journal postings would otherwise load a TRUNCATED ledger — silently producing a false
 * trial-balance imbalance, phantom unallocated income, and a wrong NAV. `make(from, to)` must apply
 * the same filters each page and add `.range(from, to)`.
 */
export async function fetchAllRows<T>(
  make: (from: number, to: number) => PromiseLike<{ data: T[] | null; error: unknown }>,
  page = 1000,
): Promise<T[]> {
  const out: T[] = []
  for (let from = 0; ; from += page) {
    const { data, error } = await make(from, from + page - 1)
    if (error) throw error
    const rows = data ?? []
    out.push(...rows)
    if (rows.length < page) break
  }
  return out
}

export interface LoadedLedger {
  accounts: Account[]
  postings: Posting[]
  capitalPostings: CapitalPosting[]
  /** Every posting tagged with its entry's source_type (for the cash-flow statement). */
  sourcedPostings: SourcedPosting[]
}

/** The three raw row sets a vehicle's ledger is assembled from (chart, entries, postings). */
export interface LedgerRows {
  acctRows: any[]
  entryRows: any[]
  postingRows: any[]
}

/**
 * Batch-load the ledger rows for MANY vehicles at once: one query per table filtered by
 * `vehicle_id IN (...)`, grouped by vehicle_id in memory. This is what lets `/funds` and `/lps`
 * read every vehicle's ledger in 3 round-trips instead of 3× per vehicle. Each vehicle's slice
 * is fed to `assembleLoadedLedger`, identical to the single-vehicle `loadPostedLedger` path.
 */
export async function loadLedgerRowsBatch(
  admin: SupabaseClient,
  fundId: string,
  vehicleIds: string[],
  asOf?: string
): Promise<Map<string, LedgerRows>> {
  const out = new Map<string, LedgerRows>()
  if (vehicleIds.length === 0) return out
  for (const id of vehicleIds) out.set(id, { acctRows: [], entryRows: [], postingRows: [] })

  // Paginated: across many vehicles the posting count easily exceeds the PostgREST 1000-row cap;
  // a truncated batch would break the trial balance for whichever vehicles fell past the cut.
  const [acctRows, entryRows, postingRows] = await Promise.all([
    fetchAllRows((f, t) => admin.from('chart_of_accounts' as any).select('id, code, name, type, subtype, lp_entity_id, company_id, vehicle_id').eq('fund_id', fundId).in('vehicle_id', vehicleIds).range(f, t)),
    fetchAllRows((f, t) => {
      let q = admin.from('journal_entries' as any).select('id, source_type, status, entry_date, memo, vehicle_id').eq('book', ACTUAL_BOOK).eq('fund_id', fundId).in('vehicle_id', vehicleIds).eq('status', 'posted')
      if (asOf) q = q.lte('entry_date', asOf)
      return q.range(f, t)
    }),
    fetchAllRows((f, t) => admin.from('journal_postings' as any).select('journal_entry_id, account_id, amount, currency, lp_entity_id, vehicle_id').eq('book', ACTUAL_BOOK).eq('fund_id', fundId).in('vehicle_id', vehicleIds).range(f, t)),
  ])

  for (const r of (acctRows as any[])) out.get(r.vehicle_id)?.acctRows.push(r)
  for (const r of (entryRows as any[])) out.get(r.vehicle_id)?.entryRows.push(r)
  for (const r of (postingRows as any[])) out.get(r.vehicle_id)?.postingRows.push(r)
  return out
}

/** Assemble a vehicle's LoadedLedger from its raw rows. Pure — the same reduction whether the
 *  rows came from a single-vehicle query or a batched `vehicle_id IN (...)` slice. */
export function assembleLoadedLedger(fundId: string, rows: LedgerRows): LoadedLedger {
  const { acctRows, entryRows, postingRows } = rows
  const accounts: Account[] = (acctRows ?? []).map(a => ({
    id: a.id,
    fundId,
    code: a.code,
    name: a.name,
    type: a.type as AccountType,
    subtype: a.subtype ?? null,
    lpEntityId: a.lp_entity_id ?? null,
    companyId: a.company_id ?? null,
  }))

  const sourceByEntry = new Map<string, string | null>(
    ((entryRows as any[]) ?? []).map(e => [e.id as string, (e.source_type ?? null) as string | null])
  )
  const dateByEntry = new Map<string, string | null>(
    ((entryRows as any[]) ?? []).map(e => [e.id as string, (e.entry_date ?? null) as string | null])
  )
  const memoByEntry = new Map<string, string | null>(
    ((entryRows as any[]) ?? []).map(e => [e.id as string, (e.memo ?? null) as string | null])
  )

  // LP capital accounts carry lp_entity_id on the account itself. Only postings to
  // THOSE accounts belong in the capital-account roll-forward — a posting can also
  // carry an lp_entity_id on a non-capital account (e.g. the per-LP capital-call
  // receivable), which must not be mistaken for a capital movement.
  const lpCapitalAccountIds = new Set(accounts.filter(a => a.lpEntityId).map(a => a.id))

  // Import provenance stays "quickbooks" (or "carta", sources.ts) on the journal. For the LP roll-forward,
  // classify only simple cash/capital exchanges; non-cash and mixed adjustments
  // remain unclassified rather than presenting an accrual as incoming cash.
  const qbCashActivity = new Map<string, string>()
  const qbSplits = new Map<string, any[]>()
  for (const p of postingRows ?? []) {
    if (!isExternalBookSource(sourceByEntry.get(p.journal_entry_id))) continue
    const splits = qbSplits.get(p.journal_entry_id) ?? []
    splits.push(p)
    qbSplits.set(p.journal_entry_id, splits)
  }
  for (const [id, splits] of qbSplits) {
    const source = cashCapitalSource(splits.map(p => ({ accountId: p.account_id, amount: Number(p.amount) })), accounts)
    if (source) qbCashActivity.set(id, source)
  }

  const postings: Posting[] = []
  const capitalPostings: CapitalPosting[] = []
  const sourcedPostings: SourcedPosting[] = []
  for (const p of ((postingRows as any[]) ?? [])) {
    if (!sourceByEntry.has(p.journal_entry_id)) continue
    const amount = Number(p.amount)
    const sourceType = sourceByEntry.get(p.journal_entry_id) ?? null
    const entryDate = dateByEntry.get(p.journal_entry_id) ?? null
    postings.push({ accountId: p.account_id, amount, currency: p.currency ?? 'USD', lpEntityId: p.lp_entity_id ?? null, entryDate })
    sourcedPostings.push({ entryId: p.journal_entry_id, accountId: p.account_id, amount, currency: p.currency ?? 'USD', lpEntityId: p.lp_entity_id ?? null, sourceType, entryDate, memo: memoByEntry.get(p.journal_entry_id) ?? null })
    if (p.lp_entity_id && lpCapitalAccountIds.has(p.account_id)) {
      capitalPostings.push({ entryId: p.journal_entry_id, currency: p.currency, lpEntityId: p.lp_entity_id, amount, sourceType: qbCashActivity.get(p.journal_entry_id) ?? sourceType, entryDate })
    }
  }

  return { accounts, postings, capitalPostings, sourcedPostings }
}

/**
 * Load one vehicle's chart of accounts and every posting on a POSTED journal entry
 * (drafts and voids excluded). Pass `asOf` (ISO date) to include only entries on or before
 * that date. Pass `rows` (a slice from `loadLedgerRowsBatch`) to assemble from pre-batched
 * rows and skip the queries — the report paths do this to avoid 3 queries per vehicle.
 */
/** Chart-only register landing: no journal history is needed until an account is selected. */
export async function loadLedgerChart(admin: SupabaseClient, fundId: string, group: string) {
  const vehicleId = await vehicleIdByName(admin, fundId, group)
  const acctRows = await fetchAllRows<any>((f, t) => admin.from('chart_of_accounts' as any)
    .select('id, code, name, type, subtype, lp_entity_id, company_id')
    .eq('fund_id', fundId).eq('vehicle_id', vehicleId).order('id').range(f, t))
  return assembleLoadedLedger(fundId, { acctRows, entryRows: [], postingRows: [] }).accounts
}

export async function loadPostedLedger(
  admin: SupabaseClient,
  fundId: string,
  group: string,
  asOf?: string,
  idMap?: VehicleIdMap,
  rows?: LedgerRows,
  /**
   * Which books. The actual book alone by default — the answer every statement, close and
   * reconciliation wants. `['actual', 'tax']` reads on a TAX BASIS: the real ledger plus the
   * book-to-tax overlay, spliced here at read time, never stored. See books.ts.
   */
  books: LedgerBook[] = [ACTUAL_BOOK],
): Promise<LoadedLedger> {
  if (rows) return assembleLoadedLedger(fundId, rows)
  const vehicleId = await vehicleIdByName(admin, fundId, group, idMap)
  // entry_date rides along so the capital-account roll-forward can be scoped to a
  // statement period without a second load.
  // Paginated: a vehicle can hold more than 1000 postings (and a big chart / many entries), which
  // the PostgREST default would silently truncate — a truncated ledger fails the trial balance.
  const [acctRows, entryRows, postingRows] = await Promise.all([
    fetchAllRows((f, t) => admin.from('chart_of_accounts' as any).select('id, code, name, type, subtype, lp_entity_id, company_id').eq('fund_id', fundId).eq('vehicle_id', vehicleId).range(f, t)),
    fetchAllRows((f, t) => {
      let q = admin.from('journal_entries' as any).select('id, source_type, status, entry_date, memo').in('book', books).eq('fund_id', fundId).eq('vehicle_id', vehicleId).eq('status', 'posted')
      if (asOf) q = q.lte('entry_date', asOf)
      return q.range(f, t)
    }),
    fetchAllRows((f, t) => admin.from('journal_postings' as any).select('journal_entry_id, account_id, amount, currency, lp_entity_id').in('book', books).eq('fund_id', fundId).eq('vehicle_id', vehicleId).range(f, t)),
  ])
  return assembleLoadedLedger(fundId, {
    acctRows: acctRows as any[],
    entryRows: entryRows as any[],
    postingRows: postingRows as any[],
  })
}

/** Names for the vehicle's LP entities (those with a commitment in this group). */
export async function loadEntityNames(
  admin: SupabaseClient,
  fundId: string,
  group: string
): Promise<Map<string, string>> {
  // Paged: lp_investments holds one row per LP per SNAPSHOT, so a vehicle passes 1000 rows long
  // before it has 1000 partners — and the partners past the cap would vanish from every list.
  const inv = await fetchAllRows<any>((f, t) => admin.from('lp_investments' as any).select('id, entity_id').eq('fund_id', fundId).eq('portfolio_group', group).order('id').range(f, t))
  const entityIds = Array.from(new Set(inv.map(r => r.entity_id)))
  const out = new Map<string, string>()
  if (entityIds.length === 0) return out

  const data = await fetchAllRows<any>((f, t) => admin.from('lp_entities' as any).select('id, entity_name').in('id', entityIds).order('id').range(f, t))
  for (const e of data) out.set(e.id, e.entity_name ?? e.id)
  return out
}

/** entity_id → partner class ('lp' | 'gp') for the entities in this vehicle. */
export async function loadEntityClasses(
  admin: SupabaseClient,
  fundId: string,
  group: string
): Promise<Map<string, string>> {
  const inv = await fetchAllRows<any>((f, t) => admin.from('lp_investments' as any).select('id, entity_id').eq('fund_id', fundId).eq('portfolio_group', group).order('id').range(f, t))
  const ids = Array.from(new Set(inv.map(r => r.entity_id)))
  const out = new Map<string, string>()
  if (ids.length === 0) return out
  const data = await fetchAllRows<any>((f, t) => admin.from('lp_entities' as any).select('id, partner_class').in('id', ids).order('id').range(f, t))
  for (const e of data) out.set(e.id, (e.partner_class as string) ?? 'lp')
  return out
}

/**
 * Committed capital per LP entity in this vehicle — the pro-rata basis for the
 * allocation engine and opening balances.
 *
 * `lp_investments` is unique per (fund, entity, group, SNAPSHOT) — one row per LP per
 * snapshot, each carrying that snapshot's cumulative-to-date figures. So these rows
 * must be DEDUPED to a single snapshot, never summed: summing multiplies every
 * commitment by the snapshot count, and paid-in/distributions (already cumulative)
 * even more obviously. We take the row from the latest snapshot by `as_of_date`,
 * matching how the LP portal picks a snapshot (lib/lp-overview.ts).
 *
 * Rows with no snapshot (the manual /api/lps/investments POST path, and the accounting
 * Add-LP path when the fund has no snapshots yet) are a fallback: used only for an
 * entity that has no snapshotted row at all, most-recently-updated first.
 */
export async function loadOwnership(
  admin: SupabaseClient,
  fundId: string,
  group: string
): Promise<Ownership[]> {
  // Paged (one row per LP per snapshot — see loadEntityNames): past the cap, partners dropped out
  // of the allocation basis with no error.
  const data = await fetchAllRows<any>((f, t) => admin
    .from('lp_investments' as any)
    .select('id, entity_id, commitment, paid_in_capital, distributions, snapshot_id, updated_at, lp_snapshots(as_of_date, created_at)')
    .eq('fund_id', fundId)
    .eq('portfolio_group', group)
    .order('id')
    .range(f, t))
  return currentOwnership(data as InvestmentRow[])
}

export interface Ownership {
  lpEntityId: string
  commitment: number
  paidIn: number
  distributions: number
}

/** The `lp_investments` shape `currentOwnership` needs. Supabase nests the joined
 *  snapshot as either an object or a single-element array depending on the query. */
export interface InvestmentRow {
  entity_id: string
  commitment?: number | null
  paid_in_capital?: number | null
  distributions?: number | null
  snapshot_id?: string | null
  updated_at?: string | null
  lp_snapshots?: { as_of_date?: string | null; created_at?: string | null } | { as_of_date?: string | null; created_at?: string | null }[] | null
}

/**
 * Collapse many `lp_investments` rows (one per snapshot) to one row per LP entity.
 *
 * Pure, and exported for the tests: picking the wrong row here misstates every
 * commitment-weighted number in the module, so it earns direct coverage.
 */
export function currentOwnership(rows: InvestmentRow[]): Ownership[] {
  return latestInvestmentRows(rows).map(row => ({
    lpEntityId: row.entity_id,
    commitment: Number(row.commitment ?? 0),
    paidIn: Number(row.paid_in_capital ?? 0),
    distributions: Number(row.distributions ?? 0),
  }))
}

/**
 * One `lp_investments` row per key (default: per LP entity), by the same rule as
 * `currentOwnership`. Readers that span vehicles key on entity and `portfolio_group`, so an
 * LP in two vehicles keeps one row in each.
 */
export function latestInvestmentRows<T extends InvestmentRow>(rows: T[], keyOf: (row: T) => string = row => row.entity_id): T[] {
  // A snapshotted row always beats an unsnapshotted one; among snapshotted rows the
  // greatest as_of_date wins, with created_at breaking ties on same-dated snapshots.
  const rank = (row: InvestmentRow): [number, string, string] => {
    const s = row.lp_snapshots
    const snap = Array.isArray(s) ? s[0] : s
    if (!row.snapshot_id || !snap) return [0, '', String(row.updated_at ?? '')]
    return [1, String(snap.as_of_date ?? ''), String(snap.created_at ?? '')]
  }
  const beats = (a: InvestmentRow, b: InvestmentRow): boolean => {
    const [ax, ay, az] = rank(a)
    const [bx, by, bz] = rank(b)
    if (ax !== bx) return ax > bx
    if (ay !== by) return ay > by
    return az > bz
  }

  const byKey = new Map<string, T>()
  for (const row of rows) {
    const key = keyOf(row)
    const cur = byKey.get(key)
    if (!cur || beats(row, cur)) byKey.set(key, row)
  }
  return Array.from(byKey.values())
}

/**
 * Distinct INVESTMENT vehicles (portfolio_groups) for a fund, from LP + cash-flow data.
 *
 * Management companies are excluded, here and in `listVehiclesWithId`, and that exclusion is the
 * reason both functions are the single source for the fund switcher, the accounting vehicle picker
 * and `fundEconomics`. A manco has no commitments, no NAV, no TVPI and no partners: on the fund
 * overview it is a row of dashes, in the switcher it is an option that takes you to a page with
 * nothing on it, and in a per-vehicle performance roll-up it is a vehicle whose every metric is
 * undefined. It has its own list (`listMancoVehicles`) and its own grant.
 *
 * This filters on the REGISTRY, so a legacy portfolio_group string with no `fund_vehicles` row is
 * unaffected — it cannot be a management company, because being one requires being set up as one.
 */
export async function listVehicles(admin: SupabaseClient, fundId: string): Promise<string[]> {
  // Source of truth: the fund_vehicles registry (active vehicles).
  const { data: vrows } = await admin
    .from('fund_vehicles' as any)
    .select('name')
    .eq('fund_id', fundId)
    .eq('active', true)
    .neq('kind', MANCO_KIND)
    .order('name')
  const names = ((vrows as any[]) ?? []).map(r => r.name as string).filter(Boolean)
  if (names.length > 0) return names

  // Fallback for funds not yet migrated into the registry: the legacy union of
  // distinct portfolio_group strings across the vehicle-scoped tables.
  const [{ data: inv }, { data: cfg }, { data: cf }] = await Promise.all([
    admin.from('lp_investments' as any).select('portfolio_group').eq('fund_id', fundId),
    admin.from('fund_group_config' as any).select('portfolio_group').eq('fund_id', fundId),
    admin.from('fund_cash_flows' as any).select('portfolio_group').eq('fund_id', fundId),
  ])
  const set = new Set<string>()
  for (const rows of [inv, cfg, cf]) for (const r of ((rows as any[]) ?? [])) if (r.portfolio_group) set.add(r.portfolio_group)
  return Array.from(set).sort()
}

/**
 * Distinct vehicles WITH their registry id, for the fund switcher and the sidebar's
 * fund-first links. Same source and ordering as `listVehicles`, but each entry carries
 * `id` (null for a legacy portfolio_group-only vehicle, which the URL routes on by name).
 */
export async function listVehiclesWithId(admin: SupabaseClient, fundId: string): Promise<{ name: string; id: string | null; kind: string | null }[]> {
  const { data: vrows } = await admin
    .from('fund_vehicles' as any)
    .select('id, name, kind')
    .eq('fund_id', fundId)
    .eq('active', true)
    .neq('kind', MANCO_KIND)
    .order('name')
  const rows = ((vrows as any[]) ?? []).filter(r => r.name)
  // `kind` rides along so the nav can hide the pages a kind has no use for (an individual has
  // no capital accounts; a GP entity has no portfolio to construct). See lib/accounting/nav.ts.
  if (rows.length > 0) return rows.map(r => ({ name: r.name as string, id: (r.id as string) ?? null, kind: (r.kind as string) ?? null }))

  // Legacy funds not yet in the registry — names only, no id, and a fund's pages.
  return (await listVehicles(admin, fundId)).map(name => ({ name, id: null, kind: null }))
}

/**
 * The fund's management companies — the other half of `listVehiclesWithId`, for the entities
 * section's list and switcher.
 *
 * INACTIVE ONES ARE INCLUDED, unlike the investment-vehicle list. A manco is deactivated when the
 * firm winds it down or replaces it, and its books do not stop existing: last year's payroll, the
 * final distributions and the intercompany balances that have to be settled are all still on it,
 * and there is no other way to reach them once it drops out of the list. The caller shows the flag;
 * see components/accounting/firm-vehicles.tsx.
 */
export async function listMancoVehicles(
  admin: SupabaseClient,
  fundId: string,
): Promise<{ id: string; name: string; active: boolean }[]> {
  const { data } = await admin
    .from('fund_vehicles' as any)
    .select('id, name, active')
    .eq('fund_id', fundId)
    .eq('kind', MANCO_KIND)
    .order('active', { ascending: false })
    .order('name')
  return ((data as any[]) ?? [])
    .filter(r => r.name)
    .map(r => ({ id: r.id as string, name: r.name as string, active: !!r.active }))
}
