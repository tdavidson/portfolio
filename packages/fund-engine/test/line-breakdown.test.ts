import { describe, it, expect } from 'vitest'
import { NO_CARRY, type VehicleCarryTerms } from '../src/carry.ts'
import { lineBreakdown, splitDistribution } from '../src/distribution-waterfall.ts'

const GP = 'gp'
const european: VehicleCarryTerms = {
  ...NO_CARRY, kind: 'european', carryRate: 0.2, prefRate: 0.08, catchupRate: 1, prefCompounds: false,
  gpEntityId: GP, recipients: [{ lpEntityId: GP, pct: 100 }],
}
const partner = (lpEntityId: string, contributed: number, ending: number, distributed = 0) =>
  ({ lpEntityId, contributed, ending, distributed })
const cents = (v: number) => Math.round(v * 100) / 100

describe('lineBreakdown', () => {
  // The GP holds 10% of the capital and is also the carry recipient: the case a GP notice has to show.
  const split = splitDistribution({
    total: 2000,
    terms: european,
    partners: [partner('a', 600, 600), partner('b', 300, 300), partner(GP, 100, 100)],
    contributions: [{ date: '2025-01-01', amount: 600 }, { date: '2025-01-01', amount: 300 }],
    priors: [],
    asOf: '2026-01-01',
  })
  const rows = lineBreakdown(split)
  const byId = new Map(rows.map(r => [r.lpEntityId, r]))

  it('gives the GP both an LP line for its own capital and a carry line', () => {
    expect(split.lines.some(l => l.lpEntityId === GP)).toBe(true)
    expect(split.carryLines.some(l => l.lpEntityId === GP)).toBe(true)
  })

  it('breaks the GP\'s own line into its capital back and its profit, as the split computed it', () => {
    // A tenth of 2000 is 200: its 100 of capital back, then 100 of profit, outside the tiers.
    expect(byId.get(GP)).toEqual({ lpEntityId: GP, returnOfCapital: 100, preferred: 0, profit: 100 })
  })

  it('makes every line\'s three parts add to the line', () => {
    for (const l of split.lines) {
      const b = byId.get(l.lpEntityId)!
      expect(cents(b.returnOfCapital + b.preferred + b.profit)).toBe(l.amount)
    }
    expect(rows).toHaveLength(split.lines.length)
  })

  it('divides the LP tiers among the LP lines to the cent', () => {
    const lps = rows.filter(r => r.lpEntityId !== GP)
    expect(cents(lps.reduce((s, r) => s + r.returnOfCapital, 0))).toBe(split.tiers.returnOfCapital)
    expect(cents(lps.reduce((s, r) => s + r.preferred, 0))).toBe(split.tiers.preferred)
    // Two to one by contribution, so the same split of every tier.
    expect(byId.get('a')!.returnOfCapital).toBe(600)
    expect(byId.get('b')!.returnOfCapital).toBe(300)
  })

  it('returns nothing for a split that is not a waterfall', () => {
    const proRata = splitDistribution({
      total: 1000, terms: NO_CARRY, partners: [partner('a', 500, 500), partner('b', 500, 500)],
      contributions: [], priors: [], asOf: '2026-01-01',
    })
    expect(lineBreakdown(proRata)).toEqual([])
  })

  it('never states more return of capital than a line holds', () => {
    const small = splitDistribution({
      total: 50,
      terms: european,
      partners: [partner('a', 600, 600), partner('b', 300, 300)],
      contributions: [{ date: '2025-01-01', amount: 600 }, { date: '2025-01-01', amount: 300 }],
      priors: [],
      asOf: '2026-01-01',
    })
    for (const r of lineBreakdown(small)) {
      const amount = small.lines.find(l => l.lpEntityId === r.lpEntityId)!.amount
      expect(r.returnOfCapital).toBe(amount)
      expect(r.preferred + r.profit).toBe(0)
    }
  })
})
