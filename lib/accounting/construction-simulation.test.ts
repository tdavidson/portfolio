import { describe, it, expect } from 'vitest'
import { scheduleGrid } from './construction-calendar'
import { constructionModel, DEFAULT_ASSUMPTIONS, type ConstructionActuals, type ConstructionAssumptions } from './construction'
import { DEFAULT_PACING, forecastSchedule, type PacingAssumptions, type ForecastBaseline } from './construction-forecast'
import { simulateFund, sampleOutcome, makeRng, percentiles, DEFAULT_SIMULATION, type SimulationAssumptions } from './construction-simulation'

const actuals: ConstructionActuals = {
  committedCapital: 10_000_000, calledCapital: 2_000_000, uncalledCapital: 8_000_000,
  managementFeesIncurred: 0, orgCostsIncurred: 0, partnershipExpensesIncurred: 0, ledgerAvailable: true,
  deployedInitial: 2_000_000, deployedFollowOn: 0, companyCount: 2, currentValue: 2_000_000, nav: 2_000_000,
  positions: [
    { companyId: 'c1', name: 'Alpha', stage: null, status: 'active', investedInitial: 1_000_000, investedFollowOn: 0, investedTotal: 1_000_000, currentValue: 1_000_000, currentMoic: 1, currentOwnership: 0.1, currentPostMoney: 10_000_000, distributions: 0 },
    { companyId: 'c2', name: 'Beta', stage: null, status: 'active', investedInitial: 1_000_000, investedFollowOn: 0, investedTotal: 1_000_000, currentValue: 1_000_000, currentMoic: 1, currentOwnership: 0.1, currentPostMoney: 10_000_000, distributions: 0 },
  ],
}
const a: ConstructionAssumptions = {
  ...DEFAULT_ASSUMPTIONS,
  positionForecasts: [
    { companyId: 'c1', plannedFollowOn: 0, ownershipAtExit: 0, forecastMoic: 3, expectedExitValue: 0, returnMethod: 'moic' },
    { companyId: 'c2', plannedFollowOn: 0, ownershipAtExit: 0, forecastMoic: 3, expectedExitValue: 0, returnMethod: 'moic' },
  ],
  stages: Array.from({ length: 6 }, (_, i) => ({
    key: `s${i}`, label: `Deal ${i}`, initialCheck: 1_000_000, initialPostMoney: 10_000_000, followOnMultiple: 0, followOnCheck: 0, dilutionFactor: 1, forecastMoic: 3, returnMethod: 'moic' as const,
    investInYears: 0.25 + (i / 6) * 2,
  })),
}
const pacing: PacingAssumptions = { ...DEFAULT_PACING, deploymentYears: 2, holdYears: 5, existingHoldYears: 4, accretion: 'none' }
const baseline: ForecastBaseline = { asOf: '2026-09-18', calledCapital: 2_000_000, distributed: 0, nav: 2_000_000 }
const sim = (over: Partial<SimulationAssumptions> = {}): SimulationAssumptions => ({
  ...DEFAULT_SIMULATION,
  runs: 400,
  lossRate: 0,
  dispersion: 0,
  holdSpreadYears: 0,
  ...over,
})

describe('makeRng', () => {
  it('is deterministic for a seed and uniform on [0, 1)', () => {
    const x = makeRng(7), y = makeRng(7)
    const xs = Array.from({ length: 5 }, () => x())
    expect(Array.from({ length: 5 }, () => y())).toEqual(xs)
    expect(xs.every(v => v >= 0 && v < 1)).toBe(true)
    expect(makeRng(8)()).not.toBe(xs[0])
  })
})

describe('sampleOutcome', () => {
  it('returns the forecast exactly with no loss rate and no dispersion', () => {
    expect(sampleOutcome(makeRng(1), 3_000_000, 1_000_000, sim())).toBe(3_000_000)
  })

  it('keeps the expectation at the forecast across loss and dispersion', () => {
    const rng = makeRng(42)
    const n = 20_000
    let sum = 0
    for (let i = 0; i < n; i++) sum += sampleOutcome(rng, 3_000_000, 1_000_000, sim({ lossRate: 0.4, dispersion: 0.8 }))
    expect(sum / n).toBeGreaterThan(2_800_000)
    expect(sum / n).toBeLessThan(3_200_000)
  })

  it('writes off at the loss rate', () => {
    const rng = makeRng(3)
    let zeros = 0
    for (let i = 0; i < 5000; i++) if (sampleOutcome(rng, 100, 100, sim({ lossRate: 0.3 })) === 0) zeros++
    expect(zeros / 5000).toBeGreaterThan(0.26)
    expect(zeros / 5000).toBeLessThan(0.34)
  })

  it('caps a single outcome at the stated multiple of cost', () => {
    const rng = makeRng(5)
    for (let i = 0; i < 2000; i++) expect(sampleOutcome(rng, 300, 100, sim({ dispersion: 2, maxMoic: 10 }))).toBeLessThanOrEqual(1000)
  })
})

describe('percentiles', () => {
  it('interpolates', () => {
    expect(percentiles([1, 2, 3, 4, 5])).toEqual({ p10: 1.4, p25: 2, p50: 3, p75: 4, p90: 4.6, mean: 3 })
  })
})

describe('simulateFund', () => {
  it('collapses onto the deterministic forecast with no loss and no dispersion', () => {
    const model = constructionModel(actuals, a)
    const det = forecastSchedule(model, a, pacing, baseline)
    const s = simulateFund(model, a, pacing, sim(), baseline)
    expect(s.stated).toBe(false)
    const last = s.years[s.years.length - 1]
    expect(last.tvpi.p10).toBeCloseTo(det.years[det.years.length - 1].tvpi!, 6)
    expect(last.tvpi.p90).toBeCloseTo(det.years[det.years.length - 1].tvpi!, 6)
    expect(s.final.netIrr?.p50).toBeCloseTo(det.years[det.years.length - 1].netIrr!, 4)
  })

  it('spreads outcomes around the forecast and reports probabilities', () => {
    const model = constructionModel(actuals, a)
    const det = forecastSchedule(model, a, pacing, baseline)
    const detFinal = det.years[det.years.length - 1].tvpi!
    const s = simulateFund(model, a, pacing, sim({ lossRate: 0.4, dispersion: 1, targetMultiple: 2 }), baseline)
    expect(s.stated).toBe(true)
    expect(s.final.tvpi.p10).toBeLessThan(detFinal)
    expect(s.final.tvpi.p90).toBeGreaterThan(detFinal)
    expect(s.final.tvpi.mean).toBeGreaterThan(detFinal * 0.8)
    expect(s.final.tvpi.mean).toBeLessThan(detFinal * 1.2)
    expect(s.years.some(year => year.distributed.p90 > year.distributed.p10)).toBe(true)
    expect(s.probabilities.atOrAboveTarget).toBeGreaterThan(0)
    expect(s.probabilities.atOrAboveTarget).toBeLessThan(1)
    expect(s.probabilities.belowCost).toBeGreaterThanOrEqual(0)
    expect(s.histogram.reduce((n, b) => n + b.count, 0)).toBe(400)
  })

  it('is reproducible for a seed and differs for another', () => {
    const model = constructionModel(actuals, a)
    const one = simulateFund(model, a, pacing, sim({ lossRate: 0.3, dispersion: 0.7, seed: 9 }), baseline)
    const two = simulateFund(model, a, pacing, sim({ lossRate: 0.3, dispersion: 0.7, seed: 9 }), baseline)
    const three = simulateFund(model, a, pacing, sim({ lossRate: 0.3, dispersion: 0.7, seed: 10 }), baseline)
    expect(one.final.tvpi).toEqual(two.final.tvpi)
    expect(one.final.tvpi.p50).not.toBe(three.final.tvpi.p50)
  })

  it('widens the grid when exits can slide past the schedule', () => {
    const model = constructionModel(actuals, a)
    const s = simulateFund(model, a, pacing, sim({ holdSpreadYears: 2 }), baseline)
    const det = forecastSchedule(model, a, pacing, baseline)
    expect(s.horizonYears).toBeGreaterThan(det.horizonYears)
    // One row per calendar year to the horizon: from mid-September, the rest of this year first.
    expect(s.years).toHaveLength(scheduleGrid(baseline.asOf, s.horizonYears).rows + 1)
    expect(s.years).toHaveLength(s.horizonYears + 2)
  })

  it('counts a fund returner when one deal alone returns committed capital', () => {
    const model = constructionModel(actuals, a)
    const s = simulateFund(model, a, pacing, sim({ dispersion: 2.5, runs: 300 }), baseline)
    expect(s.probabilities.fundReturner).toBeGreaterThan(0)
  })
})

describe('per-deal simulation overrides', () => {
  it('a deal with its own loss rate and dispersion varies while the rest hold the forecast', () => {
    const withOverride: ConstructionAssumptions = {
      ...a,
      positionForecasts: [
        { companyId: 'c1', plannedFollowOn: 0, ownershipAtExit: 0, forecastMoic: 3, expectedExitValue: 0, returnMethod: 'moic', simLossRate: 0.5, simDispersion: 1 },
        { companyId: 'c2', plannedFollowOn: 0, ownershipAtExit: 0, forecastMoic: 3, expectedExitValue: 0, returnMethod: 'moic' },
      ],
    }
    const model = constructionModel(actuals, withOverride)
    const s = simulateFund(model, withOverride, pacing, sim(), baseline)
    // Fund-wide settings say nothing, yet the simulation is stated and Alpha's spread shows.
    expect(s.stated).toBe(true)
    expect(s.final.tvpi.p10).toBeLessThan(s.final.tvpi.p90)
    // Only Alpha (3m expected) varies: the spread is bounded by its share of the fund.
    const det = forecastSchedule(model, withOverride, pacing, baseline)
    const detFinal = det.years[det.years.length - 1].tvpi!
    expect(s.final.tvpi.p90 - s.final.tvpi.p10).toBeLessThan(detFinal)
  })

  it('a per-deal exit spread widens the grid for that deal alone', () => {
    const withSpread: ConstructionAssumptions = {
      ...a,
      positionForecasts: [
        { companyId: 'c1', plannedFollowOn: 0, ownershipAtExit: 0, forecastMoic: 3, expectedExitValue: 0, returnMethod: 'moic', simExitSpreadYears: 3 },
        { companyId: 'c2', plannedFollowOn: 0, ownershipAtExit: 0, forecastMoic: 3, expectedExitValue: 0, returnMethod: 'moic' },
      ],
    }
    const model = constructionModel(actuals, withSpread)
    const s = simulateFund(model, withSpread, pacing, sim(), baseline)
    expect(s.horizonYears).toBeGreaterThanOrEqual(7) // Alpha may exit as late as year 4 + 3
  })
})
