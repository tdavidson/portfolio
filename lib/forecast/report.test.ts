import { describe, expect, it } from 'vitest'
import type { Account, Posting } from '@/lib/accounting/types'
import { buildReport } from './report'

const A: Account[] = [
  { id: 'op', fundId: 'f', code: '1000', name: 'Cash — operating', type: 'asset', subtype: 'cash' },
  { id: 'res', fundId: 'f', code: '1050', name: 'Cash — reserve', type: 'asset', subtype: 'cash' },
  { id: 'ap', fundId: 'f', code: '2000', name: 'Accounts payable', type: 'liability', subtype: 'accounts_payable' },
  { id: 'fee', fundId: 'f', code: '4000', name: 'Fee income', type: 'income' },
  { id: 'rent', fundId: 'f', code: '5100', name: 'Rent', type: 'expense' },
  { id: 'loan', fundId: 'f', code: '2500', name: 'Note payable', type: 'liability', subtype: 'note_payable' },
]
const e = (date: string, legs: [string, number][]) => ({ date, postings: legs.map(([accountId, amount]) => ({ accountId, amount, currency: 'USD', entryDate: date })) as Posting[] })

const ENTRIES = [
  e('2026-01-05', [['op', 50_000], ['fee', -50_000]]),
  e('2026-01-10', [['rent', 8_000], ['op', -8_000]]),
  e('2026-01-20', [['ap', 3_000], ['op', -3_000]]),
  e('2026-01-25', [['res', 10_000], ['op', -10_000]]),
  e('2026-01-28', [['op', 20_000], ['loan', -20_000]]),
]

describe('cash-flow statement (actuals)', () => {
  const r = buildReport({
    view: 'actual', accounts: A, actuals: ENTRIES.flatMap(x => x.postings), plan: [], planFirst: null, cutoff: null,
    actualsAvailableThrough: '2026-01', closedThrough: '2026-01', start: '2026-01', end: '2026-01', interval: 'month',
    actualEntries: ENTRIES, planEntries: [],
  })
  const v = (key: string) => r.cashDetail!.find(l => l.key === key)?.values[0]

  it('shows receipts and payments by account, a bill paid against its payable, and borrowing as financing', () => {
    expect(v('fee')).toBe(50_000)
    expect(v('rent')).toBe(-8_000)
    expect(v('ap')).toBe(-3_000)
    expect(r.cashDetail!.find(l => l.key === 'borrowed')).toMatchObject({ section: 'financing', values: [20_000] })
  })

  it('splits money borrowed from money repaid', () => {
    const repay = e('2026-01-29', [['loan', 5_000], ['op', -5_000]])
    const r2 = buildReport({
      view: 'actual', accounts: A, actuals: [...ENTRIES, repay].flatMap(x => x.postings), plan: [], planFirst: null, cutoff: null,
      actualsAvailableThrough: '2026-01', closedThrough: '2026-01', start: '2026-01', end: '2026-01', interval: 'month',
      actualEntries: [...ENTRIES, repay], planEntries: [],
    })
    expect(r2.cashDetail!.find(l => l.key === 'borrowed')).toMatchObject({ label: 'Borrowings', values: [20_000] })
    expect(r2.cashDetail!.find(l => l.key === 'repaid')).toMatchObject({ label: 'Loan repayments', section: 'financing', values: [-5_000] })
    expect(r2.cashFlows!.repaid[0]).toBe(-5_000)
  })

  it('shows repaying a loan that bought an investment as investing in it', () => {
    const inv: Account = { id: 'inv', fundId: 'f', code: '1100', name: 'Investment — Acme', type: 'asset', subtype: 'investment', companyId: 'c1' }
    const cap: Account = { id: 'cap', fundId: 'f', code: '3100', name: 'LP capital', type: 'equity', subtype: 'lp_capital' }
    const accts = [...A, inv, cap]
    const flows = [
      e('2026-01-02', [['inv', 2_750_000], ['loan', -2_750_000]]), // lender paid the company directly
      e('2026-01-20', [['op', 2_400_000], ['cap', -2_400_000]]),
      e('2026-01-24', [['loan', 2_380_000], ['op', -2_380_000]]),
    ]
    const r3 = buildReport({
      view: 'actual', accounts: accts, actuals: flows.flatMap(x => x.postings), plan: [], planFirst: null, cutoff: null,
      actualsAvailableThrough: '2026-01', closedThrough: '2026-01', start: '2026-01', end: '2026-01', interval: 'month',
      actualEntries: flows, planEntries: [],
    })
    expect(r3.cashFlows!.invested[0]).toBe(-2_380_000)
    expect(r3.cashFlows!.repaid[0]).toBe(0)
    expect(r3.cashFlows!.called[0]).toBe(2_400_000)
  })

  it('a sweep to the reserve moves no cash in total, but shows on each account', () => {
    expect(r.cashDetail!.some(l => l.key === 'res')).toBe(false)
    expect(r.cashAccounts.map(a => [a.code, a.ending[0]])).toEqual([['1000', 49_000], ['1050', 10_000]])
    expect(r.cash[0]!.movement).toBe(59_000)
    expect(r.cashDetail!.reduce((s, l) => s + l.values[0], 0)).toBe(59_000)
  })
})

describe('months with no data', () => {
  const base = {
    accounts: A, actuals: ENTRIES.flatMap(x => x.postings), plan: [], planFirst: null, cutoff: null,
    closedThrough: '2026-01', start: '2026-01', end: '2026-12', actualEntries: ENTRIES, planEntries: [],
  }

  it('with no plan, months past the actuals are "none", not a forecast of zero', () => {
    const r = buildReport({ ...base, view: 'actual', actualsAvailableThrough: '2026-02', interval: 'month' })
    expect(r.months.map(m => m.status).slice(0, 3)).toEqual(['actual', 'actual_unclosed', 'none'])
    expect(r.periods[11].status).toBe('none')
    expect(r.cash[11]).toBeNull()
    expect(r.boundary).toBe('2026-02')
  })

  it('a quarter cut short by the actuals is actual and partial, with cash from its data months', () => {
    const r = buildReport({ ...base, view: 'actual', actualsAvailableThrough: '2026-02', interval: 'quarter' })
    expect(r.periods[0]).toMatchObject({ status: 'actual_unclosed', partial: true })
    expect(r.periods[1]).toMatchObject({ status: 'none', partial: false })
    expect(r.cash[0]).toMatchObject({ opening: 0, ending: 59_000 })
    expect(r.cash[1]).toBeNull()
  })

  it('a plan view past the plan window is "none"', () => {
    const r = buildReport({ ...base, view: 'combined', cutoff: '2026-01', planFirst: '2026-02', planLast: '2026-06', actualsAvailableThrough: '2026-01', interval: 'month' })
    expect(r.months.find(m => m.month === '2026-06')?.status).toBe('forecast')
    expect(r.months.find(m => m.month === '2026-07')?.status).toBe('none')
  })
})
