import { describe, expect, it } from 'vitest'
import { planReturns } from './plan-returns'
import { validateCapital } from './capital'

const m = (o: Record<string, number>) => new Map(Object.entries(o)) as any
const months = Array.from({ length: 24 }, (_, i) => `${2027 + Math.floor(i / 12)}-${String((i % 12) + 1).padStart(2, '0')}`) as any[]

const wf = {
  asOf: '2026-12-31', kind: 'european' as const, carryRate: 0.2, prefRate: 0, catchupRate: 1, prefCompounds: true,
  lpCommitmentShare: 0.99, lpCalledCapital: 0, lpDistributedCapital: 0, fundDistributedCapital: 0, lpNav: 0, contributions: [],
}

describe("a plan's returns — one calculation", () => {
  const r = planReturns({
    months, asOfMonth: '2026-12', openingCash: 0, uncalled: 2_000_000, settings: validateCapital({}),
    otherFlows: m({ '2027-01': -20_000 }), // a fee
    invested: m({ '2027-01': -1_000_000 }),
    proceeds: m({ '2028-06': 3_000_000 }),
    terminalNav: 0, waterfall: wf,
  })

  it('calls what the fee and the check need, and distributes the exit', () => {
    expect(r.totals.called).toBe(1_020_000)
    expect(r.totals.distributed).toBe(3_000_000)
    expect(r.years.map(y => [y.calendarYear, y.called, y.distributed])).toEqual([[2027, 1_020_000, 0], [2028, 0, 3_000_000]])
  })

  it("takes carry on the LPs' gain only, and gives the LPs their net", () => {
    // LPs: 99% of 1,020,000 in; 99% of 3,000,000 out = 2,970,000 → 1,009,800 back, 1,960,200 gain, 20% carry.
    expect(r.totals.carry).toBeCloseTo(392_040, 0)
    expect(r.lp.called).toBeCloseTo(1_009_800, 2)
    expect(r.lp.distributed).toBeCloseTo(2_970_000 - 392_040, 0)
    expect(r.lp.tvpi!).toBeCloseTo((2_970_000 - 392_040) / 1_009_800, 3)
    expect(r.lp.irr!).toBeGreaterThan(0.5)
    expect(r.halfBackYear).toBe(2028)
  })

  it('runs distributions paid to date month by month, for the timing as well as the amount', () => {
    expect(r.distributedToDate[months.indexOf('2028-05')]).toBe(0)
    expect(r.distributedToDate[months.indexOf('2028-06')]).toBe(3_000_000)
    expect(r.distributedToDate[months.length - 1]).toBe(3_000_000)
  })

  it('honours month edits and values what is left through the waterfall', () => {
    const edited = planReturns({
      months, asOfMonth: '2026-12', openingCash: 0, uncalled: 2_000_000,
      // June pays 1,000,000; every later month is held at nothing, so the rest stays in the fund.
      settings: validateCapital({ distributions: Object.fromEntries(months.filter(x => x >= '2028-06').map(x => [x, x === '2028-06' ? 1_000_000 : 0])) }),
      otherFlows: m({}), invested: m({ '2027-01': -1_000_000 }), proceeds: m({ '2028-06': 3_000_000 }),
      terminalNav: 0, waterfall: wf,
    })
    expect(edited.totals.distributed).toBe(1_000_000)
    // 2,000,000 stays in the bank: the LPs' 99% of it, through the waterfall, is their terminal value.
    expect(edited.lp.terminal).toBeGreaterThan(1_500_000)
    expect(edited.lp.terminal).toBeLessThan(1_980_000)
  })

  it('without carry terms gives the LPs their share of everything', () => {
    const r2 = planReturns({
      months, asOfMonth: '2026-12', openingCash: 0, uncalled: 2_000_000, settings: validateCapital({}),
      otherFlows: m({}), invested: m({ '2027-01': -1_000_000 }), proceeds: m({ '2028-06': 3_000_000 }),
      terminalNav: 500_000, waterfall: { ...wf, kind: 'none' as const, carryRate: 0 },
    })
    expect(r2.totals.carry).toBe(0)
    expect(r2.lp.distributed).toBe(2_970_000)
    expect(r2.lp.terminal).toBe(495_000)
  })
})

describe("a plan's recycling, by month", () => {
  it('reports the proceeds the plan recycles in the month they arrive', () => {
    const r = planReturns({
      months, asOfMonth: '2026-12', openingCash: 0, uncalled: 2_000_000, settings: validateCapital({}),
      otherFlows: m({}), invested: m({ '2027-01': -1_000_000 }), proceeds: m({ '2027-06': 400_000 }),
      recycled: m({ '2027-06': 100_000 }), terminalNav: 0,
    })
    expect(r.recycled).toEqual([{ month: '2027-06', amount: 100_000 }])
  })
})
