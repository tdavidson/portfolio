import { describe, expect, it } from 'vitest'
import {
  addMonths, aggregateBalance, aggregateFlow, lastDay, monthDiff, monthRange, periods, presetRange,
  type BalancePoint,
} from './months'

describe('month arithmetic', () => {
  it('adds across year boundaries in both directions', () => {
    expect(addMonths('2026-11', 3)).toBe('2027-02')
    expect(addMonths('2026-01', -1)).toBe('2025-12')
    expect(monthDiff('2025-12', '2027-01')).toBe(13)
  })

  it('knows month ends, including leap February', () => {
    expect(lastDay('2028-02')).toBe('2028-02-29')
    expect(lastDay('2026-02')).toBe('2026-02-28')
    expect(lastDay('2026-12')).toBe('2026-12-31')
  })

  it('ranges are inclusive and empty when reversed', () => {
    expect(monthRange('2026-11', '2027-01')).toEqual(['2026-11', '2026-12', '2027-01'])
    expect(monthRange('2026-02', '2026-01')).toEqual([])
  })
})

describe('periods', () => {
  it('marks partial quarters by the months they hold', () => {
    const ps = periods('2026-02', '2026-07', 'quarter')
    expect(ps.map(p => p.key)).toEqual(['2026-Q1', '2026-Q2', '2026-Q3'])
    expect(ps[0].months).toEqual(['2026-02', '2026-03'])
    expect(ps[2].months).toEqual(['2026-07'])
  })

  it('spans multiple years annually', () => {
    expect(periods('2025-06', '2027-03', 'year').map(p => p.months.length)).toEqual([7, 12, 3])
  })
})

describe('aggregation', () => {
  it('sums flows; quarterly and annual reconcile to the monthly total', () => {
    const byMonth = new Map(monthRange('2026-01', '2026-12').map((m, i) => [m, (i + 1) * 100.1]))
    const monthly = aggregateFlow(byMonth, periods('2026-01', '2026-12', 'month'))
    const quarterly = aggregateFlow(byMonth, periods('2026-01', '2026-12', 'quarter'))
    const annual = aggregateFlow(byMonth, periods('2026-01', '2026-12', 'year'))
    const sum = (xs: number[]) => Math.round(xs.reduce((a, b) => a + b, 0) * 100) / 100
    expect(sum(quarterly)).toBe(sum(monthly))
    expect(annual[0]).toBe(sum(monthly))
  })

  it('takes balances from the edges, never summing them', () => {
    const byMonth = new Map<string, BalancePoint>([
      ['2026-01', { opening: 100, ending: 90 }],
      ['2026-02', { opening: 90, ending: 70 }],
      ['2026-03', { opening: 70, ending: 75 }],
    ])
    expect(aggregateBalance(byMonth, periods('2026-01', '2026-03', 'quarter'))).toEqual([{ opening: 100, ending: 75 }])
  })

  it('returns null for a balance period with a missing edge month', () => {
    const byMonth = new Map<string, BalancePoint>([['2026-01', { opening: 1, ending: 2 }]])
    expect(aggregateBalance(byMonth, periods('2026-01', '2026-03', 'quarter'))).toEqual([null])
  })
})

describe('presets', () => {
  it('next_12 starts the month after today', () => {
    expect(presetRange('next_12', '2026-10')).toEqual({ start: '2026-11', end: '2027-10' })
    expect(presetRange('ytd', '2026-10')).toEqual({ start: '2026-01', end: '2026-10' })
  })
})
