// What a table, a chart, an API caller and the Analyst all read: one plan (or the bare actuals)
// over a chosen range, at a chosen interval.
//
// The posting stream is assembled here, once, so every surface agrees on the boundary:
//   actual    — posted actuals only
//   plan      — the plan's own entries, opened from actual balances the day before it starts
//   combined  — actuals through the cutoff, the plan after it
// Then it is bucketed monthly (statement.ts) and only then rolled up — flows summed, cash taken
// from the edges — so quarterly and annual figures are always the monthly ones re-added.

import type { Account, Posting } from '@/lib/accounting/types'
import { roundCents } from '@/lib/accounting/ledger'
import { aggregateBalance, aggregateFlow, firstDay, lastDay, monthRange, periods, type Interval, type MonthKey } from './months'
import { monthlyStatement, type MonthStatus } from './statement'

export type ReportView = 'actual' | 'plan' | 'combined'

/** What moved the cash: the fund cash timeline's categories. */
export type FlowCategory = 'operating' | 'invested' | 'proceeds' | 'called' | 'distributed'
export const FLOW_CATEGORIES: FlowCategory[] = ['operating', 'invested', 'proceeds', 'called', 'distributed']

/** One entry's postings, with the forecast kind when it has one. */
export interface FlowEntry {
  date: string
  kind?: string | null
  postings: Posting[]
}

export interface ReportInput {
  view: ReportView
  accounts: Account[]
  /** Posted actuals, dated. May run past the cutoff; the view decides what is used. */
  actuals: Posting[]
  /** The plan's compiled postings, dated. Ignored for 'actual'. */
  plan: Posting[]
  /** First month of the plan's window (its opening balances are actuals before it). */
  planFirst: MonthKey | null
  /** Last actual month for 'combined'. */
  cutoff: MonthKey | null
  /** For the 'actual' view: the last month with actuals at all (usually the current month). */
  actualsAvailableThrough: MonthKey
  closedThrough: MonthKey | null
  start: MonthKey
  end: MonthKey
  interval: Interval
  /** Entry-grouped streams for the cash timeline; omitted = no timeline. */
  actualEntries?: FlowEntry[]
  planEntries?: FlowEntry[]
}

export type PeriodStatus = MonthStatus | 'mixed'

export interface ReportPeriod {
  key: string
  label: string
  start: string
  end: string
  months: MonthKey[]
  status: PeriodStatus
}

export interface ReportLine {
  accountId: string
  code: string
  name: string
  type: 'income' | 'expense'
  values: number[]
}

export interface Report {
  view: ReportView
  interval: Interval
  periods: ReportPeriod[]
  months: { month: MonthKey; status: MonthStatus }[]
  lines: ReportLine[]
  revenue: number[]
  expenses: number[]
  netIncome: number[]
  cash: ({ opening: number; movement: number; ending: number } | null)[]
  /** The month the actual/forecast boundary falls after, if it is inside the range. */
  boundary: MonthKey | null
  /** Net cash by what moved it, per period. Sums to the cash movement. */
  cashFlows: Record<FlowCategory, number[]> | null
}

const FORECAST_KIND: Record<string, FlowCategory> = {
  investment: 'invested', proceeds: 'proceeds', capital_call: 'called', distribution: 'distributed',
}

/**
 * Classify one entry's cash. A forecast entry says what it is. An actual one is read from its
 * other legs: an investment account means it bought or sold a position; partners' capital (or the
 * LP receivable a call books first) means a call or a distribution; anything else is operating.
 */
export function classifyEntry(e: FlowEntry, byId: Map<string, Account>, cashIds: Set<string>): { category: FlowCategory; cash: number } | null {
  const cash = e.postings.filter(p => cashIds.has(p.accountId)).reduce((s, p) => s + p.amount, 0)
  if (cash === 0) return null
  if (e.kind && FORECAST_KIND[e.kind]) return { category: FORECAST_KIND[e.kind], cash }
  if (e.kind) return { category: 'operating', cash }
  const others = e.postings.filter(p => !cashIds.has(p.accountId)).map(p => byId.get(p.accountId)).filter(Boolean) as Account[]
  if (others.some(a => a.type === 'asset' && (a.subtype === 'investment' || a.companyId))) return { category: cash < 0 ? 'invested' : 'proceeds', cash }
  if (others.some(a => a.type === 'equity' || (a.type === 'asset' && a.subtype === 'receivable' && a.lpEntityId) || a.subtype === 'distributions_payable')) {
    return { category: cash > 0 ? 'called' : 'distributed', cash }
  }
  return { category: 'operating', cash }
}

function flowEntriesFor(input: ReportInput): FlowEntry[] | null {
  if (!input.actualEntries && !input.planEntries) return null
  const actual = input.actualEntries ?? []
  const plan = input.planEntries ?? []
  switch (input.view) {
    case 'actual':
      return actual
    case 'plan': {
      const open = input.planFirst ? firstDay(input.planFirst) : null
      return [...(open ? actual.filter(e => e.date < open) : []), ...plan]
    }
    case 'combined': {
      const edge = input.cutoff ? lastDay(input.cutoff) : null
      if (!edge) return plan
      return [...actual.filter(e => e.date <= edge), ...plan.filter(e => e.date > edge)]
    }
  }
}

export function reportPostings(input: Pick<ReportInput, 'view' | 'actuals' | 'plan' | 'planFirst' | 'cutoff'>): Posting[] {
  switch (input.view) {
    case 'actual':
      return input.actuals
    case 'plan': {
      const open = input.planFirst ? firstDay(input.planFirst) : null
      const before = open ? input.actuals.filter(p => p.entryDate! < open) : []
      return [...before, ...input.plan]
    }
    case 'combined': {
      const edge = input.cutoff ? lastDay(input.cutoff) : null
      if (!edge) return input.plan
      return [
        ...input.actuals.filter(p => p.entryDate! <= edge),
        ...input.plan.filter(p => p.entryDate! > edge),
      ]
    }
  }
}

export function buildReport(input: ReportInput): Report {
  const months = monthRange(input.start, input.end)
  const actualsThrough =
    input.view === 'actual' ? input.actualsAvailableThrough : input.view === 'combined' ? input.cutoff : null
  const st = monthlyStatement({
    accounts: input.accounts,
    postings: reportPostings(input),
    months,
    actualsThrough,
    closedThrough: input.closedThrough,
  })
  const ps = periods(input.start, input.end, input.interval)
  const statusOf = new Map(st.months.map(m => [m.month, m.status]))
  const asMap = (r: Record<MonthKey, number>) => new Map(Object.entries(r))

  const cash = aggregateBalance(new Map(Object.entries(st.cash)), ps).map(b =>
    b ? { opening: b.opening, ending: b.ending, movement: roundCents(b.ending - b.opening) } : null,
  )

  const boundary = actualsThrough && actualsThrough >= input.start && actualsThrough < input.end ? actualsThrough : null

  let cashFlows: Report['cashFlows'] = null
  const flowEntries = flowEntriesFor(input)
  if (flowEntries) {
    const byId = new Map(input.accounts.map(a => [a.id, a]))
    const cashIds = new Set(st.cashAccountIds)
    const inRange = new Set(months)
    const byCat = Object.fromEntries(FLOW_CATEGORIES.map(c => [c, new Map<MonthKey, number>()])) as Record<FlowCategory, Map<MonthKey, number>>
    for (const e of flowEntries) {
      const m = e.date.slice(0, 7)
      if (!inRange.has(m)) continue
      const c = classifyEntry(e, byId, cashIds)
      if (c) byCat[c.category].set(m, (byCat[c.category].get(m) ?? 0) + c.cash)
    }
    cashFlows = Object.fromEntries(FLOW_CATEGORIES.map(c => [c, aggregateFlow(byCat[c], ps)])) as Record<FlowCategory, number[]>
  }

  return {
    view: input.view,
    interval: input.interval,
    periods: ps.map(p => {
      const statuses = new Set(p.months.map(m => statusOf.get(m)!))
      return {
        key: p.key,
        label: p.label,
        start: firstDay(p.startMonth),
        end: lastDay(p.endMonth),
        months: p.months,
        status: statuses.size === 1 ? [...statuses][0] : 'mixed',
      }
    }),
    months: st.months,
    lines: st.lines.map(l => ({ accountId: l.accountId, code: l.code, name: l.name, type: l.type, values: aggregateFlow(asMap(l.byMonth), ps) })),
    revenue: aggregateFlow(asMap(st.revenue), ps),
    expenses: aggregateFlow(asMap(st.expenses), ps),
    netIncome: aggregateFlow(asMap(st.netIncome), ps),
    cash,
    boundary,
    cashFlows,
  }
}
