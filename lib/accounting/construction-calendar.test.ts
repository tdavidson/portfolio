import { describe, expect, it } from 'vitest'
import { forwardYearsToRows, rowCalendarYear, rowEndMonth, rowOfTime, rowStartMonth, scheduleGrid } from './construction-calendar'

describe('scheduleGrid', () => {
  it('from November: December alone, then calendar years, the last one stopping at the horizon', () => {
    const g = scheduleGrid('2026-11-04', 3)
    expect(g.lead).toBe(1)
    expect(g.rows).toBe(4)
    expect([1, 2, 3, 4].map(k => rowCalendarYear(g, k))).toEqual([2026, 2027, 2028, 2029])
    expect([1, 2, 3, 4].map(k => [rowStartMonth(g, k), rowEndMonth(g, k)])).toEqual([[1, 1], [2, 13], [14, 25], [26, 36]])
  })

  it('from December: every row is a whole calendar year', () => {
    const g = scheduleGrid('2026-12-18', 2)
    expect(g.lead).toBe(0)
    expect(g.rows).toBe(2)
    expect([1, 2].map(k => rowCalendarYear(g, k))).toEqual([2027, 2028])
  })

  it('puts a time in the calendar year its month falls in', () => {
    const g = scheduleGrid('2026-11-04', 3)
    expect(rowOfTime(g, 0)).toBe(0)
    expect(rowOfTime(g, 1 / 12)).toBe(1) // December 2026
    expect(rowOfTime(g, 0.5)).toBe(2) // May 2027
    expect(rowOfTime(g, 10)).toBe(4) // past the horizon: the last row
  })

  it('spreads forward-year figures over their months into calendar rows', () => {
    const g = scheduleGrid('2026-11-04', 2)
    expect(forwardYearsToRows(g, [0, 120_000, 240_000])).toEqual([0, 10_000, 130_000, 220_000])
  })
})
