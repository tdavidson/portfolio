import { describe, it, expect } from 'vitest'
import { checkDistribution, type DistributionCheckInput } from './distribution-check'

const base: DistributionCheckInput = {
  total: 100_000,
  date: '2026-06-30',
  method: 'waterfall',
  lines: [{ lpEntityId: 'lp-a', amount: 60_000 }, { lpEntityId: 'gp', amount: 20_000 }],
  carryLines: [{ lpEntityId: 'gp', amount: 20_000 }],
  lineBreakdown: [
    { lpEntityId: 'lp-a', returnOfCapital: 50_000, preferred: 4_000, profit: 6_000 },
    { lpEntityId: 'gp', returnOfCapital: 15_000, preferred: 0, profit: 5_000 },
  ],
  termsKind: 'european',
  carryRecipients: ['gp'],
  warnings: [],
  names: { 'lp-a': 'Acme LP', gp: 'Example GP' },
}
const facts = { cash: 500_000, unpaidEarlier: 0 }
const codes = (c: ReturnType<typeof checkDistribution>) => c.flags.map(f => `${f.severity}:${f.code}`)

describe('checkDistribution', () => {
  it('passes a split that ties, flagging only the GP receiving both its capital and carry', () => {
    const c = checkDistribution(base, facts)
    expect(c.missing).toEqual([])
    expect(codes(c)).toEqual(['warning:gp_capital_and_carry'])
    expect(c.flags[0].message).toContain('Example GP')
  })

  it('blocks lines that do not add to the total', () => {
    expect(codes(checkDistribution({ ...base, total: 100_001 }, facts))).toContain('blocker:lines_do_not_tie')
  })

  it('blocks a line whose return of capital, preferred and profit do not add to it', () => {
    const c = checkDistribution({ ...base, lineBreakdown: [{ lpEntityId: 'lp-a', returnOfCapital: 50_000, preferred: 4_000, profit: 5_000 }] }, facts)
    expect(codes(c)).toContain('blocker:breakdown_does_not_tie')
  })

  it('blocks amounts that are not cents and a zero total; requires a date', () => {
    expect(codes(checkDistribution({ ...base, total: 0 }, facts))).toContain('blocker:no_total')
    expect(codes(checkDistribution({ ...base, lines: [{ lpEntityId: 'lp-a', amount: 79_999.999 }, { lpEntityId: 'x', amount: 0.001 }] }, facts))).toContain('blocker:bad_amount')
    expect(checkDistribution({ ...base, date: '30/06/2026' }, facts).missing.map(m => m.field)).toEqual(['distribution_date'])
  })

  it('says when there are no terms, and when terms are overridden or typed by hand', () => {
    const none = checkDistribution({ ...base, termsKind: 'none', method: 'pro_rata', carryLines: [], lines: [{ lpEntityId: 'lp-a', amount: 100_000 }], lineBreakdown: [] }, facts)
    expect(none.missing.map(m => m.field)).toEqual(['carry_terms'])
    expect(codes(checkDistribution({ ...base, method: 'pro_rata' }, facts))).toContain('warning:pro_rata_override')
    expect(codes(checkDistribution({ ...base, method: 'manual' }, facts))).toContain('warning:manual_split')
    expect(checkDistribution({ ...base, carryRecipients: [] }, facts).missing.map(m => m.field)).toEqual(['carry_recipients'])
  })

  it('carries the waterfall warnings through', () => {
    expect(codes(checkDistribution({ ...base, warnings: ['Carry paid to date differs from the replay.'] }, facts))).toContain('warning:waterfall_warning')
  })

  it('warns when cash does not cover this distribution plus what earlier ones still owe', () => {
    expect(codes(checkDistribution(base, { cash: 90_000, unpaidEarlier: 0 }))).toContain('warning:cash_short')
    const c = checkDistribution(base, { cash: 105_000, unpaidEarlier: 10_000 })
    expect(codes(c)).toEqual(expect.arrayContaining(['warning:cash_short', 'warning:earlier_unpaid']))
    expect(codes(checkDistribution(base, { cash: null, unpaidEarlier: 0 }))).not.toContain('warning:cash_short')
  })
})
