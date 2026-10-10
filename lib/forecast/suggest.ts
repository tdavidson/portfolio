// Rule suggestions from an account's history.
//
// Reads at least twelve CLOSED months — fewer cannot tell an annual bill from a one-off, which is
// the whole point — and up to 36 when the books have them, so a once-a-year charge is seen twice
// before it is called recurring. Deterministic: the same history always suggests the same rule, and
// every suggestion carries the evidence it rests on and a confidence. Nothing here writes; a person
// (or the Analyst, staged for approval) decides.
//
// The shapes it recognises, in the order it tries them:
//   periodic   spend only in months on a 3/6/12-month cycle      → recurring
//   seasonal   spend most months, but with a repeating shape      → seasonal (12-month profile)
//   trending   spend most months, rising or falling steadily      → growth
//   stepped    spend most months, recent level clearly different  → run rate, last 3 months
//   steady     spend most months at a stable level                → run rate, 12 months
//   irregular  scattered spend with no cycle                      → run rate, 12 months, low confidence

import { roundCents } from '@/lib/accounting/ledger'
import { addMonths, monthDiff, parseMonth, type MonthKey } from './months'
import type { RuleMethod } from './rules'

export const MIN_HISTORY_MONTHS = 12
export const MAX_HISTORY_MONTHS = 36

export type Confidence = 'high' | 'medium' | 'low'

export interface RuleSuggestion {
  method: RuleMethod
  params: Record<string, unknown>
  confidence: Confidence
  /** The pattern recognised, in words a reviewer can check against the ledger. */
  evidence: string
  warnings: string[]
}

export interface SuggestInput {
  /** Natural-side actuals by month (absent = no postings). */
  actuals: ReadonlyMap<MonthKey, number>
  closedFrom: MonthKey | null
  closedThrough: MonthKey | null
  /** How far back to read; clamped to 12–36. */
  lookbackMonths?: number
}

// Cents only where they matter: $0.49 of interest is not "1".
const fmt = (n: number) => n.toLocaleString('en-US', { maximumFractionDigits: Math.abs(n) < 100 ? 2 : 0 })
const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0)
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
const label = (m: MonthKey) => `${MONTHS[parseMonth(m).month - 1]} ${parseMonth(m).year}`

/** The closed months to read, most recent last. */
export function historyWindow(closedFrom: MonthKey | null, closedThrough: MonthKey | null, lookback = 24): MonthKey[] {
  if (!closedThrough) return []
  const n = Math.min(MAX_HISTORY_MONTHS, Math.max(MIN_HISTORY_MONTHS, lookback))
  let start = addMonths(closedThrough, -(n - 1))
  if (closedFrom && closedFrom > start) start = closedFrom
  const out: MonthKey[] = []
  for (let m = start; m <= closedThrough; m = addMonths(m, 1)) out.push(m)
  return out
}

export function suggestRule(input: SuggestInput): RuleSuggestion | null {
  const window = historyWindow(input.closedFrom, input.closedThrough, input.lookbackMonths ?? MAX_HISTORY_MONTHS)
  // A closed month with no postings is a real zero; the window is closed months only.
  const values = window.map(m => roundCents(input.actuals.get(m) ?? 0))
  const nonzero = window.filter((_, i) => values[i] !== 0)
  if (!nonzero.length) return null

  const next = addMonths(window[window.length - 1], 1)
  const short = window.length < MIN_HISTORY_MONTHS
  // Months before an account's first activity say nothing about its level: a fee that began in
  // March was not $0 in February, it did not exist yet. Level and density are read from the first
  // active month on; cycle detection still uses the whole window, where those months are evidence.
  const firstActive = window.findIndex((_, i) => values[i] !== 0)
  const live = values.slice(firstActive)
  const liveMonths = window.slice(firstActive)
  const shortWarning = short
    ? [`Only ${window.length} closed month${window.length === 1 ? '' : 's'} of history — annual and seasonal patterns need at least 12`]
    : []
  const density = nonzero.length / live.length

  // ---- one-off: once, in too little history to know whether it recurs --------------------------
  if (nonzero.length === 1 && short) {
    return {
      method: 'manual',
      params: { amounts: {} },
      confidence: 'low',
      evidence: `One-off: ${fmt(input.actuals.get(nonzero[0])!)} in ${label(nonzero[0])}, not repeated`,
      warnings: [...shortWarning, 'Not forecast to recur — add the months if it will'],
    }
  }

  // ---- periodic: spend only on a cycle ---------------------------------------------------------
  if (!short && density <= 0.5) {
    for (const every of [3, 6, 12]) {
      const anchor = nonzero[nonzero.length - 1]
      const onCycle = nonzero.every(m => monthDiff(m, anchor) % every === 0)
      if (!onCycle) continue
      // Expected occurrences in the window, from the first month the cycle could have hit.
      const slots = window.filter(m => monthDiff(m, anchor) % every === 0)
      const hits = nonzero.length
      if (hits < slots.length - 1) continue // too many misses to call it a cycle
      const amounts = nonzero.map(m => input.actuals.get(m)!)
      const latest = amounts[amounts.length - 1]
      // Annual bills move year to year (a renewal, an audit fee); any change of 0.5% or more is escalation.
      const stable = amounts.every(a => Math.abs(a - latest) <= 0.005 * Math.abs(latest))
      const escalation = hits >= 2 && every === 12 && !stable ? (latest / amounts[amounts.length - 2]) - 1 : undefined
      const cadence = every === 12 ? 'every year' : `every ${every} months`
      const confidence: Confidence = hits >= 2 && hits === slots.length ? (stable || escalation != null ? 'high' : 'medium') : 'low'
      const warnings = hits < 2 ? [`Seen once (${label(anchor)}); confirm it recurs`] : hits < slots.length ? ['Missed one expected occurrence'] : []
      return {
        method: 'recurring',
        params: {
          amount: roundCents(latest),
          everyMonths: every,
          anchor,
          ...(escalation != null && Math.abs(escalation) < 1 ? { annualEscalation: Math.round(escalation * 10000) / 10000 } : {}),
        },
        confidence,
        evidence: `${cadence[0].toUpperCase()}${cadence.slice(1)}: ${nonzero.map(m => `${fmt(input.actuals.get(m)!)} in ${label(m)}`).join(', ')}`,
        warnings,
      }
    }
  }

  const avg = mean(live)
  const recent = mean(live.slice(-3))

  if (density >= 0.75) {
    // ---- seasonal: a repeating shape a level cannot describe --------------------------------
    if (!short && firstActive === 0) {
      const last12 = values.slice(-12)
      const m12 = mean(last12)
      const spikes = last12.filter(v => Math.abs(v - m12) > 0.5 * Math.abs(m12))
      // A spike in the same calendar month a year earlier is what makes it seasonal, not noise.
      const repeats = window.length >= 24
        ? last12.every((v, i) => {
            const prior = values[values.length - 24 + i]
            return Math.abs(v - m12) <= 0.5 * Math.abs(m12) || Math.abs(prior - mean(values.slice(-24, -12))) > 0.5 * Math.abs(mean(values.slice(-24, -12)))
          })
        : false
      if (spikes.length >= 1 && spikes.length <= 4) {
        const profile: Record<string, number> = {}
        const months12 = window.slice(-12)
        months12.forEach((m, i) => {
          const prior = window.length >= 24 ? values[values.length - 24 + i] : null
          // With two years, the profile is the latest year; growth carries it forward.
          profile[String(parseMonth(m).month)] = roundCents(last12[i] ?? prior ?? 0)
        })
        const yoy = window.length >= 24 ? (m12 / mean(values.slice(-24, -12))) - 1 : undefined
        return {
          method: 'seasonal',
          params: {
            profile,
            anchor: next,
            ...(yoy != null && Number.isFinite(yoy) && Math.abs(yoy) < 1 ? { annualGrowth: Math.round(yoy * 10000) / 10000 } : {}),
          },
          confidence: repeats ? 'high' : 'medium',
          evidence: `Most months near ${fmt(m12)}, with ${spikes.length} month${spikes.length === 1 ? '' : 's'} well off it (${months12.filter((_, i) => Math.abs(last12[i] - m12) > 0.5 * Math.abs(m12)).map(label).join(', ')})${repeats ? ', repeating the year before' : ''}`,
          warnings: repeats ? [] : window.length >= 24 ? ['The off months did not repeat the year before'] : ['One year of history: the shape is not yet confirmed'],
        }
      }
    }

    // ---- fixed: the same amount every month, lately ---------------------------------------------
    // An exact repeat (a fee, rent, an amortization) is a fixed amount, not an average that drifts
    // with the months it was not yet charged.
    {
      const latest = live[live.length - 1]
      let run = 0
      for (let i = live.length - 1; i >= 0 && latest !== 0 && Math.abs(live[i] - latest) <= 0.005 * Math.abs(latest); i--) run++
      if (run >= 3) {
        return {
          method: 'fixed',
          params: { amount: roundCents(latest) },
          confidence: run >= 6 ? 'high' : short ? 'low' : 'medium',
          evidence: `${fmt(latest)} every month for the last ${run} months (since ${label(liveMonths[liveMonths.length - run])})`,
          warnings: [...shortWarning, ...(run < 6 ? ['A short run — confirm the amount holds'] : [])],
        }
      }
    }

    // ---- trending: a steady rise or fall ----------------------------------------------------
    if (!short) {
      const xs = values.map((_, i) => i)
      const mx = mean(xs)
      const my = avg
      const sxy = xs.reduce((s, x, i) => s + (x - mx) * (values[i] - my), 0)
      const sxx = xs.reduce((s, x) => s + (x - mx) ** 2, 0)
      const slope = sxy / sxx
      const fitted = (i: number) => my + slope * (i - mx)
      const ssr = values.reduce((s, v, i) => s + (v - fitted(i)) ** 2, 0)
      const sst = values.reduce((s, v) => s + (v - my) ** 2, 0)
      const r2 = sst > 0 ? 1 - ssr / sst : 0
      const last = fitted(values.length - 1)
      const monthly = last !== 0 ? slope / last : 0
      if (r2 >= 0.7 && Math.abs(monthly) >= 0.005 && Math.abs(monthly) <= 0.1) {
        return {
          method: 'growth',
          params: { base: roundCents(last), baseMonth: window[window.length - 1], rate: Math.round(monthly * 10000) / 10000, per: 'month' },
          confidence: r2 >= 0.85 ? 'high' : 'medium',
          evidence: `${monthly > 0 ? 'Rising' : 'Falling'} about ${(Math.abs(monthly) * 100).toFixed(1)}% a month over ${window.length} months, from ${fmt(values[0])} to ${fmt(values[values.length - 1])}`,
          warnings: [],
        }
      }
    }

    // ---- stepped: the recent level is different ---------------------------------------------
    if (live.length >= 6 && avg !== 0 && Math.abs(recent - avg) > 0.15 * Math.abs(avg)) {
      return {
        method: 'run_rate',
        params: { window: 3 },
        confidence: 'medium',
        evidence: `The last 3 months average ${fmt(recent)}, against ${fmt(avg)} over ${live.length} — the recent level is used`,
        warnings: [...shortWarning, 'A step change: check whether the new level will hold'],
      }
    }

    // ---- steady -----------------------------------------------------------------------------
    // Averaged from the first active month, so a cost that started mid-window is not diluted.
    return {
      method: 'run_rate',
      params: firstActive > 0 ? { from: liveMonths[0], to: liveMonths[liveMonths.length - 1] } : { window: 12 },
      confidence: short ? (live.length >= 6 ? 'medium' : 'low') : 'high',
      evidence: `Steady: ${nonzero.length} of ${live.length} months since ${label(liveMonths[0])}, averaging ${fmt(mean(live.slice(-12)))}`,
      warnings: shortWarning,
    }
  }

  // ---- irregular: no cycle, not most months ---------------------------------------------------
  return {
    method: 'run_rate',
    params: { window: 12 },
    confidence: 'low',
    evidence: `Irregular: ${nonzero.length} of ${window.length} months with no cycle (${nonzero.slice(-4).map(label).join(', ')}${nonzero.length > 4 ? ', …' : ''})`,
    warnings: [...shortWarning, 'Spread evenly as a 12-month average — consider manual amounts if the timing is known'],
  }
}
