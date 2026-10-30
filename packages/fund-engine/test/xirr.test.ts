import { describe, it, expect } from 'vitest'
import { xirr, type CashFlow } from '../src/xirr.ts'

const d = (s: string) => new Date(s + 'T00:00:00')

describe('xirr', () => {
  it('returns null when all flows are on the same date (no time spread)', () => {
    // A single cutover position: contributed = NAV, no distributions, one date. IRR is undefined —
    // must NOT return the internal 0.1 first guess as a spurious ~10%.
    const flows: CashFlow[] = [
      { date: d('2026-03-31'), amount: -1_000_000 }, // called
      { date: d('2026-03-31'), amount: 1_000_000 },  // terminal NAV = called
    ]
    expect(xirr(flows)).toBeNull()
  })

  it('is ~0% when NAV equals cost across a real time spread', () => {
    const flows: CashFlow[] = [
      { date: d('2025-01-01'), amount: -1_000_000 },
      { date: d('2026-01-01'), amount: 1_000_000 }, // no gain over a year
    ]
    const r = xirr(flows)!
    expect(r).not.toBeNull()
    expect(Math.abs(r)).toBeLessThan(1e-4)
  })

  it('computes a positive IRR for a genuine gain', () => {
    const flows: CashFlow[] = [
      { date: d('2025-01-01'), amount: -1_000_000 },
      { date: d('2026-01-01'), amount: 1_100_000 }, // +10% over one year
    ]
    const r = xirr(flows)!
    expect(r).toBeCloseTo(0.1, 2)
  })

  it('returns null without both a positive and negative flow', () => {
    expect(xirr([{ date: d('2025-01-01'), amount: -100 }, { date: d('2026-01-01'), amount: -50 }])).toBeNull()
  })

  it('counts a 365-day year, as Excel does', () => {
    // Exactly 365 days and +10%: Excel's XIRR gives 10.0000%. A 365.25-day year read 10.0072%.
    const r = xirr([{ date: d('2025-01-01'), amount: -1_000_000 }, { date: d('2026-01-01'), amount: 1_100_000 }])!
    expect(r).toBeCloseTo(0.1, 8)
  })
})
