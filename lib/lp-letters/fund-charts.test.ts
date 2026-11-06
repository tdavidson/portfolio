import { describe, expect, it } from 'vitest'
import { buildFundChart, hslTripleToHex, seriesColor } from './fund-charts'

const inv = (id: string, name: string, cost: number, real: number, unreal: number, status = 'active') => ({
  investment: { companyId: id, companyName: name, status, stage: null, industry: null, overview: null, whyInvested: null, currentUpdate: null,
    totalInvested: cost, totalRealized: real, unrealizedValue: unreal, fmv: unreal, moic: (real + unreal) / cost },
  metrics: [], recentNotes: [], latestSummary: null, latestUpdate: null,
}) as any

const preview = (over: any = {}): any => ({
  asOf: '2026-09-30', fundName: 'Example Fund I', fundCurrency: 'USD', periodLabel: 'Q3 2026', portfolioGroup: 'Example Fund I',
  companies: [inv('a', 'Acme <Robotics>', 1_000_000, 0, 2_000_000), inv('b', 'Birch', 500_000, 0, 250_000), inv('c', 'Cedar', 400_000, 800_000, 0, 'exited')],
  fundMetrics: null,
  totals: { totalInvested: 1_900_000, totalFmv: 0, totalRealized: 800_000, portfolioMoic: null, activeCount: 2, exitedCount: 1, writtenOffCount: 0 },
  ...over,
})

describe('fund charts', () => {
  it('draws value against cost, largest first, escapes names, and marks a position below cost', () => {
    const c = buildFundChart('value_by_company', preview())
    expect(c.svg).toContain('Acme &lt;Robotics&gt;')
    expect(c.svg.indexOf('Acme')).toBeLessThan(c.svg.indexOf('Cedar'))
    expect(c.svg).toContain('$250K / $500K')
    expect(c.svg).toContain('#bf2e2e') // the loss colour, for Birch
    expect(c.caption).toBe('Value and cost by company, gross: realized proceeds plus fair value, against cost, Example Fund I, as of September 30, 2026.')
  })

  it('takes the options: top N, active only, A to Z', () => {
    const top = buildFundChart('multiple_by_company', preview(), { limit: 1 })
    expect(top.svg).toContain('2.00x')
    expect(top.svg).not.toContain('Birch')
    const active = buildFundChart('value_by_company', preview(), { activeOnly: true, sort: 'name' })
    expect(active.svg).not.toContain('Cedar')
    expect(active.svg.indexOf('Acme')).toBeLessThan(active.svg.indexOf('Birch'))
  })

  it('says why a chart cannot be drawn rather than drawing an empty one', () => {
    expect(buildFundChart('capital_net', preview()).empty).toMatch(/no paid-in capital/)
    expect(buildFundChart('value_by_company', preview({ companies: [] })).empty).toBeTruthy()
  })

  it('labels the net chart with the fund metrics', () => {
    const c = buildFundChart('capital_net', preview({ fundMetrics: { committedCapital: 0, paidInCapital: 4_000_000, distributions: 1_000_000, fmv: 3_000_000, dpi: 0.25, rvpi: 0.75, tvpi: 1, irr: null } }))
    expect(c.svg).toContain('TVPI 1.00x')
    expect(c.caption).toMatch(/, net,/)
  })

  it("uses the fund's accent only when it reads on white", () => {
    expect(hslTripleToHex('0 0% 0%')).toBe('#000000')
    expect(seriesColor('accent', '243 75% 59%')).toBe(hslTripleToHex('243 75% 59%'))
    expect(seriesColor('accent', '49 97% 60%')).toBe('#2a77d6') // a yellow accent falls back
    expect(seriesColor('ink', null)).toBe('#55544f')
  })
})
