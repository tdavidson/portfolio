// Fund growth over time — the time-series behind the /funds/[id] detail page's charts.
//
// Everything here is WHOLE-FUND and derived from the same two producers the rest of the
// section reads:
//
//   • LP capital postings (loadCapitalPostings) — dated, debit-positive deltas to partners'
//     equity accounts, bucketed by source_type. These give the net-of-fund cash flows
//     (called capital, distributions) and the NAV composition (contributions, gains,
//     expenses, …). Summed across EVERY partner, the reallocation buckets — carried interest,
//     transfers, unclassified — net to ~zero, so a whole-fund series leaks none of the GP's
//     economics and needs no gp_economics gate. `ending` NAV is the raw cumulative sum of the
//     deltas, so the composition always ties to the ledger.
//
//   • The portfolio tracker (computeSummary, the canonical roll-up in lib/investments.ts) —
//     re-valued AS OF each period end. This gives the GROSS, deal-level view: capital invested
//     into companies and proceeds returned from them, which is a different thing from the LPs'
//     called capital and distributions.
//
// The grid is quarterly. Each point carries CUMULATIVE (inception-to-period-end) figures so the
// charts read as growth curves rather than per-quarter flows.

import type { SupabaseClient } from '@supabase/supabase-js'
import { roundCents } from './ledger'
import { loadCapitalPostings } from './capital-source'
import { loadFundPreload, vehicleCapitalPreload } from './fund-preload'
import { bucketForSourceType, computeCapitalAccounts } from './capital-account'
import { txnsForVehicle } from './soi'
import { computeSummary } from '@/lib/investments'
import { xirr, type CashFlow } from '@/lib/xirr'
import type { InvestmentTransaction, CompanyStatus } from '@/lib/types/database'

export interface FundTimeseriesPoint {
  /** Quarter-end date (YYYY-MM-DD). */
  period: string
  /** Short label, e.g. "Q1 '24". */
  label: string

  // ── Net, from LP capital accounts (cumulative) ────────────────────────────
  /** Called (paid-in) capital to date. */
  calledCapital: number | null
  /** Capital returned to partners to date (positive). */
  distributed: number | null

  // ── NAV composition (cumulative, signed so the segments sum to `nav`) ──────
  contributions: number | null
  /** Negative — capital returned reduces NAV. */
  distributions: number | null
  operatingIncome: number | null
  realizedGains: number | null
  unrealizedGains: number | null
  /** Negative — management fees + partnership expenses. */
  expenses: number | null
  /** Transfers + FX translation + anything unclassified. Nets to ~0 whole-fund. */
  other: number | null
  /** = sum of the composition segments = ending partners' capital. */
  nav: number | null

  // ── Gross, from the portfolio tracker (cumulative, as of the period) ───────
  /** Capital deployed into companies to date. */
  investedCapital: number
  /** New capital: the first (initial) investment into each company. */
  newInvested: number
  /** Follow-on capital: every investment into a company after the first. */
  followOnInvested: number
  /** Proceeds realized from companies to date. */
  proceeds: number
  /** Carrying value of the portfolio at the period end. */
  portfolioValue: number

  // ── IRR as of the period end (nullable until there are ≥2 dated flows) ─────
  /** Gross (deal-level) IRR: portfolio cash flows + terminal carrying value. */
  grossIrr: number | null
  /** Net IRR to all partners (whole fund). Ledger vehicles only; null otherwise. */
  netIrrFund: number | null
  /** Net IRR to LP-class partners only. Ledger vehicles only; null otherwise. */
  netIrrLp: number | null
}

/** One company's investment rows, narrowed for the new/follow-on split. */
export interface InvTxnLite { date: string | null; cost: number }

/**
 * Classify one company's investment rows into new vs follow-on capital.
 *
 * The first (earliest-dated) investment into a company is NEW capital; every later investment
 * into that same company is FOLLOW-ON. Stable sort, so the classification is deterministic and
 * can be pinned by a test.
 *
 * Exported because two surfaces need the SAME rule: the quarterly series below, and the
 * per-position split in lib/accounting/soi.ts. Two implementations would drift.
 */
export function classifyNewFollowOn<T extends { date: string | null }>(txns: T[]): (T & { isNew: boolean })[] {
  return [...txns]
    .sort((a, b) => (a.date ?? '').localeCompare(b.date ?? ''))
    .map((t, i) => ({ ...t, isNew: i === 0 }))
}

/**
 * Cumulative new vs follow-on capital at each quarter end. The first (earliest-dated) investment
 * into a company is NEW capital; every later investment into that same company is FOLLOW-ON.
 * Pure and deterministic so the classification can be pinned by a test. `cost` must be defined the
 * same way `computeSummary` defines `totalInvested`, so new + follow-on ties to invested capital.
 */
export function buildNewFollowOnSeries(
  companies: InvTxnLite[][],
  quarters: string[],
): { newInvested: number; followOnInvested: number }[] {
  const classified = companies.map(txns => classifyNewFollowOn(txns))
  return quarters.map(q => {
    let newInvested = 0, followOnInvested = 0
    for (const txns of classified) {
      for (const t of txns) {
        if (t.date && t.date > q) continue // not yet deployed as of this quarter
        if (t.isNew) newInvested += t.cost
        else followOnInvested += t.cost
      }
    }
    return { newInvested: r(newInvested), followOnInvested: r(followOnInvested) }
  })
}

export interface FundTimeseries {
  points: FundTimeseriesPoint[]
  /** True once the vehicle holds any tracked investment — drives the gross toggle. */
  hasGross: boolean
}

const r = roundCents

/** Last calendar day of the quarter containing `d`, as YYYY-MM-DD (UTC). */
function quarterEndOf(d: Date): string {
  const y = d.getUTCFullYear()
  const endMonth = Math.floor(d.getUTCMonth() / 3) * 3 + 2 // 2, 5, 8, 11
  return new Date(Date.UTC(y, endMonth + 1, 0)).toISOString().slice(0, 10)
}

function quarterLabel(dateStr: string): string {
  const d = new Date(dateStr + 'T00:00:00Z')
  const q = Math.floor(d.getUTCMonth() / 3) + 1
  return `Q${q} '${String(d.getUTCFullYear()).slice(2)}`
}

/** Every quarter-end from the quarter containing `start` through `end`, inclusive. Capped. */
export function quarterEndsThrough(start: string, end: string): string[] {
  const out: string[] = []
  let cur = quarterEndOf(new Date(start + 'T00:00:00Z'))
  while (cur <= end && out.length < 80) {
    out.push(cur)
    const next = new Date(new Date(cur + 'T00:00:00Z').getTime() + 86_400_000)
    cur = quarterEndOf(next)
  }
  // The reporting date itself may fall mid-quarter — make sure it's represented so the
  // curve ends on "now" rather than on the last completed quarter.
  const endQ = quarterEndOf(new Date(end + 'T00:00:00Z'))
  if (out.length > 0 && out[out.length - 1] !== endQ && endQ > out[out.length - 1] && out.length < 80) {
    out.push(endQ)
  }
  return out
}

/** The capital-account half of a point — everything derivable from LP postings alone. */
export type CapitalSeriesPoint = Omit<
  FundTimeseriesPoint,
  'investedCapital' | 'newInvested' | 'followOnInvested' | 'proceeds' | 'portfolioValue' | 'grossIrr' | 'netIrrFund' | 'netIrrLp'
>

/** A capital posting, narrowed to what the series needs. */
interface SeriesPosting { entryDate?: string | null; sourceType?: string | null; amount: number }

/**
 * The pure capital-account time-series: bucket dated postings into quarters, then roll them
 * forward into cumulative points. DB-free and deterministic, so the bucketing and the NAV
 * tie-out can be pinned by a test. `quarters` are the quarter-end dates to report, in order.
 */
export function buildCapitalSeries(postings: SeriesPosting[], quarters: string[]): { [K in keyof CapitalSeriesPoint]: NonNullable<CapitalSeriesPoint[K]> }[] {
  if (quarters.length === 0) return []

  const zero = () => ({
    contributions: 0, distributions: 0, operatingIncome: 0, realizedGains: 0,
    unrealizedGains: 0, expenses: 0, other: 0,
  })
  const perQuarter = new Map<string, ReturnType<typeof zero>>(quarters.map(q => [q, zero()]))

  // The first quarter-end on or after `date` — the quarter that posting lands in.
  const quarterFor = (date: string): string => {
    for (const q of quarters) if (date <= q) return q
    return quarters[quarters.length - 1] // shouldn't happen (postings are asOf-scoped); clamp anyway
  }

  for (const p of postings) {
    // Undated postings (rare) anchor to the first quarter so they still count toward NAV.
    const bucket = perQuarter.get(quarterFor(p.entryDate ?? quarters[0]))
    if (!bucket) continue
    const delta = -p.amount // credit increases capital
    switch (bucketForSourceType(p.sourceType)) {
      case 'contributions': bucket.contributions += delta; break
      case 'distributions': bucket.distributions += delta; break
      case 'operatingIncome': bucket.operatingIncome += delta; break
      case 'realizedGains': bucket.realizedGains += delta; break
      case 'unrealizedGains': bucket.unrealizedGains += delta; break
      case 'managementFees':
      case 'expenses': bucket.expenses += delta; break
      // beginning/transfers/carriedInterest/fxTranslation/unclassified — reallocations and
      // opening balances that net to ~0 whole-fund. Kept on one line so the stack still ties.
      default: bucket.other += delta; break
    }
  }

  const running = zero()
  return quarters.map(q => {
    const d = perQuarter.get(q)!
    running.contributions += d.contributions
    running.distributions += d.distributions
    running.operatingIncome += d.operatingIncome
    running.realizedGains += d.realizedGains
    running.unrealizedGains += d.unrealizedGains
    running.expenses += d.expenses
    running.other += d.other

    const nav = r(running.contributions + running.distributions + running.operatingIncome +
      running.realizedGains + running.unrealizedGains + running.expenses + running.other)

    return {
      period: q,
      label: quarterLabel(q),
      calledCapital: r(running.contributions),
      distributed: r(-running.distributions),
      contributions: r(running.contributions),
      distributions: r(running.distributions),
      operatingIncome: r(running.operatingIncome),
      realizedGains: r(running.realizedGains),
      unrealizedGains: r(running.unrealizedGains),
      expenses: r(running.expenses),
      other: r(running.other),
      nav,
    }
  })
}

/**
 * Whole-fund growth time-series for one vehicle.
 *
 * `asOf` (YYYY-MM-DD) caps the series; it defaults to today. A vehicle with no capital and no
 * tracked investments returns an empty series rather than a flat line of zeroes.
 */
export async function fundTimeseries(
  admin: SupabaseClient,
  fundId: string,
  group: string,
  asOf?: string,
): Promise<FundTimeseries> {
  const endDate = asOf && /^\d{4}-\d{2}-\d{2}$/.test(asOf) ? asOf : new Date().toISOString().slice(0, 10)

  const preload = await loadFundPreload(admin, fundId, endDate, [group])
  const [{ postings }, { data: txnRows }, { data: companyRows }] = await Promise.all([
    loadCapitalPostings(admin, fundId, group, endDate, preload.idMap, vehicleCapitalPreload(preload, group)),
    admin.from('investment_transactions' as any).select('*').eq('fund_id', fundId),
    admin.from('companies' as any).select('*').eq('fund_id', fundId),
  ])

  // Net IRR splits by partner class, so we need the LP/GP map — but only ledger vehicles carry a
  // meaningful net view (a tracking vehicle has no called capital), so skip the read otherwise.
  const classes = preload.entityClasses

  const txns = ((txnRows as InvestmentTransaction[]) ?? [])
  const companies = ((companyRows as any[]) ?? [])

  // Companies this vehicle actually holds — same test the schedule of investments uses.
  const byCompany = new Map<string, InvestmentTransaction[]>()
  for (const t of txns) {
    if (!byCompany.has(t.company_id)) byCompany.set(t.company_id, [])
    byCompany.get(t.company_id)!.push(t)
  }
  const held = companies
    .map(c => ({ status: (c.status ?? 'active') as CompanyStatus, relevant: txnsForVehicle(byCompany.get(c.id) ?? [], group) }))
    .filter(c => c.relevant.some(t => t.transaction_type === 'investment' && t.portfolio_group === group))

  // Earliest activity across both producers — where the curve should start.
  const postingDates = postings.map(p => p.entryDate).filter((d): d is string => !!d)
  const txnDates = held.flatMap(c => c.relevant.map(t => t.transaction_date).filter((d): d is string => !!d))
  const allDates = [...postingDates, ...txnDates].filter(d => d <= endDate).sort()
  if (allDates.length === 0) return { points: [], hasGross: held.length > 0 }

  const quarters = quarterEndsThrough(allDates[0], endDate).map(q => q > endDate ? endDate : q)
  const resolvedPeriods = await Promise.all(quarters.map(q => loadCapitalPostings(admin, fundId, group, q, preload.idMap, vehicleCapitalPreload(preload, group))))
  const capital = quarters.map((q, i) => buildCapitalSeries(resolvedPeriods[i].postings, [q])[0])

  // New vs follow-on: cost defined exactly as computeSummary's totalInvested (cash + any interest
  // capitalized on a conversion row) so new + follow-on ties to invested capital at every quarter.
  const invCost = (t: InvestmentTransaction) =>
    (t.investment_cost ?? 0) + ((t as { converts_from_txn_id?: string | null }).converts_from_txn_id ? (t.interest_converted ?? 0) : 0)
  const invLite: InvTxnLite[][] = held.map(c =>
    c.relevant
      .filter(t => t.transaction_type === 'investment')
      .map(t => ({ date: t.transaction_date ?? null, cost: invCost(t) })),
  )
  const nfo = buildNewFollowOnSeries(invLite, quarters)

  // Net-IRR flows from the LP's point of view: a contribution is money out (negative), a
  // distribution money back (positive). Mirrors fund-economics.flowsFor so the two agree.
  const netFlowsUpTo = (until: string, ids: Set<string> | null): CashFlow[] => {
    const postings = resolvedPeriods[quarters.indexOf(until)].postings
    const out: CashFlow[] = []
    for (const p of postings) {
      if (p.entryDate && p.entryDate > until) continue
      if (ids && (!p.lpEntityId || !ids.has(p.lpEntityId))) continue
      const bucket = bucketForSourceType(p.sourceType)
      if (bucket !== 'contributions' && bucket !== 'distributions') continue
      const delta = -p.amount // credit increases capital
      if (Math.abs(delta) < 0.005) continue
      out.push({ date: new Date((p.entryDate ?? until) + 'T00:00:00Z'), amount: -delta })
    }
    return out
  }

  const entityIds = Array.from(new Set(postings.map(p => p.lpEntityId).filter(Boolean) as string[]))
  const lpIds = new Set(entityIds.filter(id => (classes.get(id) ?? 'lp') !== 'gp'))

  const netIrrFor = (until: string, terminalDate: Date, ids: Set<string> | null): number | null => {
    const { postings, evidenceByLp } = resolvedPeriods[quarters.indexOf(until)]
    if (Array.from(evidenceByLp.entries()).some(([id, e]) => (!ids || ids.has(id)) && (!e.canCalculateIrr || e.conflict || e.missing.length > 0))) return null
    const accounts = computeCapitalAccounts(postings, { end: until })
    let nav = 0
    for (const [id, a] of Array.from(accounts.entries())) if (!ids || ids.has(id)) nav += a.ending
    const flows = netFlowsUpTo(until, ids)
    if (Math.abs(nav) > 0.005) flows.push({ date: terminalDate, amount: r(nav) })
    return flows.length >= 2 ? xirr(flows) : null
  }

  // Layer the gross (deal-level) view on: re-value the tracker AS OF each quarter end. Only txns
  // dated on or before the quarter count, so the series is a real growth curve (computeSummary
  // itself does not date-scope cost/proceeds). computeSummary stays the canonical valuation.
  const points: FundTimeseriesPoint[] = capital.map((pt, i) => {
    const asOfDate = new Date(pt.period + 'T00:00:00Z')
    let investedCapital = 0, proceeds = 0, portfolioValue = 0
    const grossFlows: CashFlow[] = []
    for (const c of held) {
      const asOfTxns = c.relevant.filter(t => !t.transaction_date || t.transaction_date <= pt.period)
      const s = computeSummary(asOfTxns, c.status, asOfDate)
      investedCapital += s.totalInvested
      proceeds += s.totalRealized
      portfolioValue += s.unrealizedValue
      for (const t of asOfTxns) {
        if (!t.transaction_date) continue
        const d = new Date(t.transaction_date + 'T00:00:00Z')
        if (t.transaction_type === 'investment' && t.investment_cost) grossFlows.push({ date: d, amount: -t.investment_cost })
        else if (t.transaction_type === 'proceeds' && t.proceeds_received) grossFlows.push({ date: d, amount: t.proceeds_received })
      }
    }
    if (Math.abs(portfolioValue) > 0.005) grossFlows.push({ date: asOfDate, amount: r(portfolioValue) })

    return {
      ...pt,
      ...(Array.from(resolvedPeriods[i].evidenceByLp.values()).some(e => e.missing.length > 0) ? {
        calledCapital: null, distributed: null, contributions: null, distributions: null,
        operatingIncome: null, realizedGains: null, unrealizedGains: null, expenses: null, other: null, nav: null,
      } : {}),
      investedCapital: r(investedCapital),
      newInvested: nfo[i].newInvested,
      followOnInvested: nfo[i].followOnInvested,
      proceeds: r(proceeds),
      portfolioValue: r(portfolioValue),
      grossIrr: grossFlows.length >= 2 ? xirr(grossFlows) : null,
      netIrrFund: netIrrFor(pt.period, asOfDate, null),
      netIrrLp: netIrrFor(pt.period, asOfDate, lpIds),
    }
  })

  return { points, hasGross: held.length > 0 }
}
