import { describe, expect, it } from 'vitest'
import { foots } from './foots'
import { ctx, pkg } from './fixtures'

describe('foots', () => {
  it("says it can't run when the package states no totals", () => {
    const r = foots({ pkg: pkg() }, ctx)
    expect(r.outcome.ran).toBe(false)
    expect(r.outcome.note).toMatch(/no totals/)
  })

  it('adds the partners up to the schedule total row', () => {
    const r = foots({ pkg: pkg({ fund: { partnerTotals: { ending: 885_000, beginning: 750_000 } } }) }, ctx)
    expect(r.outcome).toMatchObject({ ran: true, compared: 2 })
    expect(r.findings).toEqual([])
  })

  it('flags a total row that does not foot, as an error above materiality', () => {
    const r = foots({ pkg: pkg({ fund: { partnerTotals: { ending: 886_000 } } }) }, ctx)
    expect(r.findings).toHaveLength(1)
    expect(r.findings[0]).toMatchObject({ severity: 'error', stated: 886_000, expected: 885_000, difference: 1_000 })
    expect(r.findings[0].message).toMatch(/total ending capital is 886,000.00/)
  })

  it('treats a difference under materiality as information, and rounding as nothing', () => {
    expect(foots({ pkg: pkg({ fund: { partnerTotals: { ending: 885_050 } } }) }, ctx).findings[0].severity).toBe('info')
    expect(foots({ pkg: pkg({ fund: { partnerTotals: { ending: 885_000.01 } } }) }, ctx).findings).toEqual([])
  })

  it('checks a stated net allocation against its parts', () => {
    const p = pkg()
    p.partners![0].allocations = { ...p.partners![0].allocations, total: 45_000 }
    const r = foots({ pkg: p }, ctx)
    expect(r.findings[0]).toMatchObject({ subject: { label: 'Acme Partners LP' }, stated: 45_000, expected: 40_000 })
  })

  it('foots the balance sheet, the statement of operations and the schedule of investments', () => {
    const r = foots({
      pkg: pkg({
        fund: {
          balanceSheet: {
            assets: [{ label: 'Investments', amount: 800_000 }, { label: 'Cash', amount: 100_000 }],
            liabilities: [{ label: 'Accrued expenses', amount: 15_000 }],
            totalAssets: 900_000, totalLiabilities: 15_000, partnersCapital: 880_000, totalLiabilitiesAndCapital: 900_000,
          },
          operations: { lines: [{ label: 'Income', amount: 15_000 }, { label: 'Expenses', amount: -15_000 }], netIncome: 60_000 },
          soi: { cost: 600_000, fairValue: 800_000 },
        },
        holdings: [{ name: 'Acme Robotics', cost: 400_000, fairValue: 500_000 }, { name: 'Northwind Bio', cost: 200_000, fairValue: 300_000 }],
      }),
    }, ctx)
    const msgs = r.findings.map(f => f.message)
    expect(msgs.some(m => /assets less liabilities is 885,000.00/.test(m))).toBe(true)
    expect(msgs.some(m => /add up to 895,000.00/.test(m))).toBe(true)
    expect(msgs.some(m => /Net income is stated as 60,000.00/.test(m))).toBe(true)
    expect(r.findings).toHaveLength(3)
  })

  it('prints a negative difference in accounting parentheses', () => {
    const r = foots({ pkg: pkg({ fund: { partnerTotals: { ending: 884_000 } } }) }, ctx)
    expect(r.findings[0].message).toMatch(/\(1,000.00\) apart/)
  })
})
