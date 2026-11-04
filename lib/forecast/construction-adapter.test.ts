import { describe, expect, it } from 'vitest'
import type { ForecastSchedule, ForecastYear } from '@/lib/accounting/construction-forecast'
import { monthlyConstruction } from './construction-adapter'
import { scheduleGrid } from '@/lib/accounting/construction-calendar'

const year = (y: number, f: Partial<ForecastYear>): ForecastYear => ({
  year: y, calendarYear: 2026 + Math.max(0, y - 1), t: 0, invested: 0, fees: 0, expenses: 0, called: 0, distributed: 0,
  cumCalled: 0, cumInvested: 0, cumDistributed: 0, nav: 0, dpi: null, rvpi: null, tvpi: null, netIrr: null, ...f,
})

const deal = (o: Partial<ForecastSchedule['deals'][number]>) => ({
  key: o.name ?? 'd', name: 'd', kind: 'planned' as const, investedToDate: 0, currentValue: 0,
  initialCheck: 0, initialAt: 0, followOn: 0, followOnAt: 0, proceeds: null, exitAt: 0, timing: 'stated' as const, ...o,
})

// As of 2026-10-09, so the rows are calendar years: 1 = Nov–Dec 2026, 2 = 2027, 3 = 2028, 4 = Jan–Oct 2029.
// Acme: $1m check at t=0.4 (5 months → 2027-03), $3m exit at t=1.5 (18 → 2028-04), stated.
// Beta: existing, $2m cost, $5m exit at t=1.05 by fund-wide pacing (13 → 2027-11).
const SCHEDULE: ForecastSchedule = {
  horizonYears: 3,
  grid: scheduleGrid('2026-10-09', 3),
  stated: true,
  warnings: [],
  deals: [
    deal({ name: 'Acme', initialCheck: 1_000_000, initialAt: 0.4, proceeds: 3_000_000, exitAt: 1.5 }),
    deal({ name: 'Beta', kind: 'existing', investedToDate: 2_000_000, proceeds: 5_000_000, exitAt: 1.05, timing: 'pacing' }),
  ],
  years: [
    year(0, {}),
    year(1, { fees: 40_000, expenses: 10_000, called: 50_000 }),
    year(2, { invested: 1_000_000, fees: 240_000, expenses: 60_000, called: 1_300_000, distributed: 5_000_000 }),
    year(3, { fees: 240_000, expenses: 60_000, distributed: 2_700_000 }),
    year(4, {}),
  ],
}

describe('monthlyConstruction (acceptance #10)', () => {
  const m = monthlyConstruction(SCHEDULE, '2026-10-09')

  it('places checks and exits in real months, not a twelfth of a year', () => {
    const at = (flow: string, deal: string) => m.events.find(e => e.flow === flow && e.deal === deal)
    expect(at('invested', 'Acme')).toMatchObject({ month: '2027-03', amount: 1_000_000, timing: 'stated' })
    expect(at('proceeds', 'Acme')).toMatchObject({ month: '2028-04', amount: 3_000_000, cost: 1_000_000, timing: 'stated' })
    expect(at('proceeds', 'Beta')).toMatchObject({ month: '2027-11', cost: 2_000_000, timing: 'inferred' })
    expect(m.warnings.some(w => w.includes('hold period'))).toBe(false)
  })

  it('re-adds every year to the annual construction figure', () => {
    for (const r of m.reconciliation) expect(r.monthly, `${r.flow} ${r.calendarYear}`).toBeCloseTo(r.annual, 2)
    expect(m.warnings.some(w => w.includes('does not re-add'))).toBe(false)
  })

  it('spreads annual-only flows evenly and says so', () => {
    const fees = m.events.filter(e => e.flow === 'fees')
    expect(fees).toHaveLength(26)
    expect(fees[0]).toMatchObject({ month: '2026-11', amount: 20_000, timing: 'inferred' })
    expect(fees.filter(f => f.month.startsWith('2027'))).toHaveLength(12)
  })

  it('puts the call where the money goes out and distributions where it comes in', () => {
    const calls = m.events.filter(e => e.flow === 'called')
    const march = calls.find(c => c.month === '2027-03')!.amount
    expect(march).toBeGreaterThan(1_000_000)
    expect(m.events.filter(e => e.flow === 'distributed').map(e => e.month)).toEqual(['2027-11', '2028-04'])
  })

  it('leaves out flows dated today or earlier, as construction does', () => {
    const past = monthlyConstruction({ ...SCHEDULE, deals: [deal({ name: 'Old', initialCheck: 5, initialAt: 0 })] }, '2026-10-09')
    expect(past.events.filter(e => e.flow === 'invested')).toEqual([])
    expect(past.warnings[0]).toMatch(/dated today or earlier/)
  })

  it("carries each exit's recycling onto its proceeds", () => {
    const r = monthlyConstruction({ ...SCHEDULE, deals: [deal({ name: 'Acme', proceeds: 3_000_000, exitAt: 1.5, recycled: 500_000, recycledDeemed: 200_000 })] }, '2026-10-09')
    expect(r.events.find(e => e.flow === 'proceeds')).toMatchObject({ month: '2028-04', recycled: 500_000, recycledDeemed: 200_000 })
    expect(m.events.find(e => e.flow === 'proceeds')?.recycled).toBeUndefined()
  })

  it('keeps each calendar year to its own months', () => {
    const years = m.reconciliation.filter(r => r.flow === 'fees').map(r => [r.calendarYear, r.annual])
    expect(years).toEqual([[2026, 40_000], [2027, 240_000], [2028, 240_000], [2029, 0]])
  })
})
