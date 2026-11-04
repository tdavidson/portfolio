// Monte Carlo over the construction plan: the same deals, the same pacing, thousands of outcomes.
//
// The deterministic forecast says what the fund returns IF every deal does what its forecast says.
// Venture portfolios do not work like that: most deals return little, a few return the fund, and
// which is which is unknowable today. This samples that. Each deal's forecast proceeds become the
// EXPECTED value of a skewed distribution — a probability of a write-off, and a log-normal spread
// around the survivors sized so the mean still equals the forecast — and each exit slides within a
// stated window. Every run then goes through the SAME schedule as the deterministic forecast
// (forecastSchedule, with the sampled proceeds overriding the stated ones), so fees, pacing and
// capital calls can never disagree between the two views.
//
// PURE and SEEDED. The generator is a small deterministic PRNG, so the same assumptions give the
// same bands on every load and on the server and in the browser alike; changing the seed is a
// deliberate act. Industry-informed engine defaults keep those implementation details out of the
// form, while fund and per-deal assumptions still determine the forecast.

import { rowCalendarYear, scheduleGrid } from './construction-calendar'
import type { ConstructionAssumptions, ConstructionResult, ConstructionWaterfallProjection, PacingAssumptions, SimulationAssumptions } from './construction'
import { DEFAULT_SIMULATION } from './construction'
import { applyLpWaterfall, forecastSchedule, dealTimelines, type ForecastBaseline } from './construction-forecast'

export { DEFAULT_SIMULATION }
export type { SimulationAssumptions }

export interface Percentiles { p10: number; p25: number; p50: number; p75: number; p90: number; mean: number }

export interface SimulationYear {
  year: number
  calendarYear: number
  tvpi: Percentiles
  dpi: Percentiles
  /** Gross proceeds distributed by the portfolio in this year. */
  distributed: Percentiles
  /** GP carried interest allocated by the waterfall in this year. */
  carriedInterest: Percentiles
}

export interface SimulationResult {
  runs: number
  horizonYears: number
  years: SimulationYear[]
  final: { tvpi: Percentiles; dpi: Percentiles; netIrr: Percentiles | null }
  /**
   * The range on totals — how much and when, together — for the forecast years. A single exit's
   * per-year range is mostly "did it land this year", which says little about either.
   *   distributed   what the forecast years return in all (net of carry when a waterfall applies)
   *   carry         the carry they pay
   *   halfBackYear  the calendar year the run has returned half its total — when the money comes
   */
  totals: { distributed: Percentiles; carry: Percentiles; halfBackYear: Percentiles | null; nothingBack: number }
  /** Final TVPI, binned. */
  histogram: { from: number; to: number; count: number }[]
  probabilities: {
    /** P(final TVPI ≥ targetMultiple). Null without a target. */
    atOrAboveTarget: number | null
    /** P(final TVPI < 1). */
    belowCost: number
    /** P(at least one deal alone returns the committed capital). */
    fundReturner: number
  }
  /** True when the assumptions say something beyond the deterministic forecast. */
  stated: boolean
}

/** mulberry32 — small, fast, good enough for sampling bands, and identical everywhere. */
export function makeRng(seed: number): () => number {
  let a = (seed >>> 0) || 1
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/** A standard normal from two uniforms (Box–Muller). */
function normal(rng: () => number): number {
  let u = 0
  while (u === 0) u = rng()
  const v = rng()
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v)
}

export function percentiles(values: number[]): Percentiles {
  const sorted = [...values].sort((x, y) => x - y)
  const at = (p: number) => {
    if (sorted.length === 0) return 0
    const idx = (sorted.length - 1) * p
    const lo = Math.floor(idx)
    const hi = Math.ceil(idx)
    return sorted[lo] + (sorted[hi] - sorted[lo]) * (idx - lo)
  }
  const mean = sorted.length ? sorted.reduce((s, v) => s + v, 0) / sorted.length : 0
  return { p10: at(0.1), p25: at(0.25), p50: at(0.5), p75: at(0.75), p90: at(0.9), mean }
}

/**
 * Sample one deal's outcome.
 *
 * With probability `lossRate` the deal returns nothing. Otherwise its proceeds are log-normal with
 * mean `expected / (1 − lossRate)`, so the EXPECTATION across both branches equals the forecast:
 * the simulation spreads the forecast, it does not quietly haircut or inflate it. The cap, when
 * set, truncates the tail — and therefore lowers the mean a little; that is the trade the cap makes.
 */
export function sampleOutcome(
  rng: () => number,
  expected: number,
  cost: number,
  sim: SimulationAssumptions,
): number {
  if (expected <= 0) return 0
  const p = Math.min(0.999, Math.max(0, sim.lossRate))
  if (p > 0 && rng() < p) return 0
  const mean = expected / (1 - p)
  const sigma = Math.max(0, sim.dispersion)
  let value = mean
  if (sigma > 0) {
    const mu = Math.log(mean) - (sigma * sigma) / 2
    value = Math.exp(mu + sigma * normal(rng))
  }
  if (sim.maxMoic > 0 && cost > 0) value = Math.min(value, sim.maxMoic * cost)
  return value
}

/** Run the simulation. */
export function simulateFund(
  model: ConstructionResult,
  a: ConstructionAssumptions,
  pacing: PacingAssumptions,
  sim: SimulationAssumptions,
  baseline: ForecastBaseline,
  waterfall?: ConstructionWaterfallProjection,
): SimulationResult {
  const runs = Math.max(1, Math.min(20_000, Math.floor(sim.runs) || 1))
  const rng = makeRng(sim.seed)
  const deals = dealTimelines(model, pacing, baseline.asOf)
  // Each deal varies by its own settings where stated, the fund-wide ones otherwise.
  // The write-off rate is a base rate for deals not yet made. A company already held has its own
  // mark and exit forecast: it varies in multiple and timing, and is written off only on its own
  // stated rate — otherwise a one-company SPV loses everything in half the runs.
  const settingsFor = (d: { kind: string; lossRate?: number; dispersion?: number; exitSpreadYears?: number }): SimulationAssumptions => ({
    ...sim,
    lossRate: d.lossRate ?? (d.kind === 'planned' ? sim.lossRate : 0),
    dispersion: d.dispersion ?? sim.dispersion,
    holdSpreadYears: d.exitSpreadYears ?? sim.holdSpreadYears,
  })
  const stated = sim.lossRate > 0 || sim.dispersion > 0 || sim.holdSpreadYears > 0
    || deals.some(d => { const s = settingsFor(d); return s.lossRate > 0 || s.dispersion > 0 || s.holdSpreadYears > 0 })
  const committed = model.capital.committedCapital

  // The horizon comes from the deterministic schedule so every run is measured on the same grid
  // even when a sampled exit slides past the last scheduled one.
  const base = applyLpWaterfall(forecastSchedule(model, a, pacing, baseline, undefined, 'none'), waterfall)
  const horizonYears = Math.max(base.horizonYears, Math.ceil(deals.reduce((m, d) => Math.max(m, d.exitAt + Math.max(0, settingsFor(d).holdSpreadYears)), 0)))
  const wide = { ...pacing, horizonYears }

  const tvpiByYear: number[][] = []
  const dpiByYear: number[][] = []
  const distributedByYear: number[][] = []
  const carriedInterestByYear: number[][] = []
  const finalTvpi: number[] = []
  const finalDpi: number[] = []
  const finalIrr: number[] = []
  const totalDistributed: number[] = []
  const totalCarry: number[] = []
  const halfBackYears: number[] = []
  let fundReturners = 0

  for (let run = 0; run < runs; run++) {
    const override = new Map<string, { proceeds: number; exitAt: number }>()
    let returner = false
    for (const d of deals) {
      if (d.proceeds == null) continue
      const cost = d.currentValue + d.initialCheck + d.followOn
      const own = settingsFor(d)
      const proceeds = sampleOutcome(rng, d.proceeds, cost, own)
      const spread = Math.max(0, own.holdSpreadYears)
      const earliest = d.kind === 'planned' ? d.initialAt + 0.25 : 0.25
      const exitAt = spread > 0 ? Math.max(earliest, d.exitAt + (rng() * 2 - 1) * spread) : d.exitAt
      override.set(d.key, { proceeds, exitAt })
      if (committed > 0 && proceeds >= committed) returner = true
    }
    if (returner) fundReturners++
    const s = applyLpWaterfall(forecastSchedule(model, a, wide, baseline, override, 'final'), waterfall)
    for (const y of s.years) {
      ;(tvpiByYear[y.year] ??= []).push(y.tvpi ?? 0)
      ;(dpiByYear[y.year] ??= []).push(y.dpi ?? 0)
      ;(distributedByYear[y.year] ??= []).push(y.distributed)
      ;(carriedInterestByYear[y.year] ??= []).push(y.carriedInterest ?? 0)
    }
    // Totals over the forecast years (year 0 is today's baseline).
    const forward = s.years.filter(y => y.year >= 1)
    const total = forward.reduce((t, y) => t + y.distributed, 0)
    totalDistributed.push(total)
    totalCarry.push(forward.reduce((t, y) => t + (y.carriedInterest ?? 0), 0))
    if (total > 0) {
      let running = 0
      const half = forward.find(y => (running += y.distributed) >= total / 2)
      if (half) halfBackYears.push(half.calendarYear)
    }
    const last = s.years[s.years.length - 1]
    finalTvpi.push(last.tvpi ?? 0)
    finalDpi.push(last.dpi ?? 0)
    if (last.netIrr != null) finalIrr.push(last.netIrr)
  }

  const years: SimulationYear[] = base.years.map(y => ({
    year: y.year,
    calendarYear: y.calendarYear,
    tvpi: percentiles(tvpiByYear[y.year] ?? []),
    dpi: percentiles(dpiByYear[y.year] ?? []),
    distributed: percentiles(distributedByYear[y.year] ?? []),
    carriedInterest: percentiles(carriedInterestByYear[y.year] ?? []),
  }))
  // The wide grid may extend past the base schedule's years.
  const wideGrid = scheduleGrid(baseline.asOf || new Date().toISOString().slice(0, 10), horizonYears)
  for (let t = base.years.length; t <= wideGrid.rows; t++) {
    years.push({
      year: t,
      calendarYear: rowCalendarYear(wideGrid, t),
      tvpi: percentiles(tvpiByYear[t] ?? []),
      dpi: percentiles(dpiByYear[t] ?? []),
      distributed: percentiles(distributedByYear[t] ?? []),
      carriedInterest: percentiles(carriedInterestByYear[t] ?? []),
    })
  }

  // Histogram of final TVPI: bins of 0.5x up to the 99th percentile, one open bin above.
  const sortedFinal = [...finalTvpi].sort((x, y) => x - y)
  const top = sortedFinal.length ? sortedFinal[Math.floor((sortedFinal.length - 1) * 0.99)] : 0
  const step = 0.5
  const binCount = Math.max(1, Math.min(40, Math.ceil(top / step) + 1))
  const histogram = Array.from({ length: binCount }, (_, i) => ({ from: i * step, to: (i + 1) * step, count: 0 }))
  for (const v of finalTvpi) {
    const i = Math.min(binCount - 1, Math.max(0, Math.floor(v / step)))
    histogram[i].count++
  }

  const target = sim.targetMultiple > 0 ? sim.targetMultiple : 0
  return {
    runs,
    horizonYears,
    years,
    final: {
      tvpi: percentiles(finalTvpi),
      dpi: percentiles(finalDpi),
      netIrr: finalIrr.length > 0 ? percentiles(finalIrr) : null,
    },
    histogram,
    totals: {
      distributed: percentiles(totalDistributed),
      carry: percentiles(totalCarry),
      halfBackYear: halfBackYears.length > 0 ? percentiles(halfBackYears) : null,
      // Runs where every forecast exit failed — they have no "when", so they are counted here.
      nothingBack: totalDistributed.filter(v => v <= 0).length / runs,
    },
    probabilities: {
      atOrAboveTarget: target > 0 ? finalTvpi.filter(v => v >= target).length / runs : null,
      belowCost: finalTvpi.filter(v => v < 1).length / runs,
      fundReturner: fundReturners / runs,
    },
    stated,
  }
}

/**
 * Each run's sampled exits — value and timing per deal — and the horizon wide enough to hold them,
 * drawn exactly as simulateFund draws them (same seed, same order). The fund forecast reruns its
 * capital management and waterfall on each (lib/forecast/plan-returns.ts), so a simulated range and
 * the point forecast go through the same steps.
 */
export function sampleRuns(
  model: ConstructionResult,
  a: ConstructionAssumptions,
  pacing: PacingAssumptions,
  sim: SimulationAssumptions,
  baseline: ForecastBaseline,
  maxRuns = 500,
): { runs: Map<string, { proceeds: number; exitAt: number }>[]; pacing: PacingAssumptions } {
  const runs = Math.max(1, Math.min(maxRuns, Math.floor(sim.runs) || 1))
  const rng = makeRng(sim.seed)
  const deals = dealTimelines(model, pacing, baseline.asOf)
  const settingsFor = (d: { kind: string; lossRate?: number; dispersion?: number; exitSpreadYears?: number }): SimulationAssumptions => ({
    ...sim,
    lossRate: d.lossRate ?? (d.kind === 'planned' ? sim.lossRate : 0),
    dispersion: d.dispersion ?? sim.dispersion,
    holdSpreadYears: d.exitSpreadYears ?? sim.holdSpreadYears,
  })
  const base = forecastSchedule(model, a, pacing, baseline, undefined, 'none')
  const horizonYears = Math.max(base.horizonYears, Math.ceil(deals.reduce((m, d) => Math.max(m, d.exitAt + Math.max(0, settingsFor(d).holdSpreadYears)), 0)))
  const out: Map<string, { proceeds: number; exitAt: number }>[] = []
  for (let run = 0; run < runs; run++) {
    const override = new Map<string, { proceeds: number; exitAt: number }>()
    for (const d of deals) {
      if (d.proceeds == null) continue
      const cost = d.currentValue + d.initialCheck + d.followOn
      const own = settingsFor(d)
      const proceeds = sampleOutcome(rng, d.proceeds, cost, own)
      const spread = Math.max(0, own.holdSpreadYears)
      const earliest = d.kind === 'planned' ? d.initialAt + 0.25 : 0.25
      const exitAt = spread > 0 ? Math.max(earliest, d.exitAt + (rng() * 2 - 1) * spread) : d.exitAt
      override.set(d.key, { proceeds, exitAt })
    }
    out.push(override)
  }
  return { runs: out, pacing: { ...pacing, horizonYears } }
}
