import { describe, expect, it } from 'vitest'
import type { Account } from '@/lib/accounting/types'
import { DEFAULT_CHART, GP_ENTITY_CHART } from '@/lib/accounting/chart'
import { buildPlan, gpShareEntries, type BuildPlanInput } from './plan'
import { entriesFingerprint } from './service'
import type { MonthlyConstruction } from './construction-adapter'

const chart = (seed: typeof DEFAULT_CHART): Account[] =>
  seed.map(a => ({ id: `a${a.code}`, fundId: 'f', code: a.code, name: a.name, type: a.type, subtype: a.subtype ?? null }))
const FUND = chart(DEFAULT_CHART)
const GP = chart(GP_ENTITY_CHART)

const plan = (over: Partial<BuildPlanInput>): BuildPlanInput => ({
  kind: 'rolling', fiscalYear: null, startMonth: '2027-01', endMonth: '2027-12', horizonMonths: null, cutoff: '2026-12',
  vehicleKind: 'fund', accounts: FUND, actuals: [], closedFrom: null, closedThrough: null, rules: [], overrides: [], currency: 'USD',
  ...over,
} as BuildPlanInput)

const mc = (events: MonthlyConstruction['events']): MonthlyConstruction => ({ asOfMonth: '2026-12', events, byMonth: new Map(), reconciliation: [], warnings: [] })

describe('construction flows on a fund forecast', () => {
  it("brings construction's fees and expenses onto accounts with no rule of their own", () => {
    const built = buildPlan(plan({ construction: mc([
      { month: '2027-03', flow: 'fees', amount: 1000, timing: 'inferred' },
      { month: '2027-03', flow: 'expenses', amount: 250, timing: 'inferred' },
    ]) }))
    const onAccount = (code: string) => built.entries.flatMap(e => e.postings).filter(p => p.accountId === `a${code}`).reduce((s, p) => s + p.amount, 0)
    expect(onAccount('5000')).toBe(1000)
    expect(onAccount('5100')).toBe(250)
  })

  it("keeps an account's own rule, and says what construction would have put there", () => {
    const built = buildPlan(plan({
      rules: [{ id: 'r', accountId: 'a5000', rule: { method: 'fixed', params: { amount: 2100 } } as any, cashTiming: { mode: 'prepaid' } }],
      construction: mc([{ month: '2027-03', flow: 'fees', amount: 1000, timing: 'inferred' }]),
    }))
    const fee = built.entries.flatMap(e => e.postings).filter(p => p.accountId === 'a5000').reduce((s, p) => s + p.amount, 0)
    expect(fee).toBe(2100 * 12)
    expect(built.rules.find(r => r.accountId === 'a5000')?.warnings.join(' ')).toMatch(/construction has 1,000 of management fees/)
  })
})

describe("a GP entity's share of its fund", () => {
  const share = (months: [string, { called: number; distributed: number; carry: number }][]) =>
    ({ fund: 'Fund I', months: new Map(months), basis: '', warnings: [] }) as any

  it('books its calls at cost, returns cost first then earnings, and takes carry as income', () => {
    const r = gpShareEntries({ accounts: GP, currency: 'USD', actuals: [] }, share([
      ['2027-02', { called: 100, distributed: 0, carry: 0 }],
      ['2027-09', { called: 0, distributed: 250, carry: 80 }],
    ]), '2027-01', '2027-12', 'a1000')
    const sum = (code: string) => r.entries.flatMap(e => e.postings).filter(p => p.accountId === `a${code}`).reduce((s, p) => s + p.amount, 0)
    expect(sum('1500')).toBe(0)        // 100 in, 100 returned
    expect(sum('4100')).toBe(-150)     // the rest of the distribution is earnings
    expect(sum('4000')).toBe(-80)      // carry
    expect(sum('1000')).toBe(-100 + 250 + 80)
  })
})

describe('a draft out of date with its sources', () => {
  it('compares what the entries say, not how they are split into rows', () => {
    const a = [{ date: '2027-01-31', postings: [{ accountId: 'x', amount: 5 }, { accountId: 'c', amount: -5 }] }]
    const b = [{ date: '2027-01-31', postings: [{ accountId: 'x', amount: 2 }, { accountId: 'c', amount: -2 }] },
      { date: '2027-01-31', postings: [{ accountId: 'x', amount: 3 }, { accountId: 'c', amount: -3 }] }]
    expect(entriesFingerprint(a)).toBe(entriesFingerprint(b))
    expect(entriesFingerprint(a)).not.toBe(entriesFingerprint([{ date: '2027-01-31', postings: [{ accountId: 'x', amount: 6 }, { accountId: 'c', amount: -6 }] }]))
  })
})
