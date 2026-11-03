// The waterfall spec (docs/spec/waterfall-terms.md) is published with machine-readable vectors
// (docs/spec/waterfall-vectors.json). This runs EVERY vector through the engine, so the published
// spec cannot drift from the code: change the engine and either the vectors still hold or this
// fails, and the spec and its vectors are updated in the same change.

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'fs'
import { runWaterfall, type WaterfallResult } from './waterfall'
import { carryTarget, preferredTarget } from './carry'
import { carryTargetByLp } from '@portfolio/fund-engine'
import { replayWaterfallState, splitDistribution } from './distribution-waterfall'
import { dealByDealCarry } from './american-carry'
import { roundCents } from './ledger'

const vectors = JSON.parse(readFileSync('docs/spec/waterfall-vectors.json', 'utf8'))
const spec = readFileSync('docs/spec/waterfall-terms.md', 'utf8')
const SECTIONS = ['runWaterfall', 'preferredTarget', 'carryTarget', 'splitDistribution', 'dealByDealCarry'] as const

describe('the published waterfall vectors', () => {
  it('has every section, unique ids, and every vector named in the spec', () => {
    const ids: string[] = []
    for (const s of SECTIONS) {
      expect(Array.isArray(vectors[s]), s).toBe(true)
      expect(vectors[s].length, s).toBeGreaterThan(0)
      for (const v of vectors[s]) {
        expect(typeof v.description, `${s}/${v.id}`).toBe('string')
        ids.push(`${s}/${v.id}`)
        // The spec's vector index lists each one, so a vector is never unexplained.
        expect(spec, `${s}/${v.id} is not listed in docs/spec/waterfall-terms.md`).toContain(`\`${v.id}\``)
      }
    }
    expect(new Set(ids).size).toBe(ids.length)
  })

  describe('runWaterfall', () => {
    for (const v of vectors.runWaterfall) {
      it(v.id, () => {
        const got = runWaterfall(v.input.distributable, v.input.terms, v.input.state)
        expect(got).toEqual(v.expected)
      })
    }

    it('every vector conserves the distribution: the tiers add up to what was distributed', () => {
      for (const v of vectors.runWaterfall) {
        const e: WaterfallResult = v.expected
        const distributed = roundCents(Math.max(0, roundCents(v.input.distributable)))
        expect(roundCents(e.toLP + e.toGP), v.id).toBe(distributed)
        expect(roundCents(e.toReturnOfCapital + e.toPreferred + e.toCatchUpLP + e.toCarryLP), v.id).toBe(e.toLP)
        expect(roundCents(e.toCatchUp + e.toCarryGP), v.id).toBe(e.toGP)
      }
    })
  })

  describe('preferredTarget', () => {
    for (const v of vectors.preferredTarget) {
      it(v.id, () => {
        expect(preferredTarget(v.input.contributions, v.input.asOf, v.input.rate, v.input.compounds, v.input.reductions)).toBe(v.expected)
      })
    }
  })

  describe('carryTarget (the close\'s accrual target)', () => {
    for (const v of vectors.carryTarget) {
      it(v.id, () => {
        const input = { lps: v.input.lps, contributions: v.input.contributions, asOf: v.input.asOf, distributions: v.input.distributions, lpContributions: v.input.lpContributions }
        // A waterfall per LP gives each LP's target as well as the total.
        if (typeof v.expected === 'object') {
          const got = carryTargetByLp(input, v.input.terms)!
          expect({ total: got.total, byLp: Object.fromEntries(got.byLp) }).toEqual(v.expected)
          expect(carryTarget(input, v.input.terms)).toBe(v.expected.total)
        } else {
          expect(carryTarget(input, v.input.terms)).toBe(v.expected)
        }
      })
    }
  })

  describe('splitDistribution (replay, then split)', () => {
    for (const v of vectors.splitDistribution) {
      it(v.id, () => {
        const got = splitDistribution(v.input)
        expect({
          method: got.method, tiers: got.tiers, stateBefore: got.stateBefore, stateAfter: got.stateAfter,
          lines: got.lines, carryLines: got.carryLines,
          // Per LP, each LP's share and the GP's take from it.
          ...(v.expected.groups ? { groups: got.groups!.map(g => ({ lpEntityIds: g.lpEntityIds, amount: g.amount, toGP: g.tiers.toGP })) } : {}),
        }).toEqual(v.expected)
      })
    }

    it('the replay is runWaterfall over each prior in date order, with the hurdle accrued to its date', () => {
      // Whole fund only: per LP replays each LP's own receipts (§4.4), which its own vectors cover.
      for (const v of vectors.splitDistribution.filter((x: any) => x.input.terms.kind !== 'none' && x.input.terms.waterfallScope !== 'per_lp')) {
        const { priors, contributions, terms, asOf, realizedCapital } = v.input
        const replayed = replayWaterfallState(priors, contributions, terms, asOf, { realizedCapital })
        expect(replayed, v.id).toEqual(v.expected.stateBefore)
        // And the split's tiers are exactly one more runWaterfall from that state.
        const step = runWaterfall(v.input.total, terms.kind === 'straight' ? { carryRate: terms.carryRate, catchUpRate: 1 } : { carryRate: terms.carryRate, catchUpRate: terms.catchupRate, catchUpSize: terms.catchupSize ?? 1 }, replayed)
        expect(step.state, v.id).toEqual(v.expected.stateAfter)
      }
    })
  })

  describe('dealByDealCarry (American entitlement)', () => {
    for (const v of vectors.dealByDealCarry) {
      it(v.id, () => {
        expect(dealByDealCarry(v.input.deals, { carryRate: v.input.carryRate, totalExpenses: v.input.totalExpenses })).toEqual(v.expected)
      })
    }
  })
})
