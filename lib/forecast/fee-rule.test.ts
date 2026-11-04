import { describe, expect, it } from 'vitest'
import { DEFAULT_ASSUMPTIONS, projectFeesForYear } from '@/lib/accounting/construction'
import { managementFeeByMonth, managementFeeByYear, feeRuleFromConstruction } from './fee-rule'
import { planCostsByYear } from './plan-costs'

const terms = { rate: 0.02, basis: 'committed' as const, termYears: 10, stepDownYear: 6, stepDownRate: 0.015 }
const inputs = { asOfMonth: '2026-10' as const, committed: 20_000_000, deployedTotal: 8_000_000, nav: 9_000_000, feePayingShare: 0.99 }

describe('the management fee as a plan rule', () => {
  it("charges each year exactly what construction's own fee inputs did — step-down and GP exemption included", () => {
    const a = { ...DEFAULT_ASSUMPTIONS, feeAnnualRate: 0.02, feeBasis: 'committed' as const, feeTermYears: 10, feeStepDownYear: 6, feeStepDownRate: 0.015 }
    const byYear = managementFeeByYear(terms, inputs)
    for (let y = 1; y <= 10; y++) {
      expect(byYear[y]).toBeCloseTo(projectFeesForYear(a, 20_000_000, 8_000_000, 9_000_000, y) * 0.99, 2)
    }
    expect(byYear[1]).toBeCloseTo(396_000, 2) // 2% × 20M × 99%
    expect(byYear[6]).toBeCloseTo(297_000, 2) // 1.5% after the step-down
  })

  it('spreads each year over its months to the cent, starting the month after the as-of month', () => {
    const m = managementFeeByMonth(terms, inputs)
    expect(m.get('2026-10')).toBeUndefined()
    expect(m.get('2026-11')).toBe(33_000)
    const firstYear = [...m].filter(([k]) => k >= '2026-11' && k <= '2027-10').reduce((s, [, v]) => s + v, 0)
    expect(firstYear).toBeCloseTo(396_000, 2)
  })

  it('stops after the fund\'s last modelled exit', () => {
    expect(managementFeeByYear(terms, { ...inputs, lastOperatingYear: 4 }).slice(5).every(v => v === 0)).toBe(true)
  })

  it("is made from construction's old fee inputs, and not at all when it charged none", () => {
    expect(feeRuleFromConstruction({ feeAnnualRate: 0.02, feeBasis: 'invested', feeTermYears: 8, feeStepDownYear: null, feeStepDownRate: null }))
      .toEqual({ rate: 0.02, basis: 'invested', termYears: 8, stepDownYear: null, stepDownRate: null })
    expect(feeRuleFromConstruction({ feeAnnualRate: 0, feeBasis: 'committed', feeTermYears: 8, feeStepDownYear: null, feeStepDownRate: null })).toBeNull()
  })
})

describe("a plan's costs, for construction's capital planning", () => {
  const accounts = [{ id: 'fee', type: 'expense', subtype: 'management_fee' }, { id: 'exp', type: 'expense', subtype: 'partnership_expense' }]
  // From December each calendar row is exactly one forward year, so these read as whole years.
  const december = { ...inputs, asOfMonth: '2026-12' as const }

  it('sums the fee rule and the expense rules into calendar years', () => {
    const c = planCostsByYear({
      rules: [
        { accountId: 'fee', method: 'management_fee', params: terms },
        { accountId: 'exp', method: 'fixed', params: { amount: 5_000 } },
      ],
      accounts, history: new Map(), closedFrom: null, closedThrough: null, horizonYears: 10, fee: december,
    })!
    expect(c.feesByYear[1]).toBeCloseTo(396_000, 2)
    expect(c.expensesByYear[1]).toBe(60_000)
  })

  it('counts any rule on the fee account as fees — a prepaid fee expensed monthly', () => {
    const c = planCostsByYear({ rules: [{ accountId: 'fee', method: 'fixed', params: { amount: 2_100 } }], accounts, history: new Map(), closedFrom: null, closedThrough: null, horizonYears: 2, fee: december })!
    expect(c.feesByYear[1]).toBe(25_200)
    expect(c.expensesByYear[1]).toBe(0)
  })

  it('counts cash, not expense: a prepaid fee needs no cash, a cost paid later lands later', () => {
    const prepaid = planCostsByYear({ rules: [{ accountId: 'fee', method: 'fixed', params: { amount: 2_100 }, cashTiming: { mode: 'prepaid' } as any }], accounts, history: new Map(), closedFrom: null, closedThrough: null, horizonYears: 2, fee: december })!
    expect(prepaid.feesByYear[1]).toBe(0)
    // Paid 12 months after it is incurred: year 1's expense is year 2's cash.
    const lagged = planCostsByYear({ rules: [{ accountId: 'exp', method: 'fixed', params: { amount: 5_000 }, cashTiming: { mode: 'offset', months: 12 } }], accounts, history: new Map(), closedFrom: null, closedThrough: null, horizonYears: 3, fee: december })!
    expect(lagged.expensesByYear[1]).toBe(0)
    expect(lagged.expensesByYear[2]).toBe(60_000)
  })

  it('is nothing when the plan has no expense rules — construction keeps its own inputs', () => {
    expect(planCostsByYear({ rules: [], accounts, history: new Map(), closedFrom: null, closedThrough: null, horizonYears: 2, fee: december })).toBeNull()
  })

  it('from mid-year, row 1 is the rest of this year and each later row a calendar year', () => {
    const c = planCostsByYear({ rules: [{ accountId: 'exp', method: 'fixed', params: { amount: 5_000 } }], accounts, history: new Map(), closedFrom: null, closedThrough: null, horizonYears: 2, fee: inputs })!
    // As of October: November and December 2026, then 2027, then January to October 2028.
    expect(c.expensesByYear).toEqual([0, 10_000, 60_000, 50_000])
  })
})
