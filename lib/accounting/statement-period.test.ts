import { describe, it, expect } from 'vitest'
import { resolvePeriod, customPeriod, comparisonPeriods, periodTriggerLabel, monthlyPeriods } from './statement-period'

describe('periodTriggerLabel', () => {
  it('uses the preset label and ignores stale custom dates', () => {
    expect(periodTriggerLabel('itd', '2020-01-01', '2020-12-31')).toBe('Inception to date')
  })

  it('shows the window for custom', () => {
    expect(periodTriggerLabel('custom', '2020-09-28', '2023-01-28')).toBe('2020-09-28 → 2023-01-28')
  })

  it('falls back to a half-open custom window rather than showing nothing', () => {
    expect(periodTriggerLabel('custom', '', '2023-01-28')).toBe('Through 2023-01-28')
    expect(periodTriggerLabel('custom', '2020-09-28', '')).toBe('From 2020-09-28')
  })

  it('appends as-of, which narrows the valuation date without replacing the window', () => {
    expect(periodTriggerLabel('itd', '', '', '2026-06-30')).toBe('Inception to date · as of 2026-06-30')
    expect(periodTriggerLabel('itd', '', '', '')).toBe('Inception to date')
  })
})

describe('comparisonPeriods', () => {
  const q2 = resolvePeriod('this_quarter', new Date(Date.UTC(2026, 4, 15))) // May 2026 → Q2

  it('steps quarters back, most-recent-first, full prior quarters', () => {
    const prev = comparisonPeriods(q2, 2, '2020-01-01')
    expect(prev.map(p => [p.start, p.end])).toEqual([
      ['2026-01-01', '2026-03-31'], // Q1 2026
      ['2025-10-01', '2025-12-31'], // Q4 2025
    ])
    expect(prev[0].label).toBe('Q1 2026')
    expect(prev[1].label).toBe('Q4 2025')
  })

  it('stops once a window ends before earliest', () => {
    const prev = comparisonPeriods(q2, 10, '2025-11-01')
    // Q1 2026 (ends 2026-03-31) kept; Q4 2025 (ends 2025-12-31) kept; Q3 2025 ends 2025-09-30 < earliest → stop
    expect(prev.map(p => p.end)).toEqual(['2026-03-31', '2025-12-31'])
  })

  it('steps prior_year back by full calendar years', () => {
    const fy = resolvePeriod('prior_year', new Date(Date.UTC(2026, 6, 1))) // FY 2025
    const prev = comparisonPeriods(fy, 2, '2000-01-01')
    expect(prev.map(p => [p.start, p.end, p.label])).toEqual([
      ['2024-01-01', '2024-12-31', 'FY 2024'],
      ['2023-01-01', '2023-12-31', 'FY 2023'],
    ])
  })

  it('compares ytd against FULL prior calendar years, not the same as-of date', () => {
    // A YTD column reads against the audited full years before it — that's the statement
    // convention, and a Jul-20 cut of last year is a figure nobody has ever seen.
    const ytd = resolvePeriod('ytd', new Date(Date.UTC(2026, 6, 20))) // 2026-01-01..2026-07-20
    const prev = comparisonPeriods(ytd, 2, '2000-01-01')
    expect(prev.map(p => [p.start, p.end, p.label])).toEqual([
      ['2025-01-01', '2025-12-31', 'FY 2025'],
      ['2024-01-01', '2024-12-31', 'FY 2024'],
    ])
  })

  it('steps custom back by the window length — uniform and adjacent', () => {
    const c = customPeriod('2026-04-01', '2026-06-30') // 91 days inclusive
    const prev = comparisonPeriods(c, 2, '2000-01-01')
    // Prior window is the same 91-day length, ending the day before the base start.
    expect(prev[0].end).toBe('2026-03-31')   // base.start - 1
    expect(prev[0].start).toBe('2025-12-31')  // 91-day window back from there
    // k=2 is adjacent to k=1: its end is the day before prev[0].start.
    expect(prev[1].end).toBe('2025-12-30')
  })

  it('returns [] for itd and for count<=0 and for null earliest', () => {
    expect(comparisonPeriods(resolvePeriod('itd'), 3, '2000-01-01')).toEqual([])
    expect(comparisonPeriods(resolvePeriod('ytd'), 0, '2000-01-01')).toEqual([])
    expect(comparisonPeriods(resolvePeriod('ytd'), 3, null)).toEqual([])
  })

  it('a ytd cut on Feb 29 still compares against whole prior years', () => {
    const ytd = resolvePeriod('ytd', new Date(Date.UTC(2028, 1, 29))) // 2028-01-01..2028-02-29 (2028 is leap)
    const prev = comparisonPeriods(ytd, 2, '2000-01-01')
    expect(prev[0].end).toBe('2027-12-31')
    expect(prev[1].end).toBe('2026-12-31')
  })
})

describe('customPeriod labels', () => {
  it('names a calendar quarter or year, and leaves other windows as dates', () => {
    expect(customPeriod('2026-01-01', '2026-03-31').label).toBe('Q1 2026')
    expect(customPeriod('2025-10-01', '2025-12-31').label).toBe('Q4 2025')
    expect(customPeriod('2025-01-01', '2025-12-31').label).toBe('FY 2025')
    expect(customPeriod('2026-01-15', '2026-03-31').label).toBe('2026-01-15 → 2026-03-31')
  })
})


describe('monthlyPeriods', () => {
  it('splits a calendar year into twelve months, oldest first', () => {
    const months = monthlyPeriods(customPeriod('2026-01-01', '2026-12-31'))
    expect(months).toHaveLength(12)
    expect(months[0]).toMatchObject({ start: '2026-01-01', end: '2026-01-31', label: 'Jan 2026' })
    expect(months[1]).toMatchObject({ start: '2026-02-01', end: '2026-02-28', label: 'Feb 2026' })
    expect(months[11]).toMatchObject({ start: '2026-12-01', end: '2026-12-31', label: 'Dec 2026' })
  })

  it('clips the first and last month to the window', () => {
    const months = monthlyPeriods(customPeriod('2026-01-15', '2026-03-10'))
    expect(months.map(m => [m.start, m.end])).toEqual([
      ['2026-01-15', '2026-01-31'], ['2026-02-01', '2026-02-28'], ['2026-03-01', '2026-03-10'],
    ])
  })

  it('is empty for an open-ended window', () => {
    expect(monthlyPeriods(customPeriod(null, '2026-12-31'))).toEqual([])
    expect(monthlyPeriods(resolvePeriod('itd'))).toEqual([])
  })
})
