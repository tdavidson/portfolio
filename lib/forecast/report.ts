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
import { forecastBalanceSheet, type ForecastBalanceSheet } from './balance-sheet'

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
  /** A breakdown of another line (key), shown under it and not added again into the section. */
  parent?: string
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
  /** The entry's memo: tells a carry payment ("Carried interest…") and the GP's own share apart. */
  memo?: string | null
  /** A forecast entry's P&L account — its cash is shown against that line, not the accrual it clears. */
  driver?: string | null
  postings: Posting[]
}

export interface ReportInput {
  /** Partners who are the GP (partner class 'gp'), to split their distributions from the LPs'. */
  gpEntityIds?: Set<string>
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
  /** How the balance sheet names and lays out equity (lib/accounting/vocab.ts, lib/vehicle-kinds.ts). */
  equityLabel?: string
  itemizeEquity?: boolean
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
  subtype?: string | null
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
  /**
   * The income statement on a CASH basis: each revenue and expense line as the cash it moved, in the
   * period it moved. Cash that settles an accrual the books hold (a fee accrued, then paid) counts
   * against the accrual's own account (resolveSettlements); cash against a balance no accrual
   * explains (one from before the books, a prepaid fee) is one line of its own, `accruals`.
   */
  cashBasis: { lines: ReportLine[]; accruals: number[]; revenue: number[]; expenses: number[]; netIncome: number[] } | null
  /**
   * Operating cash on the ACCRUAL basis (the indirect method): net income, less investment gains
   * (not operating cash), plus the change in accruals, prepaids and payables. Re-adds to the direct
   * method's operating cash.
   */
  indirect: { netIncome: number[]; investmentGains: number[]; workingCapital: number[]; operating: number[] } | null
  /** Ending balance of each cash account, per period (operating, reserve, …). */
  cashAccounts: { accountId: string; code: string; name: string; ending: number[] }[]
  /** Every asset, liability and equity balance at the end of each period (./balance-sheet.ts). */
  balanceSheet?: ForecastBalanceSheet
}

const FORECAST_KIND: Record<string, FlowCategory> = {
  investment: 'invested', proceeds: 'proceeds', capital_call: 'called', distribution: 'distributed',
  // Carry paid to the GP leaves the fund as a distribution does (lib/forecast/capital.ts).
  carry_distribution: 'distributed',
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

/**
 * A balance an entry parks money in until cash settles it: a receivable, a payable, an accrual, a
 * distribution declared. Not cash, an investment, a loan or equity — those are what the cash is FOR.
 */
function isClearingAccount(a: Account | undefined, cashIds: Set<string>): boolean {
  if (!a || cashIds.has(a.id)) return false
  if (a.type !== 'asset' && a.type !== 'liability') return false
  if (a.type === 'asset' && (a.subtype === 'investment' || a.companyId)) return false
  if (a.type === 'liability' && BORROWING_SUBTYPES.has(a.subtype ?? '')) return false
  return true
}

/**
 * Cash that settles an earlier accrual, shown as what was accrued. A call booked to an LP receivable
 * and collected later is a capital contribution when the wire lands, not a fall in a receivable; a
 * management fee accrued to a payable and paid later is management fee cash, not "accrued expenses".
 *
 * Every non-cash entry that moves a clearing account (isClearingAccount) leaves a lot on it holding
 * the entry's other legs — the call's partners' capital, the fee's expense. A cash entry that runs a
 * clearing account the other way takes lots oldest first, and its leg on that account is replaced
 * by the legs those lots hold, scaled to the amount settled. What no lot covers (a balance from
 * before the books, a payable whose bill was never entered) stays on the clearing account. Cash
 * legs are never touched, so every total and every ending balance is unchanged.
 *
 * Entries with a forecast kind already say what they are and pass through as they are.
 */
export function resolveSettlements(entries: FlowEntry[], byId: Map<string, Account>, cashIds: Set<string>): FlowEntry[] {
  type Lot = { remaining: number; size: number; legs: Posting[] }
  const lots = new Map<string, Lot[]>()
  const touchesCash = (e: FlowEntry) => e.postings.some(p => cashIds.has(p.accountId))
  // By date; on one date the accruals first, so a call and its wire on the same day still pair up.
  const order = entries.map((e, i) => ({ e, i })).sort((x, y) =>
    x.e.date.localeCompare(y.e.date) || Number(touchesCash(x.e)) - Number(touchesCash(y.e)) || x.i - y.i)
  const out = new Array<FlowEntry[]>(entries.length)
  for (const { e, i } of order) {
    out[i] = [e]
    if (e.kind) continue
    const clearing = e.postings.filter(p => isClearingAccount(byId.get(p.accountId), cashIds))
    if (!clearing.length) continue
    if (!touchesCash(e)) {
      // An accrual: each clearing leg is a lot holding the entry's other (non-clearing) legs.
      const origin = e.postings.filter(p => !isClearingAccount(byId.get(p.accountId), cashIds))
      const originTotal = origin.reduce((s, p) => s + p.amount, 0)
      if (!origin.length || Math.abs(originTotal) < 0.005) continue
      for (const p of clearing) {
        if (Math.abs(p.amount) < 0.005) continue
        // The origin legs, scaled to offset this leg alone.
        const scale = -p.amount / originTotal
        const legs = origin.map(o => ({ ...o, amount: o.amount * scale }))
        const queue = lots.get(p.accountId) ?? []
        queue.push({ remaining: p.amount, size: p.amount, legs })
        lots.set(p.accountId, queue)
      }
      continue
    }
    // A cash entry: settle each clearing leg against that account's lots, oldest first. Each lot
    // settled is a piece of its own, with its share of the cash, so one wire that clears both a call
    // and an older balance is classified as both, not all as whichever leg was read first.
    const pieces: Posting[][] = []
    const rest: Posting[] = []
    for (const p of e.postings) {
      if (cashIds.has(p.accountId)) continue
      const queue = isClearingAccount(byId.get(p.accountId), cashIds) ? lots.get(p.accountId) : undefined
      let left = p.amount
      while (queue?.length && Math.abs(left) >= 0.005 && Math.sign(queue[0].remaining) === -Math.sign(left)) {
        const lot = queue[0]
        const take = Math.min(Math.abs(left), Math.abs(lot.remaining))
        const share = take / Math.abs(lot.size)
        // The lot's legs offset the accrual, so they already carry the settlement's sign: a
        // receivable credited on collection becomes the call's credit to capital.
        pieces.push(lot.legs.map(l => ({ ...l, amount: l.amount * share, entryDate: p.entryDate ?? l.entryDate })))
        lot.remaining -= Math.sign(lot.remaining) * take
        left -= Math.sign(left) * take
        if (Math.abs(lot.remaining) < 0.005) queue.shift()
      }
      if (Math.abs(left) >= 0.005) rest.push(left === p.amount ? p : { ...p, amount: left })
    }
    if (!pieces.length) continue
    const cashLegs = e.postings.filter(p => cashIds.has(p.accountId))
    const cash = cashLegs.reduce((s, p) => s + p.amount, 0)
    if (Math.abs(cash) < 0.005) {
      // Cash moved between cash accounts as well: nothing to apportion, keep it one entry.
      out[i] = [{ ...e, postings: [...cashLegs, ...pieces.flat(), ...rest] }]
      continue
    }
    // Each piece's cash is what offsets it, spread over the cash legs as the entry spread its cash.
    out[i] = [...pieces, ...(rest.length ? [rest] : [])].map(legs => {
      const offset = -legs.reduce((s, p) => s + p.amount, 0)
      return { ...e, postings: [...cashLegs.map(c => ({ ...c, amount: c.amount * offset / cash })), ...legs] }
    })
  }
  return out.flat()
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

function flowEntriesFor(input: ReportInput, byId: Map<string, Account>, cashIds: Set<string>): FlowEntry[] | null {
  if (!input.actualEntries && !input.planEntries) return null
  // Read across ALL the actuals, not just the range: a call is usually booked before it is collected.
  const actual = resolveSettlements(input.actualEntries ?? [], byId, cashIds)
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

/** Income that is an investment's gain or loss, not operating revenue: investing on a cash-flow statement. */
export const INVESTMENT_GAIN_SUBTYPES = new Set(['realized_gain', 'unrealized', 'fx_translation', 'equity_method'])

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
  let cashBasis: Report['cashBasis'] = null
  let indirect: Report['indirect'] = null
  const byId = new Map(input.accounts.map(a => [a.id, a]))
  const cashIds = new Set(st.cashAccountIds)
  const flowEntries = flowEntriesFor(input, byId, cashIds)
  if (flowEntries) {
    const inRange = new Set(months)
    const byCat = Object.fromEntries(FLOW_CATEGORIES.map(c => [c, new Map<MonthKey, number>()])) as Record<FlowCategory, Map<MonthKey, number>>
    const lines = new Map<string, { section: CashSection; label: string; code: string | null; parent?: string; byMonth: Map<MonthKey, number> }>()
    const add = (key: string, meta: { section: CashSection; label: string; code: string | null; parent?: string }, m: MonthKey, amount: number) => {
      const line = lines.get(key) ?? { ...meta, byMonth: new Map<MonthKey, number>() }
      line.byMonth.set(m, (line.byMonth.get(m) ?? 0) + amount)
      lines.set(key, line)
    }
    const accountLine = (id: string, m: MonthKey, amount: number) => {
      const a = byId.get(id)
      add(id, { section: 'operating', label: a ? a.name : 'Other', code: a?.code ?? null }, m, amount)
    }
    // Cash basis: the same operating cash, by the P&L account it was for (natural sign: revenue in,
    // expense out, both positive), and what cleared an accrual with no P&L account on the entry.
    const cashPnl = new Map<string, Map<MonthKey, number>>()
    const accrualCash = new Map<MonthKey, number>()
    const toCashPnl = (id: string, m: MonthKey, cash: number) => {
      const a = byId.get(id)
      if (a?.type === 'income' || a?.type === 'expense') {
        const natural = a.type === 'income' ? cash : -cash
        const row = cashPnl.get(id) ?? new Map<MonthKey, number>()
        row.set(m, (row.get(m) ?? 0) + natural)
        cashPnl.set(id, row)
      } else {
        accrualCash.set(m, (accrualCash.get(m) ?? 0) + cash)
      }
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
        // Distributions, broken down beneath their line: to the LPs, to the GP on its own
        // commitment, and the GP's carried interest.
        if (c.category === 'distributed') {
          for (const [k, v] of distributionSplit(e, c.cash, cashIds, input.gpEntityIds)) {
            if (Math.abs(v) >= 0.005) add(`distributed:${k}`, { section: 'financing', label: SPLIT_LABEL[k], code: null, parent: 'distributed' } as any, m, v)
          }
        }
      } else if (e.driver) {
        accountLine(e.driver, m, c.cash)
        toCashPnl(e.driver, m, c.cash)
      } else {
        // Each non-cash leg's share of the cash: a $100 expense debit is $100 of cash out. Scaled so
        // the shares re-add to the cash even when an entry also moves money between cash accounts.
        const legs = e.postings.filter(p => !cashIds.has(p.accountId))
        const total = legs.reduce((s, p) => s + p.amount, 0)
        if (total === 0) continue
        for (const p of legs) {
          accountLine(p.accountId, m, (p.amount / total) * c.cash)
          toCashPnl(p.accountId, m, (p.amount / total) * c.cash)
        }
      }
    }
    const pnlLines: ReportLine[] = [...cashPnl.entries()].map(([id, byMonth]) => {
      const a = byId.get(id)!
      return { accountId: id, code: a.code, name: a.name, type: a.type as 'income' | 'expense', subtype: a.subtype ?? null, values: aggregateFlow(byMonth, ps) }
    }).filter(l => l.values.some(v => Math.abs(v) >= 0.005)).sort((a, b) => a.code.localeCompare(b.code))
    const sumOf = (type: 'income' | 'expense') => ps.map((_, i) => roundCents(pnlLines.filter(l => l.type === type).reduce((s, l) => s + (l.values[i] ?? 0), 0)))
    const accruals = aggregateFlow(accrualCash, ps)
    const rev = sumOf('income'), exp = sumOf('expense')
    cashBasis = { lines: pnlLines, accruals, revenue: rev, expenses: exp, netIncome: ps.map((_, i) => roundCents(rev[i] - exp[i] + (accruals[i] ?? 0))) }
    // Indirect: operating cash = net income − investment gains + the change in working capital (the rest).
    const accrualNet = aggregateFlow(asMap(st.netIncome), ps)
    const gains = ps.map((_, i) => roundCents(st.lines.filter(l => l.type === 'income' && INVESTMENT_GAIN_SUBTYPES.has(l.subtype ?? ''))
      .reduce((s, l) => s + (aggregateFlow(asMap(l.byMonth), ps)[i] ?? 0), 0)))
    const operating = aggregateFlow(byCat.operating, ps)
    indirect = {
      netIncome: accrualNet, investmentGains: gains.map(g => -g),
      workingCapital: ps.map((_, i) => roundCents((operating[i] ?? 0) - (accrualNet[i] ?? 0) + (gains[i] ?? 0))),
      operating,
    }
    cashFlows = Object.fromEntries(FLOW_CATEGORIES.map(c => [c, aggregateFlow(byCat[c], ps)])) as Record<FlowCategory, number[]>
    const order = (key: string) => {
      const a = byId.get(key)
      return a ? ({ income: 0, expense: 1 } as Record<string, number>)[a.type] ?? 2 : 3
    }
    cashDetail = [...lines.entries()]
      .map(([key, l]) => ({ section: l.section, key, label: l.label, code: l.code, ...(l.parent ? { parent: l.parent } : {}), values: aggregateFlow(l.byMonth, ps) }))
      .filter(l => l.values.some(v => v !== 0))
      .sort((a, b) => order(a.key) - order(b.key) || (a.parent ?? a.key).localeCompare(b.parent ?? b.key) || (a.parent ? 1 : 0) - (b.parent ? 1 : 0) || (a.code ?? a.label).localeCompare(b.code ?? b.label))
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
    lines: st.lines.map(l => ({ accountId: l.accountId, code: l.code, name: l.name, type: l.type, subtype: l.subtype ?? null, values: aggregateFlow(asMap(l.byMonth), ps) })),
    revenue: aggregateFlow(asMap(st.revenue), ps),
    expenses: aggregateFlow(asMap(st.expenses), ps),
    netIncome: aggregateFlow(asMap(st.netIncome), ps),
    cash,
    boundary,
    cashFlows,
    cashDetail,
    cashBasis,
    indirect,
    cashAccounts,
    balanceSheet: forecastBalanceSheet({
      accounts: input.accounts, postings: reportPostings(input), periods: ps,
      hasData: m => statusOf.has(m) && statusOf.get(m) !== 'none',
      equityLabel: input.equityLabel, itemizeEquity: input.itemizeEquity,
    }),
  }
}

const SPLIT_LABEL = { lp: 'To the LPs', gp: 'To the GP, on its own commitment', carry: 'Carried interest' } as const

/**
 * One distribution's cash, split. A forecast entry says which it is (a carry payment's memo is
 * "Carried interest…", the GP's own share "Distribution to the GP…"); a posted one is split by
 * whose capital it reduced — the GP's partners against the LPs' — with a carry posting as carry.
 */
function distributionSplit(e: FlowEntry, cash: number, cashIds: Set<string>, gpIds?: Set<string>): [keyof typeof SPLIT_LABEL, number][] {
  const memo = e.memo ?? ''
  if (e.kind === 'carry_distribution' || /^Carried interest/.test(memo)) return [['carry', cash]]
  if (/^Distribution to the GP/.test(memo)) return [['gp', cash]]
  if (e.kind) return [['lp', cash]]
  const legs = e.postings.filter(p => !cashIds.has(p.accountId) && p.amount > 0)
  const total = legs.reduce((s, p) => s + p.amount, 0)
  if (total <= 0 || !gpIds?.size) return [['lp', cash]]
  const gp = legs.filter(p => p.lpEntityId && gpIds.has(p.lpEntityId)).reduce((s, p) => s + p.amount, 0)
  const carry = /carr(y|ied)/i.test(memo) ? gp : 0
  return [['lp', cash * (total - gp) / total], [carry ? 'carry' : 'gp', cash * gp / total]]
}
