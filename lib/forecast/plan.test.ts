import { describe, expect, it } from 'vitest'
import type { Account, Posting } from '@/lib/accounting/types'
import { DEFAULT_CHART, MANAGEMENT_COMPANY_CHART } from '@/lib/accounting/chart'
import { buildPlan, planWindow, type BuildPlanInput } from './plan'
import { buildReport } from './report'
import { validateRule } from './rules'

const ACCOUNTS: Account[] = MANAGEMENT_COMPANY_CHART.map(a => ({
  id: `a${a.code}`, fundId: 'f', code: a.code, name: a.name, type: a.type, subtype: a.subtype ?? null,
}))

const post = (date: string, legs: [string, number][]): Posting[] =>
  legs.map(([code, amount]) => ({ accountId: `a${code}`, amount, currency: 'USD', entryDate: date }))

// Jan–Jun 2026 actuals: $10k fee income received and $6k salaries paid each month; opening cash $50k.
const ACTUALS: Posting[] = [
  ...post('2025-12-31', [['1000', 50000], ['3000', -50000]]),
  ...['01', '02', '03', '04', '05', '06'].flatMap(m => [
    ...post(`2026-${m}-15`, [['1000', 10000], ['4000', -10000]]),
    ...post(`2026-${m}-28`, [['5000', 6000], ['1000', -6000]]),
  ]),
]

const base = (over: Partial<BuildPlanInput> = {}): BuildPlanInput => ({
  kind: 'rolling_forecast',
  fiscalYear: null,
  startMonth: '2026-07',
  endMonth: '2027-06',
  horizonMonths: 12,
  cutoff: '2026-05',
  vehicleKind: 'manco',
  accounts: ACCOUNTS,
  actuals: ACTUALS.filter(p => p.entryDate! <= '2026-05-31'),
  closedFrom: '2026-01',
  closedThrough: '2026-04',
  rules: [
    { id: 'r-fee', accountId: 'a4000', rule: validateRule('fixed', { amount: 12000 }), cashTiming: { mode: 'same' } },
    { id: 'r-sal', accountId: 'a5000', rule: validateRule('run_rate', { window: 3 }), cashTiming: { mode: 'same' } },
    { id: 'r-tax', accountId: 'a5210', rule: validateRule('recurring', { amount: 12000, everyMonths: 12, anchor: '2027-03' }), cashTiming: { mode: 'same' } },
  ],
  overrides: [],
  currency: 'USD',
  ...over,
})

describe('planWindow', () => {
  it('rolls a horizon forward with the cutoff', () => {
    expect(planWindow(base())).toEqual({ first: '2026-06', last: '2027-05' })
    expect(planWindow(base({ cutoff: '2026-08' }))).toEqual({ first: '2026-09', last: '2027-08' })
  })

  it('keeps a budget on its fiscal year', () => {
    expect(planWindow(base({ kind: 'budget', fiscalYear: 2027, cutoff: '2026-05' }))).toEqual({ first: '2027-01', last: '2027-12' })
  })
})

describe('buildPlan + combined report (acceptance #5, #6)', () => {
  const built = buildPlan(base())
  const planPostings = built.entries.flatMap(e => e.postings.map(p => ({ ...p, entryDate: e.entryDate })))
  const report = (interval: 'month' | 'quarter' | 'year', start = '2026-01', end = '2027-06') =>
    buildReport({
      view: 'combined', accounts: ACCOUNTS, actuals: ACTUALS, plan: planPostings, planFirst: built.first,
      cutoff: '2026-05', actualsAvailableThrough: '2026-06', closedThrough: '2026-04', start, end, interval,
    })

  it('uses actuals through the cutoff and the plan after, marking the boundary and the unclosed month', () => {
    const r = report('month')
    expect(r.boundary).toBe('2026-05')
    expect(r.months.find(m => m.month === '2026-04')?.status).toBe('actual')
    expect(r.months.find(m => m.month === '2026-05')?.status).toBe('actual_unclosed')
    expect(r.months.find(m => m.month === '2026-06')?.status).toBe('forecast')
    // June is forecast ($12k), not the $10k actually posted in June — the cutoff decides, not the data.
    expect(r.revenue[5]).toBe(12000)
    expect(r.revenue[4]).toBe(10000)
  })

  it('run rate averages closed months only (Feb–Apr), not the open May', () => {
    expect(built.rules.find(r => r.ruleId === 'r-sal')?.warnings.some(w => w.includes('unclosed'))).toBe(true)
    expect(report('month').expenses[6]).toBe(6000)
  })

  it('quarterly and annual views re-add the monthly figures, across years', () => {
    const m = report('month')
    const q = report('quarter')
    const y = report('year')
    const sum = (xs: number[]) => Math.round(xs.reduce((a, b) => a + b, 0) * 100) / 100
    expect(sum(q.netIncome)).toBe(sum(m.netIncome))
    expect(sum(y.expenses)).toBe(sum(m.expenses))
    expect(y.periods.map(p => p.status)).toEqual(['mixed', 'forecast'])
    expect(q.cash[0]).toEqual({ opening: 50000, ending: 62000, movement: 12000 })
    expect(y.cash[1]!.ending).toBe(m.cash[m.cash.length - 1]!.ending)
  })

  it('cash reconciles: ending = opening + movement every month', () => {
    for (const c of report('month').cash) expect(c!.ending).toBeCloseTo(c!.opening + c!.movement, 6)
  })

  it('a manual override changes only its month and keeps the rule (acceptance #4)', () => {
    const withOverride = buildPlan(base({ overrides: [{ id: 'o1', accountId: 'a4000', month: '2026-09', amount: 20000 }] }))
    const fee = (b: typeof built, d: string) =>
      b.entries.filter(e => e.accountId === 'a4000' && e.entryDate === d).flatMap(e => e.postings).find(p => p.accountId === 'a4000')?.amount
    expect(fee(withOverride, '2026-09-30')).toBe(-20000)
    expect(fee(withOverride, '2026-10-31')).toBe(-12000)
    expect(withOverride.rules.find(r => r.ruleId === 'r-fee')).toBeTruthy()
  })

  it('never invents a cash account', () => {
    const none = buildPlan(base({ accounts: ACCOUNTS.filter(a => a.subtype !== 'cash') }))
    expect(none.entries).toEqual([])
    expect(none.warnings[0]).toMatch(/no cash account/)
  })
})

describe('opening settlements', () => {
  // An accrued $3,000 audit fee and a $10,000 fee receivable sit in the books at the cutoff.
  const withOpen = [
    ...ACTUALS.filter(p => p.entryDate! <= '2026-05-31'),
    ...post('2026-05-31', [['5210', 3000], ['2100', -3000]]),
    ...post('2026-05-31', [['1100', 10000], ['4000', -10000]]),
  ]

  it('pays open payables and collects receivables in the first plan month by default', () => {
    const b = buildPlan(base({ actuals: withOpen, rules: [] }))
    const opening = b.entries.filter(e => e.source === 'opening')
    expect(opening.map(e => [e.accountId, e.entryDate])).toEqual([['a1100', '2026-06-30'], ['a2100', '2026-06-30']])
    const cash = opening.flatMap(e => e.postings).filter(p => p.accountId === 'a1000').reduce((s, p) => s + p.amount, 0)
    expect(cash).toBe(7000)
    for (const e of opening) expect(e.postings.reduce((s, p) => s + p.amount, 0)).toBe(0)
  })

  it('can leave them open, and says so', () => {
    const b = buildPlan(base({ actuals: withOpen, rules: [], openingSettlementMonths: 0 }))
    expect(b.entries.filter(e => e.source === 'opening')).toEqual([])
    expect(b.warnings.some(w => w.includes('2100') && w.includes('not forecast to settle'))).toBe(true)
  })

  it("never settles a fund's Due from LPs as if it were trade receivables", () => {
    const fund = ACCOUNTS.map(a => (a.code === '1100' ? { ...a, subtype: 'receivable' } : a))
    const b = buildPlan(base({ vehicleKind: 'fund', accounts: fund, actuals: withOpen, rules: [] }))
    expect(b.entries.some(e => e.accountId === 'a1100')).toBe(false)
  })
})

describe('fund plans with construction (acceptance #10, #11)', () => {
  const FUND: Account[] = DEFAULT_CHART.map(a => ({ id: `f${a.code}`, fundId: 'f', code: a.code, name: a.name, type: a.type, subtype: a.subtype ?? null }))
  const mc = {
    asOfMonth: '2026-06',
    reconciliation: [],
    warnings: [],
    byMonth: new Map(),
    events: [
      { month: '2026-08', flow: 'called', amount: 1_100_000, timing: 'inferred' },
      { month: '2026-08', flow: 'invested', amount: 1_000_000, deal: 'Acme', timing: 'stated' },
      { month: '2026-08', flow: 'fees', amount: 20_000, timing: 'inferred' },
      { month: '2027-02', flow: 'proceeds', amount: 3_000_000, cost: 1_000_000, deal: 'Acme', timing: 'stated' },
      { month: '2027-02', flow: 'distributed', amount: 2_900_000, timing: 'inferred' },
    ],
  } as any
  const feeDriver = { amounts: new Map([['2026-08', 20_000]]), basis: 'Construction fees', warnings: [] }
  const built = buildPlan(base({
    vehicleKind: 'fund', accounts: FUND, actuals: [], rules: [
      { id: 'r-fee', accountId: 'f5000', rule: validateRule('linked_construction', { flow: 'fees' }), cashTiming: { mode: 'same' } },
    ],
    linked: new Map([['r-fee', [feeDriver]]]),
    construction: mc,
  }))
  const postings = built.entries.flatMap(e => e.postings.map(p => ({ ...p, entryDate: e.entryDate })))
  const report = buildReport({
    view: 'plan', accounts: FUND, actuals: [], plan: postings, planFirst: built.first, cutoff: null,
    actualsAvailableThrough: '2026-05', closedThrough: null, start: '2026-06', end: '2027-05', interval: 'month',
    planEntries: built.entries.map(e => ({ date: e.entryDate, kind: e.kind, postings: e.postings })),
    actualEntries: [],
  })

  it('keeps calls and distributions off the P&L; the gain alone is income', () => {
    expect(report.lines.map(l => l.code).sort()).toEqual(['4000', '5000'])
    expect(report.revenue.reduce((a, b) => a + b, 0)).toBe(2_000_000)
    expect(report.expenses.reduce((a, b) => a + b, 0)).toBe(20_000)
  })

  it('moves cash by every flow and the fee once — never twice', () => {
    const aug = report.cash[report.months.findIndex(m => m.month === '2026-08')]!
    expect(aug.movement).toBe(1_100_000 - 1_000_000 - 20_000)
    expect(built.entries.filter(e => e.source === 'construction').some(e => e.memo.includes('fee'))).toBe(false)
  })

  it('the cash timeline splits each month by what moved it, and re-adds to the movement (chart 5)', () => {
    const f = report.cashFlows!
    const i = report.months.findIndex(m => m.month === '2026-08')
    expect([f.called[i], f.invested[i], f.operating[i]]).toEqual([1_100_000, -1_000_000, -20_000])
    const j = report.months.findIndex(m => m.month === '2027-02')
    expect([f.proceeds[j], f.distributed[j]]).toEqual([3_000_000, -2_900_000])
    report.cash.forEach((c, k) => expect(f.operating[k] + f.invested[k] + f.proceeds[k] + f.called[k] + f.distributed[k]).toBeCloseTo(c!.movement, 2))
  })

  it('every construction entry balances', () => {
    for (const e of built.entries) expect(e.postings.reduce((s, p) => s + p.amount, 0)).toBeCloseTo(0, 6)
  })

  it('a linked rule with no source forecasts nothing and says so', () => {
    const b = buildPlan(base({ rules: [{ id: 'x', accountId: 'a4000', rule: validateRule('linked_fee', {}), cashTiming: { mode: 'same' } }] }))
    expect(b.entries).toEqual([])
    expect(b.rules[0].warnings[0]).toMatch(/No linked source/)
  })
})
