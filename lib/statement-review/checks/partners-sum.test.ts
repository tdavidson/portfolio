import { describe, expect, it } from 'vitest'
import { partnersSum } from './partners-sum'
import { ctx, pkg } from './fixtures'

describe('partners sum to fund', () => {
  it("says it can't run without fund-level figures", () => {
    expect(partnersSum({ pkg: pkg() }, ctx).outcome).toMatchObject({ ran: false })
  })

  it("adds the partners to the fund's statement of changes", () => {
    const r = partnersSum({ pkg: pkg({ fund: { partnersCapital: { beginning: 750_000, contributions: 150_000, distributions: 75_000, ending: 885_000, allocations: { income: 15_000 } } } }) }, ctx)
    expect(r.outcome).toMatchObject({ ran: true, compared: 5 })
    expect(r.findings).toEqual([])
  })

  it('flags a fund figure the partners do not add up to', () => {
    const r = partnersSum({ pkg: pkg({ fund: { partnersCapital: { contributions: 160_000 } } }) }, ctx)
    expect(r.findings[0]).toMatchObject({ severity: 'error', stated: 160_000, expected: 150_000 })
  })

  it("compares the balance sheet's partners' capital with the partners' endings", () => {
    const r = partnersSum({ pkg: pkg({ fund: { balanceSheet: { partnersCapital: 880_000 } } }) }, ctx)
    expect(r.findings[0]).toMatchObject({ expected: 885_000, difference: -5_000 })
  })

  it('ties net income to what the partners are allocated', () => {
    expect(partnersSum({ pkg: pkg({ fund: { operations: { netIncome: 60_000 } } }) }, ctx).findings).toEqual([])
    expect(partnersSum({ pkg: pkg({ fund: { operations: { netIncome: 70_000 } } }) }, ctx).findings[0].expected).toBe(60_000)
  })
})
