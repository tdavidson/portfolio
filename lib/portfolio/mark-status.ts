// When each holding was last marked, by what, and whether that is current. One rule for every
// surface that answers "what has been updated": the mark_status and fund_register tools, the
// positions dataset's mark columns, and the holding page's "Last mark" line.
//
// A MARK is anything that re-values a position:
//
//   nav_statement  a manager NAV statement in the fund register (whether or not it booked a
//                  transaction: one dated before the ledger's start date is memo-only, and still
//                  values the holding)
//   nav            a plain value change booked from a manager's NAV (valuation_change_source 'nav')
//                  without a register row. It counts as current exactly as a statement does: the
//                  number came from the same place.
//   price          a market quote (valuation_change_source 'quote')
//   round          a priced round (round_info with a share price)
//   manual         any other value change or price mark
//
// An FX revaluation is not a mark: it restates the same value in the fund's currency.

import type { SupabaseClient } from '@supabase/supabase-js'
import type { AccessContext } from '@/lib/access/effective'
import { scopeCompanyRows, scopeTransactions, visibleVehicleIds } from '@/lib/access/scope'

export type MarkSource = 'nav_statement' | 'nav' | 'manual' | 'round' | 'price'
export type HoldingTypeLabel = 'company' | 'fund' | 'digital_asset'

export interface MarkTxn {
  id: string
  company_id: string
  transaction_type: string
  transaction_date: string | null
  current_share_price?: number | null
  unrealized_value_change?: number | null
  share_price?: number | null
  valuation_change_source?: string | null
  portfolio_group?: string | null
}

export interface NavRow {
  company_id: string
  vehicle_id?: string | null
  as_of_date: string
  reported_nav: number | string | null
  investment_transaction_id?: string | null
}

export interface HoldingMarks {
  lastMarkDate: string | null
  lastMarkSource: MarkSource | null
  lastNavStatementDate: string | null
  lastNavStatementNav: number | null
  /** The first investment's date: a holding bought after the quarter end has nothing to mark yet. */
  firstInvestmentDate: string | null
}

/** The schema's 'crypto' reads as digital_asset outside the database. */
export function holdingTypeLabel(raw: string | null | undefined): HoldingTypeLabel {
  return raw === 'fund' ? 'fund' : raw === 'crypto' ? 'digital_asset' : 'company'
}

/** What kind of mark a transaction is, or null when it marks nothing. */
export function markSourceOf(t: MarkTxn, navTxnIds: ReadonlySet<string>): MarkSource | null {
  if (t.transaction_type === 'round_info') return t.share_price != null ? 'round' : null
  if (t.transaction_type !== 'unrealized_gain_change') return null
  if (t.valuation_change_source === 'fx') return null
  if (navTxnIds.has(t.id)) return 'nav_statement'
  if (t.valuation_change_source === 'nav') return 'nav'
  if (t.valuation_change_source === 'quote') return 'price'
  if (t.current_share_price != null || t.unrealized_value_change != null) return 'manual'
  return null
}

/** The signed value change a mark row booked (the transactions dataset's mark_change). */
export function markChangeOf(t: Pick<MarkTxn, 'transaction_type' | 'unrealized_value_change'>): number | null {
  if (t.transaction_type !== 'unrealized_gain_change' || t.unrealized_value_change == null) return null
  const n = Number(t.unrealized_value_change)
  return Number.isFinite(n) ? n : null
}

/** On one date, the better-evidenced mark wins the label. */
const SOURCE_RANK: Record<MarkSource, number> = { nav_statement: 0, nav: 1, price: 2, round: 3, manual: 4 }

/** Each holding's latest mark of any kind, and its latest NAV statement, on or before `asOf`. */
export function latestMarks(txns: MarkTxn[], navs: NavRow[], asOf?: string): Map<string, HoldingMarks> {
  const out = new Map<string, HoldingMarks>()
  const get = (id: string) => {
    let m = out.get(id)
    if (!m) {
      m = { lastMarkDate: null, lastMarkSource: null, lastNavStatementDate: null, lastNavStatementNav: null, firstInvestmentDate: null }
      out.set(id, m)
    }
    return m
  }
  const consider = (m: HoldingMarks, date: string, source: MarkSource) => {
    if (!m.lastMarkDate || date > m.lastMarkDate || (date === m.lastMarkDate && SOURCE_RANK[source] < SOURCE_RANK[m.lastMarkSource!])) {
      m.lastMarkDate = date
      m.lastMarkSource = source
    }
  }
  const navTxnIds = new Set(navs.map(n => n.investment_transaction_id).filter((id): id is string => !!id))
  for (const t of txns) {
    const date = t.transaction_date ? String(t.transaction_date).slice(0, 10) : null
    if (!date || (asOf && date > asOf)) continue
    const m = get(t.company_id)
    if (t.transaction_type === 'investment' && (!m.firstInvestmentDate || date < m.firstInvestmentDate)) m.firstInvestmentDate = date
    const source = markSourceOf(t, navTxnIds)
    if (source) consider(m, date, source)
  }
  for (const n of navs) {
    const date = String(n.as_of_date).slice(0, 10)
    if (asOf && date > asOf) continue
    const m = get(n.company_id)
    consider(m, date, 'nav_statement')
    if (!m.lastNavStatementDate || date > m.lastNavStatementDate) {
      m.lastNavStatementDate = date
      m.lastNavStatementNav = n.reported_nav == null ? null : Number(n.reported_nav)
    }
  }
  return out
}

/** The latest calendar quarter end on or before `asOf` (YYYY-MM-DD). */
export function lastQuarterEnd(asOf: string): string {
  const [y, mo, d] = asOf.slice(0, 10).split('-').map(Number)
  const ends: [number, number][] = [[3, 31], [6, 30], [9, 30], [12, 31]]
  for (let i = ends.length - 1; i >= 0; i--) {
    const [em, ed] = ends[i]
    if (mo > em || (mo === em && d >= ed)) return `${y}-${String(em).padStart(2, '0')}-${ed}`
  }
  return `${y - 1}-12-31`
}

export function daysBetween(from: string, to: string): number {
  return Math.round((Date.parse(`${to.slice(0, 10)}T00:00:00Z`) - Date.parse(`${from.slice(0, 10)}T00:00:00Z`)) / 86_400_000)
}

export type StaleReason = 'no_mark' | 'before_quarter_end' | 'older_than_max_age'

export interface Staleness {
  stale: boolean
  staleReason: StaleReason | null
  markAgeDays: number | null
  quarterEnd: string
}

/**
 * Whether a holding's mark is current as of `asOf`. By default it is stale when the last mark is
 * before the most recent quarter end; with `maxAgeDays`, when the mark is older than that instead.
 * A holding first bought after the quarter end, never marked since, is carried at cost and current.
 */
export function staleness(m: Pick<HoldingMarks, 'lastMarkDate' | 'firstInvestmentDate'> | undefined, asOf: string, maxAgeDays?: number | null): Staleness {
  const quarterEnd = lastQuarterEnd(asOf)
  const last = m?.lastMarkDate ?? null
  const markAgeDays = last ? daysBetween(last, asOf) : null
  const limit = typeof maxAgeDays === 'number' && Number.isFinite(maxAgeDays) && maxAgeDays >= 0 ? maxAgeDays : null
  if (!last) {
    const newSinceQuarterEnd = !!m?.firstInvestmentDate && (limit !== null
      ? daysBetween(m.firstInvestmentDate, asOf) <= limit
      : m.firstInvestmentDate > quarterEnd)
    return { stale: !newSinceQuarterEnd, staleReason: newSinceQuarterEnd ? null : 'no_mark', markAgeDays, quarterEnd }
  }
  if (limit !== null) {
    const stale = markAgeDays! > limit
    return { stale, staleReason: stale ? 'older_than_max_age' : null, markAgeDays, quarterEnd }
  }
  // A holding bought after its last mark's quarter is still carried at a current cost.
  const stale = last < quarterEnd && !(m?.firstInvestmentDate && m.firstInvestmentDate > quarterEnd)
  return { stale, staleReason: stale ? 'before_quarter_end' : null, markAgeDays, quarterEnd }
}

// ---------------------------------------------------------------------------------------------
// Loading
// ---------------------------------------------------------------------------------------------

const TXN_COLUMNS = 'id, company_id, transaction_type, transaction_date, current_share_price, unrealized_value_change, share_price, valuation_change_source, portfolio_group'

/**
 * The marks for these holdings as this member sees them: their entities' transactions (and
 * untagged company-wide price rows), and NAV statements for their entities. With a vehicle, that
 * entity's rows and the untagged ones only.
 */
export async function loadHoldingMarks(
  admin: SupabaseClient,
  fundId: string,
  companyIds: string[],
  opts: { access: Pick<AccessContext, 'vehicles'>; vehicleNames: string[] | null; vehicle?: string | null; vehicleId?: string | null; asOf?: string },
): Promise<Map<string, HoldingMarks>> {
  if (companyIds.length === 0) return new Map()
  const db = admin as any
  const txns: MarkTxn[] = []
  const navs: NavRow[] = []
  for (let i = 0; i < companyIds.length; i += 200) {
    const ids = companyIds.slice(i, i + 200)
    const [t, n] = await Promise.all([
      db.from('investment_transactions').select(TXN_COLUMNS).eq('fund_id', fundId).in('company_id', ids),
      db.from('fund_nav_statements').select('company_id, vehicle_id, as_of_date, reported_nav, investment_transaction_id')
        .eq('fund_id', fundId).in('company_id', ids),
    ])
    if (t.error) throw new Error(`Marks could not be read: ${t.error.message}`)
    if (n.error) throw new Error(`NAV statements could not be read: ${n.error.message}`)
    txns.push(...((t.data ?? []) as MarkTxn[]))
    navs.push(...((n.data ?? []) as NavRow[]))
  }
  let scopedTxns = scopeTransactions(txns, opts.vehicleNames)
  if (opts.vehicle) scopedTxns = scopedTxns.filter(t => t.portfolio_group === opts.vehicle || !t.portfolio_group)
  let scopedNavs = scopeCompanyRows(navs as (NavRow & Record<string, any>)[], visibleVehicleIds(opts.access), 'vehicle_id')
  if (opts.vehicleId) scopedNavs = scopedNavs.filter(n => n.vehicle_id === opts.vehicleId || n.vehicle_id == null)
  return latestMarks(scopedTxns, scopedNavs, opts.asOf)
}
