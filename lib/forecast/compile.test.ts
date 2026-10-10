import { describe, expect, it } from 'vitest'
import type { Account, Posting } from '@/lib/accounting/types'
import { MANAGEMENT_COMPANY_CHART, DEFAULT_CHART } from '@/lib/accounting/chart'
import { aggregateBalance, aggregateFlow, monthRange, periods } from './months'
import { cashMonth, compileForecast, counterAccountsFor, validateCashTiming, type CompileLine } from './compile'
import { monthlyStatement } from './statement'
import { evaluateRule, validateRule } from './rules'

const chart = (seed: typeof MANAGEMENT_COMPANY_CHART): Account[] =>
  seed.map(a => ({ id: `a${a.code}`, fundId: 'f', code: a.code, name: a.name, type: a.type, subtype: a.subtype ?? null }))

const MANCO = chart(MANAGEMENT_COMPANY_CHART)
const acct = (code: string) => MANCO.find(a => a.code === code)!
const counters = counterAccountsFor('manco', MANCO)!
const YEAR = monthRange('2026-01', '2026-12')
const NO_HISTORY = { actuals: new Map(), closedFrom: null, closedThrough: null, cutoff: null }

const line = (code: string, method: string, params: unknown, timing?: unknown): CompileLine => ({
  account: acct(code),
  ruleId: `r${code}`,
  amounts: new Map([...evaluateRule(validateRule(method, params), YEAR, NO_HISTORY).amounts].map(([m, amount]) => [m, { amount }])),
  timing: validateCashTiming(timing),
})

const compile = (lines: CompileLine[]) =>
  compileForecast(lines, { firstMonth: '2026-01', lastMonth: '2026-12', currency: 'USD', counters })

const statementOf = (postings: Posting[]) =>
  monthlyStatement({ accounts: MANCO, postings, months: YEAR, actualsThrough: null, closedThrough: null })

const flat = (r: ReturnType<typeof compile>) =>
  r.entries.flatMap(e => e.postings.map(p => ({ ...p, entryDate: e.entryDate })))

describe('cash timing', () => {
  it('maps advance and arrears to the right payment month', () => {
    const sept = { mode: 'month', month: 9, direction: 'advance' } as const
    expect(cashMonth('2026-09', sept)).toBe('2026-09')
    expect(cashMonth('2027-08', sept)).toBe('2026-09')
    expect(cashMonth('2026-10', { mode: 'month', month: 12, direction: 'arrears' })).toBe('2026-12')
    expect(cashMonth('2026-01', { mode: 'offset', months: -2 })).toBe('2025-11')
  })

  it('rejects malformed timing', () => {
    expect(() => validateCashTiming({ mode: 'offset', months: 1.5 })).toThrow()
    expect(() => validateCashTiming({ mode: 'month', month: 13, direction: 'advance' })).toThrow()
  })
})

describe('compileForecast', () => {
  it('every entry balances and P&L reconciles to the rule amounts', () => {
    const r = compile([
      line('5210', 'recurring', { amount: 12000, everyMonths: 12, anchor: '2026-03' }),
      line('5000', 'fixed', { amount: 40000 }, { mode: 'offset', months: 1 }),
      line('4000', 'fixed', { amount: 100000 }, { mode: 'offset', months: -1 }),
    ])
    for (const e of r.entries) expect(e.postings.reduce((s, p) => s + p.amount, 0)).toBeCloseTo(0, 8)
    const st = statementOf(flat(r))
    expect(aggregateFlow(new Map(Object.entries(st.expenses)), periods('2026-01', '2026-12', 'year'))).toEqual([12000 + 480000])
    expect(st.revenue['2026-06']).toBe(100000)
  })

  it('separates P&L from cash: annual premium paid in September, recognised monthly', () => {
    const r = compile([line('5600', 'fixed', { amount: 800 }, { mode: 'month', month: 9, direction: 'advance' })])
    const st = statementOf(flat(r))
    expect(st.expenses['2026-09']).toBe(800)
    // Jan–Aug were paid in a September before the plan: release only, flagged.
    expect(st.cash['2026-03'].movement).toBe(0)
    // September pays Sep–Dec inside the plan (Jan–Aug of next year fall outside it).
    expect(st.cash['2026-09'].movement).toBe(-3200)
    expect(r.warnings.get('a5600')?.some(w => w.includes('before its first month'))).toBe(true)
  })

  it('accrues and pays later, leaving the last month on the balance sheet', () => {
    const r = compile([line('5000', 'fixed', { amount: 100 }, { mode: 'offset', months: 1 })])
    const st = statementOf(flat(r))
    expect(st.cash['2026-01'].movement).toBe(0)
    expect(st.cash['2026-02'].movement).toBe(-100)
    expect(st.cash['2026-12'].ending).toBe(-1100)
    expect(r.warnings.get('a5000')?.[0]).toMatch(/after its last month/)
  })

  it('falls back to same-month cash, with a warning, when the chart lacks the counter-account', () => {
    const fund = chart(DEFAULT_CHART)
    const fc = counterAccountsFor('fund', fund)!
    expect(fc.receivable).toBeUndefined()
    const income = fund.find(a => a.type === 'income')!
    const r = compileForecast(
      [{ account: income, ruleId: null, amounts: new Map([['2026-02', { amount: 50 }]]), timing: { mode: 'offset', months: 2 } }],
      { firstMonth: '2026-01', lastMonth: '2026-12', currency: 'USD', counters: fc },
    )
    expect(r.entries).toHaveLength(1)
    expect(r.entries[0].postings.find(p => p.accountId === fc.cash)?.amount).toBe(50)
    expect(r.warnings.get(income.id)?.[0]).toMatch(/No receivable/)
  })

  it('draws a fee paid before the plan down from prepaid, with no cash in the plan', () => {
    // Bluefish: a 10-year fee prepaid in March 2026, expensed 2,100 a month.
    const fund = chart(DEFAULT_CHART)
    const fc = counterAccountsFor('fund', fund)!
    const fee = fund.find(a => a.code === '5000')!
    const r = compileForecast(
      [{ account: fee, ruleId: 'r', amounts: new Map([['2026-10', { amount: 2100 }], ['2026-11', { amount: 2100 }]]), timing: validateCashTiming({ mode: 'prepaid' }) }],
      { firstMonth: '2026-10', lastMonth: '2026-12', currency: 'USD', counters: fc },
    )
    expect(r.entries).toHaveLength(2)
    expect(r.entries.every(e => e.kind === 'release')).toBe(true)
    expect(r.entries.flatMap(e => e.postings).some(p => p.accountId === fc.cash)).toBe(false)
    expect(r.entries[0].postings).toEqual([{ accountId: fee.id, amount: 2100, currency: 'USD' }, { accountId: fc.prepaid, amount: -2100, currency: 'USD' }])
  })

  it('records the override that set a month (acceptance #4)', () => {
    const l = line('5300', 'fixed', { amount: 10 })
    l.amounts.set('2026-05', { amount: 99, overrideId: 'o1' })
    const r = compile([l])
    const may = r.entries.filter(e => e.entryDate === '2026-05-31')
    expect(may).toHaveLength(1)
    expect(may[0]).toMatchObject({ source: 'override', overrideId: 'o1', ruleId: 'r5300' })
    expect(r.entries.filter(e => e.source === 'rule')).toHaveLength(11)
  })

  it('skips balance-sheet accounts', () => {
    const r = compile([{ ...line('5300', 'fixed', { amount: 1 }), account: acct('1300') }])
    expect(r.entries).toHaveLength(0)
  })
})

describe('monthlyStatement cash', () => {
  it('opens from prior postings, rolls forward, and quarterly balances are edges not sums (acceptance #7)', () => {
    const postings: Posting[] = [
      { accountId: 'a1000', amount: 1000, currency: 'USD', entryDate: '2025-12-31' },
      { accountId: 'a1050', amount: 500, currency: 'USD', entryDate: '2025-12-31' },
      { accountId: 'a1000', amount: -100, currency: 'USD', entryDate: '2026-01-15' },
      { accountId: 'a1000', amount: -100, currency: 'USD', entryDate: '2026-03-15' },
    ]
    const st = statementOf(postings)
    expect(st.cash['2026-01']).toEqual({ opening: 1500, movement: -100, ending: 1400 })
    expect(st.cash['2026-12'].ending).toBe(1300)
    const q = aggregateBalance(new Map(Object.entries(st.cash)), periods('2026-01', '2026-12', 'quarter'))
    expect(q[0]).toEqual({ opening: 1500, ending: 1300 })
    for (const m of YEAR) expect(st.cash[m].ending).toBe(st.cash[m].opening + st.cash[m].movement)
  })
})

describe('cycle cash timing', () => {
  const q = { mode: 'cycle', everyMonths: 3, anchor: 1, direction: 'advance', lagMonths: 0 } as const
  it('bills a quarter in advance in its first month, or in arrears in its last, plus any lag', () => {
    expect(['2026-01', '2026-02', '2026-03', '2026-04'].map(m => cashMonth(m, q))).toEqual(['2026-01', '2026-01', '2026-01', '2026-04'])
    expect(cashMonth('2026-02', { ...q, direction: 'arrears' })).toBe('2026-03')
    expect(cashMonth('2026-02', { ...q, lagMonths: 1 })).toBe('2026-02')
    expect(cashMonth('2026-12', { ...q, anchor: 2 })).toBe('2026-11')
    expect(() => validateCashTiming({ ...q, everyMonths: 4 })).toThrow()
  })

  it('a quarterly-in-advance fee is deferred revenue at the manco, released monthly', () => {
    const r = compile([line('4000', 'fixed', { amount: 25000 }, q)])
    const st = statementOf(flat(r))
    expect(st.revenue['2026-02']).toBe(25000)
    expect(st.cash['2026-01'].movement).toBe(75000)
    expect(st.cash['2026-02'].movement).toBe(0)
    expect(st.cash['2026-12'].ending).toBe(300000)
  })
})
