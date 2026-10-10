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
import { aggregateFlow, firstDay, lastDay, monthRange, periods, type Interval, type MonthKey } from './months'
import { monthlyStatement, type MonthStatus } from './statement'

export type ReportView = 'actual' | 'plan' | 'combined'

/** What moved the cash: the fund cash timeline's categories. */
export type FlowCategory = 'operating' | 'invested' | 'proceeds' | 'called' | 'distributed' | 'borrowed' | 'repaid'
export const FLOW_CATEGORIES: FlowCategory[] = ['operating', 'invested', 'proceeds', 'called', 'distributed', 'borrowed', 'repaid']

export type CashSection = 'operating' | 'investing' | 'financing'

/** One line of the cash-flow statement: an account (operating) or a capital flow (investing, financing). */
export interface CashDetailLine {
  section: CashSection
  key: string
  label: string
  code: string | null
  values: number[]
}

const CATEGORY_LINE: Record<Exclude<FlowCategory, 'operating'>, { section: CashSection; label: string }> = {
  invested: { section: 'investing', label: 'Investments' },
  proceeds: { section: 'investing', label: 'Exit proceeds' },
  called: { section: 'financing', label: 'Capital contributions' },
  distributed: { section: 'financing', label: 'Distributions' },
  borrowed: { section: 'financing', label: 'Borrowings' },
  repaid: { section: 'financing', label: 'Loan repayments' },
}

const BORROWING_SUBTYPES = new Set(['loan_payable', 'note_payable'])

/** One entry's postings, with the forecast kind when it has one. */
export interface FlowEntry {
  date: string
  kind?: string | null
  /** A forecast entry's P&L account — its cash is shown against that line, not the accrual it clears. */
  driver?: string | null
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
  /** Last month of the plan's window; later months have no data in a plan view. */
  planLast?: MonthKey | null
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
  /** Some of the period's months have no data (the range runs past the actuals or the plan). */
  partial: boolean
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
  /** The cash-flow statement's lines, per period. Sums to the cash movement. */
  cashDetail: CashDetailLine[] | null
  /** Ending balance of each cash account, per period (operating, reserve, …). */
  cashAccounts: { accountId: string; code: string; name: string; ending: number[] }[]
}

const FORECAST_KIND: Record<string, FlowCategory> = {
  investment: 'invested', proceeds: 'proceeds', capital_call: 'called', distribution: 'distributed',
}

/**
 * Classify one entry's cash. A forecast entry says what it is. An actual one is read from its
 * other legs: an investment account means it bought or sold a position; partners' capital (or the
 * LP receivable a call books first) means a call or a distribution; anything else is operating.
 */
/**
 * Loans that paid for an investment: a borrowing account credited in an entry that debits an
 * investment and moves no cash — the lender paid the company directly. Repaying one is, in
 * substance, paying for that investment, so its repayments are shown as investments.
 */
export function investmentFundingLoans(entries: FlowEntry[], byId: Map<string, Account>, cashIds: Set<string>): Set<string> {
  const out = new Set<string>()
  for (const e of entries) {
    if (e.postings.some(p => cashIds.has(p.accountId))) continue
    const accts = e.postings.map(p => ({ p, a: byId.get(p.accountId) }))
    const buysInvestment = accts.some(({ p, a }) => p.amount > 0 && a?.type === 'asset' && (a.subtype === 'investment' || !!a.companyId))
    if (!buysInvestment) continue
    for (const { p, a } of accts) {
      if (p.amount < 0 && a?.type === 'liability' && BORROWING_SUBTYPES.has(a.subtype ?? '')) out.add(a.id)
    }
  }
  return out
}

export function classifyEntry(
  e: FlowEntry,
  byId: Map<string, Account>,
  cashIds: Set<string>,
  investmentLoans: Set<string> = new Set(),
): { category: FlowCategory; cash: number } | null {
  const cash = e.postings.filter(p => cashIds.has(p.accountId)).reduce((s, p) => s + p.amount, 0)
  if (cash === 0) return null
  if (e.kind && FORECAST_KIND[e.kind]) return { category: FORECAST_KIND[e.kind], cash }
  if (e.kind) return { category: 'operating', cash }
  const others = e.postings.filter(p => !cashIds.has(p.accountId)).map(p => byId.get(p.accountId)).filter(Boolean) as Account[]
  if (others.some(a => a.type === 'asset' && (a.subtype === 'investment' || a.companyId))) return { category: cash < 0 ? 'invested' : 'proceeds', cash }
  // Money in from a lender is a borrowing; money out to one is a repayment — two different things,
  // and one netted "borrowings" bar made a loan repaid with called capital read as negative borrowing.
  const loan = others.find(a => a.type === 'liability' && BORROWING_SUBTYPES.has(a.subtype ?? ''))
  if (loan) {
    if (cash < 0 && investmentLoans.has(loan.id)) return { category: 'invested', cash }
    return { category: cash > 0 ? 'borrowed' : 'repaid', cash }
  }
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
  // A month the view has nothing for is 'none', never 'forecast': with no plan selected, December
  // is not a forecast of zero, it is simply not here yet.
  const noData = (m: MonthKey): boolean => {
    if (input.view === 'actual') return m > input.actualsAvailableThrough
    if (input.planLast && m > input.planLast) return true
    if (input.view === 'plan') return !!input.planFirst && m < input.planFirst
    return !!input.planFirst && m < input.planFirst && (input.cutoff == null || m > input.cutoff)
  }
  for (const m of st.months) if (noData(m.month)) m.status = 'none'
  const statusOf = new Map(st.months.map(m => [m.month, m.status]))
  const asMap = (r: Record<MonthKey, number>) => new Map(Object.entries(r))

  // Opening of the period's first month WITH data, ending of its last — so a quarter cut short by
  // the end of the actuals still reads correctly, and one with no data at all reads as nothing.
  const cash = ps.map(p => {
    const data = p.months.filter(m => statusOf.get(m) !== 'none')
    if (!data.length) return null
    const first = st.cash[data[0]]
    const last = st.cash[data[data.length - 1]]
    return { opening: first.opening, ending: last.ending, movement: roundCents(last.ending - first.opening) }
  })

  const boundary = actualsThrough && actualsThrough >= input.start && actualsThrough < input.end ? actualsThrough : null

  let cashFlows: Report['cashFlows'] = null
  let cashDetail: Report['cashDetail'] = null
  const byId = new Map(input.accounts.map(a => [a.id, a]))
  const cashIds = new Set(st.cashAccountIds)
  const flowEntries = flowEntriesFor(input)
  if (flowEntries) {
    const inRange = new Set(months)
    const byCat = Object.fromEntries(FLOW_CATEGORIES.map(c => [c, new Map<MonthKey, number>()])) as Record<FlowCategory, Map<MonthKey, number>>
    const lines = new Map<string, { section: CashSection; label: string; code: string | null; byMonth: Map<MonthKey, number> }>()
    const add = (key: string, meta: { section: CashSection; label: string; code: string | null }, m: MonthKey, amount: number) => {
      const line = lines.get(key) ?? { ...meta, byMonth: new Map<MonthKey, number>() }
      line.byMonth.set(m, (line.byMonth.get(m) ?? 0) + amount)
      lines.set(key, line)
    }
    const accountLine = (id: string, m: MonthKey, amount: number) => {
      const a = byId.get(id)
      add(id, { section: 'operating', label: a ? a.name : 'Other', code: a?.code ?? null }, m, amount)
    }
    // Read across ALL entries, not just the range: the loan was usually drawn before the repayments.
    const investmentLoans = investmentFundingLoans([...(input.actualEntries ?? []), ...(input.planEntries ?? [])], byId, cashIds)
    for (const e of flowEntries) {
      const m = e.date.slice(0, 7)
      if (!inRange.has(m)) continue
      const c = classifyEntry(e, byId, cashIds, investmentLoans)
      if (!c) continue
      byCat[c.category].set(m, (byCat[c.category].get(m) ?? 0) + c.cash)
      if (c.category !== 'operating') {
        add(c.category, { ...CATEGORY_LINE[c.category], code: null }, m, c.cash)
      } else if (e.driver) {
        accountLine(e.driver, m, c.cash)
      } else {
        // Each non-cash leg's share of the cash: a $100 expense debit is $100 of cash out. Scaled so
        // the shares re-add to the cash even when an entry also moves money between cash accounts.
        const legs = e.postings.filter(p => !cashIds.has(p.accountId))
        const total = legs.reduce((s, p) => s + p.amount, 0)
        if (total === 0) continue
        for (const p of legs) accountLine(p.accountId, m, (p.amount / total) * c.cash)
      }
    }
    cashFlows = Object.fromEntries(FLOW_CATEGORIES.map(c => [c, aggregateFlow(byCat[c], ps)])) as Record<FlowCategory, number[]>
    const order = (key: string) => {
      const a = byId.get(key)
      return a ? ({ income: 0, expense: 1 } as Record<string, number>)[a.type] ?? 2 : 3
    }
    cashDetail = [...lines.entries()]
      .map(([key, l]) => ({ section: l.section, key, label: l.label, code: l.code, values: aggregateFlow(l.byMonth, ps) }))
      .filter(l => l.values.some(v => v !== 0))
      .sort((a, b) => order(a.key) - order(b.key) || (a.code ?? a.label).localeCompare(b.code ?? b.label))
  }

  // Each cash account's own balance, so a reserve sweep shows as one account down and another up.
  const startDay = firstDay(input.start)
  const cashAccounts = input.accounts
    .filter(a => cashIds.has(a.id))
    .sort((a, b) => a.code.localeCompare(b.code))
    .map(a => {
      let opening = 0
      const byMonth = new Map<MonthKey, number>()
      for (const p of reportPostings(input)) {
        if (p.accountId !== a.id || !p.entryDate) continue
        if (p.entryDate < startDay) opening += p.amount
        else byMonth.set(p.entryDate.slice(0, 7), (byMonth.get(p.entryDate.slice(0, 7)) ?? 0) + p.amount)
      }
      let running = opening
      const endingByMonth = new Map<MonthKey, number>()
      for (const m of months) {
        running += byMonth.get(m) ?? 0
        endingByMonth.set(m, roundCents(running))
      }
      return { accountId: a.id, code: a.code, name: a.name, ending: ps.map(p => endingByMonth.get(p.endMonth) ?? 0) }
    })

  return {
    view: input.view,
    interval: input.interval,
    periods: ps.map(p => {
      const statuses = new Set(p.months.map(m => statusOf.get(m)!).filter(st => st !== 'none'))
      return {
        key: p.key,
        label: p.label,
        start: firstDay(p.startMonth),
        end: lastDay(p.endMonth),
        months: p.months,
        // 'mixed' means part ACTUAL, part FORECAST. A quarter of closed and unclosed actuals is
        // unclosed actuals — nothing in it is projected.
        status: statuses.size === 0 ? 'none'
          : statuses.size === 1 ? [...statuses][0]
          : !statuses.has('forecast') ? 'actual_unclosed'
          : 'mixed',
        partial: statuses.size > 0 && p.months.some(m => statusOf.get(m) === 'none'),
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
    cashDetail,
    cashAccounts,
  }
}
