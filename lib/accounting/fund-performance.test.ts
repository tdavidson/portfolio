import { describe, it, expect } from 'vitest'
import { buildFundPerformance, lastQuarterEnd, periodLabel } from './fund-performance'
import { datedCapitalFlows, rollUp, type FundMetrics } from './fund-economics'
import { emptyAccount } from './capital-account'

const lp = (p: Partial<FundMetrics>): FundMetrics => ({
  committed: 0, paidIn: 0, uncalled: 0, distributions: 0, nav: 0, totalValue: 0,
  dpi: null, rvpi: null, tvpi: null, irr: null, ...p,
})

describe('datedCapitalFlows', () => {
  const ids = new Set(['a', 'b'])
  it('turns credit-balance postings into contributions and distributions by date', () => {
    const flows = datedCapitalFlows([
      { lpEntityId: 'a', amount: -100, sourceType: 'contribution', entryDate: '2024-01-05' },
      { lpEntityId: 'b', amount: -50, sourceType: 'capital_call', entryDate: '2024-01-05' },
      { lpEntityId: 'a', amount: 30, sourceType: 'distribution', entryDate: '2024-06-30' },
      // Not cash: fees and income move the NAV, which is already the terminal value.
      { lpEntityId: 'a', amount: 5, sourceType: 'management_fee', entryDate: '2024-03-31' },
      // Not an LP-class partner.
      { lpEntityId: 'gp', amount: -10, sourceType: 'contribution', entryDate: '2024-01-05' },
    ], ids)
    expect(flows).toEqual([
      { date: '2024-01-05', contributions: 150, distributions: 0 },
      { date: '2024-06-30', contributions: 0, distributions: 30 },
    ])
  })

  it('drops a date whose call and refund cancel', () => {
    const flows = datedCapitalFlows([
      { lpEntityId: 'a', amount: -18_750, sourceType: 'contribution', entryDate: '2023-09-26' },
      { lpEntityId: 'a', amount: 18_750, sourceType: 'contribution', entryDate: '2023-09-26' },
    ], ids)
    expect(flows).toEqual([])
  })
})

describe('buildFundPerformance', () => {
  const flows = [
    { date: '2021-08-11', contributions: 1_000_000, distributions: 0 },
    { date: '2021-08-20', contributions: 500_000, distributions: 0 },
    { date: '2022-01-20', contributions: 1_500_000, distributions: 0 },
    { date: '2024-06-30', contributions: 0, distributions: 100_000 },
    { date: '2026-02-01', contributions: 10_000, distributions: 0 },
  ]
  const metrics = rollUp(
    [{ ...emptyAccount(), contributions: 3_000_000, distributions: -100_000, ending: 2_700_000 }],
    3_500_000,
    flows.filter(f => f.date <= '2025-12-31').map(f => ({ date: new Date(f.date), amount: f.distributions - f.contributions })),
    new Date('2025-12-31'),
  )

  it('lists the rows, totals them, and adds the NAV as the terminal value', () => {
    const r = buildFundPerformance({ vehicle: 'Fund I', asOf: '2025-12-31', grouping: 'date', lp: metrics, flows })
    expect(r.periodLabel).toBe('Q4 2025')
    expect(r.rows.map(x => x.date)).toEqual(['2021-08-11', '2021-08-20', '2022-01-20', '2024-06-30']) // after asOf dropped
    expect(r.totals).toEqual({ contributions: 3_000_000, distributions: 100_000, nav: 2_700_000, net: -200_000 })
    expect(r.notes).toEqual([])
  })

  it('keeps the ratios consistent with each other: TVPI is DPI + RVPI', () => {
    const r = buildFundPerformance({ vehicle: 'Fund I', asOf: '2025-12-31', grouping: 'date', lp: metrics, flows })
    const { tvpi, dpi, rvpi, totalValue, nav, distributions } = r.metrics
    expect(tvpi!).toBeCloseTo(dpi! + rvpi!, 10)
    expect(totalValue).toBe(nav! + distributions!)
    expect(r.metrics.irr).not.toBeNull()
  })

  it('groups by month or quarter without changing the totals', () => {
    const byMonth = buildFundPerformance({ vehicle: 'Fund I', asOf: '2025-12-31', grouping: 'month', lp: metrics, flows })
    expect(byMonth.rows.map(x => [x.label, x.contributions])).toEqual([['Aug 2021', 1_500_000], ['Jan 2022', 1_500_000], ['Jun 2024', 0]])
    expect(byMonth.rows[0].date).toBe('2021-08-20')
    const byQuarter = buildFundPerformance({ vehicle: 'Fund I', asOf: '2025-12-31', grouping: 'quarter', lp: metrics, flows })
    expect(byQuarter.rows.map(x => x.label)).toEqual(['Q3 2021', 'Q1 2022', 'Q2 2024'])
    expect(byQuarter.totals).toEqual(byMonth.totals)
    expect(byQuarter.metrics.irr).toBe(byMonth.metrics.irr) // grouping never feeds the IRR
  })

  it('says so when the rows cannot add up to the totals', () => {
    const r = buildFundPerformance({ vehicle: 'Fund I', asOf: '2025-12-31', grouping: 'date', lp: lp({ paidIn: 3_100_000, distributions: 100_000, nav: 1 }), flows })
    expect(r.notes[0]).toMatch(/do not add up/)
    expect(r.notes.some(n => /IRR is not shown/.test(n))).toBe(true)
  })
})

describe('period helpers', () => {
  it('labels quarter ends and nothing else', () => {
    expect(periodLabel('2025-12-31')).toBe('Q4 2025')
    expect(periodLabel('2025-06-30')).toBe('Q2 2025')
    expect(periodLabel('2025-06-29')).toBe('2025-06-29')
  })
  it('finds the last quarter end on or before a date', () => {
    expect(lastQuarterEnd('2026-10-12')).toBe('2026-09-30')
    expect(lastQuarterEnd('2026-09-30')).toBe('2026-09-30')
    expect(lastQuarterEnd('2026-02-01')).toBe('2025-12-31')
  })
})

describe('buildFundPerformanceHtml', () => {
  it('prints the rows, the NAV line and the LP-only summary', async () => {
    const { buildFundPerformanceHtml } = await import('./fund-performance-pdf')
    const r = buildFundPerformance({
      vehicle: 'Northwind Holdings Fund I', asOf: '2025-12-31', grouping: 'date',
      lp: lp({ committed: 100, paidIn: 90, distributions: 0, nav: 80, totalValue: 80, dpi: 0, rvpi: 80 / 90, tvpi: 80 / 90, irr: -0.0429 }),
      flows: [{ date: '2021-08-11', contributions: 90, distributions: 0 }],
    })
    const html = buildFundPerformanceHtml(r, { currency: 'USD', generatedAt: '2026-10-12T00:00:00Z' })
    expect(html).toContain('Northwind Holdings Fund I')
    expect(html).toContain('Through Q4 2025')
    expect(html).toContain('-4.29%')
    expect(html).toContain('0.89x')
    expect(html).toContain('($90)')
  })
})
