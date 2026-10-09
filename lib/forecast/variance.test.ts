import { describe, expect, it } from 'vitest'
import type { Account, Posting } from '@/lib/accounting/types'
import { buildReport } from './report'
import { computeVariance, largestVariances, varianceCell } from './variance'

const ACCOUNTS: Account[] = [
  { id: 'cash', fundId: 'f', code: '1000', name: 'Cash', type: 'asset', subtype: 'cash' },
  { id: 'fee', fundId: 'f', code: '4000', name: 'Fees', type: 'income' },
  { id: 'sal', fundId: 'f', code: '5000', name: 'Salaries', type: 'expense' },
  { id: 'rent', fundId: 'f', code: '5100', name: 'Rent', type: 'expense' },
]

const p = (date: string, account: string, natural: number, type: 'income' | 'expense'): Posting[] => {
  const s = type === 'income' ? -natural : natural
  return [
    { accountId: account, amount: s, currency: 'USD', entryDate: date },
    { accountId: 'cash', amount: -s, currency: 'USD', entryDate: date },
  ]
}

const months = ['01', '02', '03', '04', '05', '06']
// Budget: fees 100/mo, salaries 60/mo, rent 0 (not budgeted).
const BUDGET = months.flatMap(m => [...p(`2026-${m}-28`, 'fee', 100, 'income'), ...p(`2026-${m}-28`, 'sal', 60, 'expense')])
// Actuals Jan–Apr: fees 90, salaries 70, rent 15.
const ACTUALS = months.slice(0, 4).flatMap(m => [
  ...p(`2026-${m}-15`, 'fee', 90, 'income'), ...p(`2026-${m}-15`, 'sal', 70, 'expense'), ...p(`2026-${m}-15`, 'rent', 15, 'expense'),
])

const report = (view: 'plan' | 'actual') =>
  buildReport({
    view, accounts: ACCOUNTS, actuals: ACTUALS, plan: BUDGET, planFirst: '2026-01', cutoff: null,
    actualsAvailableThrough: '2026-04', closedThrough: '2026-03', start: '2026-01', end: '2026-06', interval: 'month',
  })

describe('varianceCell (acceptance #8)', () => {
  it('reads expense signs the right way round', () => {
    expect(varianceCell(60, 70, 'expense')).toMatchObject({ diff: 10, favorable: false })
    expect(varianceCell(60, 50, 'expense')).toMatchObject({ diff: -10, favorable: true })
    expect(varianceCell(100, 90, 'income')).toMatchObject({ diff: -10, favorable: false })
  })

  it('has no percentage against a zero base, and no verdict on no difference', () => {
    expect(varianceCell(0, 10, 'expense')).toMatchObject({ pct: null, favorable: false })
    expect(varianceCell(5, 5, 'income')).toMatchObject({ diff: 0, favorable: null })
  })
})

describe('computeVariance', () => {
  const v = (interval: 'month' | 'quarter' | 'year') =>
    computeVariance({ base: report('plan'), compare: report('actual'), interval, actualMonthsOnly: true })

  it('leaves months without actuals out of both sides and marks the period partial', () => {
    const q = v('quarter')
    expect(q.periods.map(x => [x.key, x.months.length, x.partial])).toEqual([['2026-Q1', 3, false], ['2026-Q2', 1, true]])
    // Q2 compares April only: 90 vs 100, not 90 vs 300.
    expect(q.revenue[1]).toMatchObject({ base: 100, compare: 90, diff: -10 })
  })

  it('sums monthly dollars and recomputes the percentage — never averages percentages', () => {
    const y = v('year')
    expect(y.expenses[0]).toMatchObject({ base: 240, compare: 340, diff: 100 })
    expect(y.expenses[0]!.pct).toBe(0.4167)
    expect(y.totals.netIncome).toMatchObject({ base: 160, compare: 20, diff: -140, favorable: false })
    const sum = v('month').expenses.reduce((s, c) => s + (c?.diff ?? 0), 0)
    expect(sum).toBe(y.expenses[0]!.diff)
  })

  it('includes an unbudgeted account against a zero base', () => {
    const rent = v('year').lines.find(l => l.accountId === 'rent')!
    expect(rent.total).toMatchObject({ base: 0, compare: 60, pct: null, favorable: false })
  })

  it('ranks the largest misses by dollars', () => {
    expect(largestVariances(v('year'), { type: 'expense' }).map(x => x.code)).toEqual(['5100', '5000'])
    expect(largestVariances(v('year'), { type: 'expense' })[1].diff).toBe(40)
  })
})

describe('computeVariance window', () => {
  it('compares only the months the base plan covers', () => {
    const v = computeVariance({ base: report('plan'), compare: report('actual'), interval: 'year', actualMonthsOnly: true, window: { first: '2026-03', last: '2026-12' } })
    expect(v.periods[0].months).toEqual(['2026-03', '2026-04'])
    expect(v.revenue[0]).toMatchObject({ base: 200, compare: 180 })
  })
})
