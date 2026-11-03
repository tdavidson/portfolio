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

describe('accrual and cash basis', () => {
  // Rent accrued in January, paid in February; fee income earned and received in January.
  const entries = [
    e('2026-01-05', [['op', 50_000], ['fee', -50_000]]),
    e('2026-01-31', [['rent', 8_000], ['ap', -8_000]]),
    e('2026-02-10', [['ap', 8_000], ['op', -8_000]]),
  ]
  const r = buildReport({
    view: 'actual', accounts: A, actuals: entries.flatMap(x => x.postings), plan: [], planFirst: null, cutoff: null,
    actualsAvailableThrough: '2026-02', closedThrough: '2026-02', start: '2026-01', end: '2026-02', interval: 'month',
    actualEntries: entries, planEntries: [],
  })

  it('cash basis: income when received, an accrued expense when it is paid, against its own account', () => {
    expect(r.cashBasis!.revenue).toEqual([50_000, 0])
    expect(r.cashBasis!.lines.find(l => l.accountId === 'rent')!.values).toEqual([0, 8_000])
    expect(r.cashBasis!.accruals).toEqual([0, 0])
    expect(r.cashBasis!.netIncome).toEqual([50_000, -8_000])
  })

  it('indirect method: net income plus the change in payables is the operating cash', () => {
    expect(r.indirect!.netIncome).toEqual([42_000, 0])
    expect(r.indirect!.workingCapital).toEqual([8_000, -8_000])
    expect(r.indirect!.operating).toEqual([50_000, -8_000])
  })
})

describe('distributions, broken down', () => {
  const A2: Account[] = [...A, { id: 'cap', fundId: 'f', code: '3100', name: 'Partners capital', type: 'equity' } as Account]
  const plan = [
    { date: '2027-03-31', kind: 'distribution', memo: 'Distribution to the LPs', postings: [{ accountId: 'cap', amount: 900, currency: 'USD', entryDate: '2027-03-31' }, { accountId: 'op', amount: -900, currency: 'USD', entryDate: '2027-03-31' }] },
    { date: '2027-03-31', kind: 'distribution', memo: 'Distribution to the GP, on its own commitment', postings: [{ accountId: 'cap', amount: 10, currency: 'USD', entryDate: '2027-03-31' }, { accountId: 'op', amount: -10, currency: 'USD', entryDate: '2027-03-31' }] },
    { date: '2027-03-31', kind: 'distribution', memo: 'Carried interest to GP I LLC', postings: [{ accountId: 'cap', amount: 90, currency: 'USD', entryDate: '2027-03-31' }, { accountId: 'op', amount: -90, currency: 'USD', entryDate: '2027-03-31' }] },
  ]
  const r = buildReport({
    view: 'plan', accounts: A2, actuals: [], plan: plan.flatMap(x => x.postings), planFirst: '2027-01', planLast: '2027-12', cutoff: '2026-12',
    actualsAvailableThrough: '2026-12', closedThrough: null, start: '2027-03', end: '2027-03', interval: 'month', actualEntries: [], planEntries: plan,
  } as any)
  const v = (key: string) => r.cashDetail!.find(l => l.key === key)?.values[0]

  it('keeps one Distributions line, with the LPs, the GP and the carry beneath it', () => {
    expect(v('distributed')).toBe(-1000)
    expect(v('distributed:lp')).toBe(-900)
    expect(v('distributed:gp')).toBe(-10)
    expect(v('distributed:carry')).toBe(-90)
    expect(r.cashDetail!.find(l => l.key === 'distributed:carry')?.parent).toBe('distributed')
  })
})

describe('cash that settles an earlier accrual', () => {
  const B: Account[] = [
    ...A,
    { id: 'due', fundId: 'f', code: '1300', name: 'Due from LPs', type: 'asset', subtype: 'receivable' },
    { id: 'accrued', fundId: 'f', code: '2100', name: 'Accrued expenses', type: 'liability', subtype: 'accrued_liability' },
    { id: 'cap', fundId: 'f', code: '3000', name: "Partners' capital", type: 'equity' },
    { id: 'mgmt', fundId: 'f', code: '5000', name: 'Management fee', type: 'expense', subtype: 'management_fee' },
  ]
  const lp = (date: string, legs: [string, number, string?][]) => ({
    date, postings: legs.map(([accountId, amount, lpEntityId]) => ({ accountId, amount, currency: 'USD', entryDate: date, lpEntityId: lpEntityId ?? null })) as Posting[],
  })
  const run = (entries: { date: string; postings: Posting[] }[], start = '2025-12', end = '2026-03') => buildReport({
    view: 'actual', accounts: B, actuals: entries.flatMap(x => x.postings), plan: [], planFirst: null, cutoff: null,
    actualsAvailableThrough: end, closedThrough: null, start, end, interval: 'month',
    actualEntries: entries, planEntries: [],
  })

  it('a call booked to a receivable and collected later is capital called when the wire lands', () => {
    const r = run([
      lp('2026-01-02', [['due', 100_000], ['cap', -60_000, 'lp-a'], ['cap', -40_000, 'lp-b']]),
      lp('2026-01-20', [['op', 60_000], ['due', -60_000]]),
      lp('2026-02-05', [['op', 40_000], ['due', -40_000]]),
    ])
    expect(r.cashFlows!.called).toEqual([0, 60_000, 40_000, 0])
    expect(r.cashFlows!.operating).toEqual([0, 0, 0, 0])
    expect(r.cashDetail!.find(l => l.key === 'due')).toBeUndefined()
  })

  it('a fee accrued to a payable and paid later is management fee cash', () => {
    const r = run([
      lp('2026-01-31', [['mgmt', 25_000], ['accrued', -25_000]]),
      lp('2026-02-28', [['mgmt', 25_000], ['accrued', -25_000]]),
      lp('2026-03-10', [['accrued', 50_000], ['op', -50_000]]),
    ])
    expect(r.cashDetail!.find(l => l.key === 'mgmt')!.values).toEqual([0, 0, 0, -50_000])
    expect(r.cashDetail!.find(l => l.key === 'accrued')).toBeUndefined()
    expect(r.cashBasis!.accruals).toEqual([0, 0, 0, 0])
  })

  it('matches oldest first, even when the accrual falls before the range', () => {
    const r = run([
      lp('2025-11-30', [['mgmt', 10_000], ['accrued', -10_000]]),
      lp('2026-01-15', [['accrued', 4_000], ['op', -4_000]]),
    ], '2026-01', '2026-01')
    expect(r.cashDetail!.find(l => l.key === 'mgmt')!.values).toEqual([-4_000])
  })

  it('leaves what no accrual covers on the balance it cleared, and every total unchanged', () => {
    const entries = [
      lp('2026-01-02', [['due', 30_000], ['cap', -30_000]]),
      lp('2026-01-20', [['op', 50_000], ['due', -50_000]]),
    ]
    const r = run(entries)
    expect(r.cashFlows!.called[1]).toBe(30_000)
    expect(r.cashDetail!.find(l => l.key === 'due')!.values[1]).toBe(20_000)
    expect(r.cash[1]!.ending).toBe(50_000)
  })

  it('wires received before the call is booked are capital called once it is', () => {
    const r = run([
      lp('2026-01-10', [['op', 30_000], ['due', -30_000]]),
      lp('2026-01-12', [['op', 70_000], ['due', -70_000]]),
      lp('2026-02-01', [['due', 100_000], ['cap', -100_000, 'lp-a']]),
    ])
    expect(r.cashFlows!.called).toEqual([0, 100_000, 0, 0])
    expect(r.cashFlows!.operating).toEqual([0, 0, 0, 0])
    expect(r.cashDetail!.find(l => l.key === 'due')).toBeUndefined()
  })

  it('a transfer between two LPs on the receivable leaves the call to be collected as it was', () => {
    const r = run([
      lp('2026-01-02', [['due', 50_000], ['cap', -50_000, 'lp-a']]),
      lp('2026-01-03', [['due', -5_000, 'lp-a'], ['due', 5_000, 'lp-b']]),
      lp('2026-01-20', [['op', 50_000], ['due', -50_000]]),
    ])
    expect(r.cashFlows!.called[1]).toBe(50_000)
    expect(r.cashDetail!.find(l => l.key === 'due')).toBeUndefined()
  })

  it('a reclass on a payable does not stop later payments matching their accruals', () => {
    const r = run([
      lp('2025-12-31', [['mgmt', 20_000], ['accrued', -20_000]]),
      lp('2026-01-01', [['accrued', 500], ['mgmt', -500]]),
      lp('2026-01-05', [['accrued', 19_500], ['op', -19_500]]),
      lp('2026-02-01', [['mgmt', 15_000], ['accrued', -15_000]]),
      lp('2026-02-02', [['accrued', 15_000], ['op', -15_000]]),
    ], '2026-01', '2026-02')
    expect(r.cashDetail!.find(l => l.key === 'mgmt')!.values).toEqual([-19_500, -15_000])
    expect(r.cashDetail!.find(l => l.key === 'accrued')).toBeUndefined()
  })

  it('a distribution declared to a payable and paid later is split by whose capital it reduced', () => {
    const C: Account[] = [...B, { id: 'dp', fundId: 'f', code: '2200', name: 'Distributions payable', type: 'liability', subtype: 'distributions_payable' }]
    const entries = [
      lp('2026-01-31', [['cap', 90_000, 'lp-a'], ['cap', 10_000, 'gp-1'], ['dp', -100_000]]),
      lp('2026-02-10', [['dp', 100_000], ['op', -100_000]]),
    ]
    const r = buildReport({
      view: 'actual', accounts: C, actuals: entries.flatMap(x => x.postings), plan: [], planFirst: null, cutoff: null,
      actualsAvailableThrough: '2026-02', closedThrough: null, start: '2026-02', end: '2026-02', interval: 'month',
      actualEntries: entries, planEntries: [], gpEntityIds: new Set(['gp-1']),
    })
    expect(r.cashFlows!.distributed).toEqual([-100_000])
    expect(r.cashDetail!.find(l => l.key === 'distributed:gp')!.values).toEqual([-10_000])
  })
})
