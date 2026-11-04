// The time axis the construction model deliberately lacks.
//
// `constructionModel` (construction.ts) answers HOW MUCH: what remains, what the plan costs, what
// the portfolio has to return. It says nothing about WHEN — and its header says so, because a
// chart with a date axis would otherwise be inventing a schedule. This module is where that
// schedule is STATED rather than inferred: how many years the remaining checks are written over,
// how long after each initial check its follow-on comes, how long a deal is held, how long the
// existing book has left. Given those, the same forecast proceeds the model already computes fall
// onto years, and the fund gets a J-curve, DPI and TVPI by year, and a net IRR.
//
// PURE, like the model. Runs on the server for the agent and in the browser on every keystroke.
//
// WHAT IS NOT MODELLED. Proceeds are gross to the fund, before carry, so the multiples here are
// fund-level TVPI and DPI on called capital — not an LP's net-of-carry number. Capital is called as
// it is needed (investments, fees and expenses in each year), which is how most funds actually
// draw; a fund that front-loads calls will show a steeper early J than this. NAV between today and
// an exit carries at cost (or current value) by default, with an optional straight-line accretion
// to the forecast proceeds — the accreting view is the more familiar picture, the flat one the more
// honest one, and the page offers both.

import type { ConstructionActuals, ConstructionAssumptions, ConstructionResult, ConstructionWaterfallProjection, PacingAssumptions } from './construction'
import { projectFeesForYear, DEFAULT_PACING } from './construction'
import { runWaterfall } from './waterfall'
import { forwardWaterfall, PER_LP_FORECAST_WARNING, projectedDeals } from './forward-waterfall'
import { allocateRecycling, type RecyclingTreatment } from '@portfolio/fund-engine'
import { forwardYearsToRows, rowCalendarYear, rowEndTime, rowOfTime, scheduleGrid, type ScheduleGrid } from './construction-calendar'

/** One forecast baseline for the page, API, and agent. No invented historical flow dates. */
export function constructionBaseline(actuals: ConstructionActuals, model: ConstructionResult, asOf: string): ForecastBaseline {
  return actuals.capitalAvailable === true
    ? { asOf, calledCapital: actuals.calledCapital!, distributed: actuals.distributedCapital!, nav: actuals.nav, ...(actuals.cashBalance != null ? { cashBalance: actuals.cashBalance } : {}) }
    : { asOf, calledCapital: model.capital.deployedTotal, distributed: model.returns.positions.reduce((sum, position) => sum + position.actual.distributions, 0), nav: model.returns.currentPortfolioValue }
}

export { DEFAULT_PACING }
export type { PacingAssumptions }

const r = (n: number) => Math.round(n * 100) / 100

/** Where the fund stands today — the year-0 point every curve starts from. */
export interface ForecastBaseline {
  /** YYYY-MM-DD. */
  asOf: string
  calledCapital: number
  /** Capital returned to partners to date (positive). */
  distributed: number
  nav: number
  /** Actual posted cash, when the vehicle keeps books. */
  cashBalance?: number
  /**
   * The dated history behind `calledCapital` and `distributed`, as partner-side flows in years
   * from today (negative = the past): called capital negative, distributions positive. With it the
   * IRR is since inception; without it the past is one lump at today and the IRR reads forward.
   */
  historyFlows?: { t: number; amount: number }[]
}

/** One deal laid on the timeline, in years from today (fractional). */
export interface DealTimeline {
  key: string
  name: string
  kind: 'existing' | 'planned'
  /** Cost already deployed — sits in the past. */
  investedToDate: number
  /** Earliest known investment date for an existing company. */
  investmentDate?: string
  /** Carrying value today (existing) or 0 (planned). */
  currentValue: number
  /** Initial check still to write, and when. Zero for an existing company. */
  initialCheck: number
  initialAt: number
  /** Follow-on still to write, and when. */
  followOn: number
  followOnAt: number
  /** Forecast proceeds and when they arrive. Null when the model has no forecast (an exited deal). */
  proceeds: number | null
  exitAt: number
  /** Whether the exit timing was stated for this deal or came from the fund-wide pacing. */
  timing: 'stated' | 'pacing'
  /** Per-deal simulation overrides, when stated. The simulation falls back to the fund-wide values. */
  lossRate?: number
  dispersion?: number
  exitSpreadYears?: number
  /** Most of the exit to recycle (0 = none); absent = automatic, within the fund's cap. */
  recycleAmount?: number
  recycleTreatment?: RecyclingTreatment
  /** Set by forecastSchedule: how much of the exit is recycled, and the part booked as deemed. */
  recycled?: number
  recycledDeemed?: number
}

export interface ForecastYear {
  /** The row: 0 is the baseline (today), then one row per calendar year (./construction-calendar.ts). */
  year: number
  /** The calendar year this row covers, e.g. 2029. Row 1 is the rest of the current year. */
  calendarYear: number
  /** Years from today at the end of this row: when its year-end values are measured. */
  t: number
  // Flows in the year
  invested: number
  fees: number
  expenses: number
  called: number
  distributed: number
  /** GP carry allocated by the waterfall in this year. */
  carriedInterest?: number
  /** Exit proceeds put back to work this year instead of distributed. */
  recycled?: number
  /**
   * The part of `recycled` booked as distributed and recontributed. It is in `called` and
   * `distributed` too; recycling never distributed is in neither.
   */
  recycledDeemed?: number
  // Cumulative at the year end
  cumCalled: number
  cumInvested: number
  cumDistributed: number
  nav: number
  dpi: number | null
  rvpi: number | null
  tvpi: number | null
  /** Net IRR on called capital through this year, with NAV as the terminal value. */
  netIrr: number | null
}

export interface ForecastSchedule {
  years: ForecastYear[]
  deals: DealTimeline[]
  /** The horizon in years from today. The rows run to it (./construction-calendar.ts). */
  horizonYears: number
  /** How the rows map onto months: calendar years from the as-of month to the horizon. */
  grid: ScheduleGrid
  warnings: string[]
  /** True when the pacing assumptions say enough to place a single exit. */
  stated: boolean
}

/**
 * Lay the model's deals on the calendar.
 *
 * A deal's own timing wins when it is stated on the forecast: an existing company's years to exit,
 * a planned deal's year of investment and years to exit, and either one's follow-on timing.
 * Planned deals without their own investment timing are deliberately omitted: the timeline never
 * invents when a check will be written. Fund-wide pacing still supplies follow-on and hold periods.
 */
export function dealTimelines(model: ConstructionResult, pacing: PacingAssumptions, asOf?: string): DealTimeline[] {
  const stated = (v: number | null | undefined): v is number => typeof v === 'number' && Number.isFinite(v)
  const overrides = (f: {
    simLossRate?: number | null; simDispersion?: number | null; simExitSpreadYears?: number | null
    recycleAmount?: number | null; recycleTreatment?: RecyclingTreatment | null
  }) => ({
    ...(stated(f.simLossRate) ? { lossRate: f.simLossRate } : {}),
    ...(stated(f.simDispersion) ? { dispersion: f.simDispersion } : {}),
    ...(stated(f.simExitSpreadYears) ? { exitSpreadYears: f.simExitSpreadYears } : {}),
    ...(stated(f.recycleAmount) ? { recycleAmount: Math.max(0, f.recycleAmount) } : {}),
    ...(f.recycleTreatment ? { recycleTreatment: f.recycleTreatment } : {}),
  })
  const out: DealTimeline[] = []
  for (const p of model.returns.positions) {
    const f = p.forecast
    const investmentDate = p.actual.firstInvestmentDate && /^\d{4}-\d{2}-\d{2}$/.test(p.actual.firstInvestmentDate)
      ? p.actual.firstInvestmentDate
      : undefined
    const investedAt = investmentDate && asOf ? yearsBetween(asOf, investmentDate) : 0
    // A known investment date anchors the expected exit to investment date + hold period. An
    // undated position retains the conservative "hold from today" fallback.
    const pacedExit = investmentDate && asOf
      ? Math.max(0.25, investedAt + pacing.holdYears)
      : pacing.existingHoldYears
    const exitAt = Math.max(0, stated(f.exitInYears)
      ? (investmentDate ? investedAt + f.exitInYears : f.exitInYears)
      : pacedExit)
    const hasFollowOnTiming = stated(f.followOnInYears)
    const followOnAt = hasFollowOnTiming ? Math.max(0, f.followOnInYears ?? 0) : 0
    out.push({
      key: p.actual.companyId,
      name: p.actual.name,
      kind: 'existing',
      investedToDate: p.actual.investedTotal,
      ...(investmentDate ? { investmentDate } : {}),
      currentValue: p.currentValue,
      initialCheck: 0,
      initialAt: investedAt,
      followOn: hasFollowOnTiming ? f.plannedFollowOn : 0,
      followOnAt: Math.min(exitAt, followOnAt),
      proceeds: p.isForecasted ? p.estimatedReturn : null,
      exitAt,
      timing: stated(f.exitInYears) ? 'stated' : 'pacing',
      ...overrides(f),
    })
  }
  model.returns.stages.forEach(st => {
    if (!stated(st.investInYears)) return
    const initialAt = Math.max(0, st.investInYears)
    const exitAt = initialAt + Math.max(0, stated(st.exitInYears) ? st.exitInYears : pacing.holdYears)
    const hasFollowOnTiming = stated(st.followOnInYears)
    const followOnLag = hasFollowOnTiming ? Math.max(0, st.followOnInYears ?? 0) : 0
    out.push({
      key: st.key,
      name: st.label || 'New investment',
      kind: 'planned',
      investedToDate: 0,
      currentValue: 0,
      initialCheck: st.plannedInitial,
      initialAt,
      followOn: hasFollowOnTiming ? st.plannedFollowOn : 0,
      followOnAt: Math.min(exitAt, initialAt + followOnLag),
      proceeds: st.estimatedReturn,
      exitAt,
      timing: stated(st.exitInYears) || stated(st.investInYears) ? 'stated' : 'pacing',
      ...overrides(st),
    })
  })
  return out
}

/** The year (1-based bucket) a fractional time-from-today falls in; time 0 is year 0. */
const yearOf = (t: number) => (t <= 0 ? 0 : Math.ceil(t - 1e-9))

/** Fractional years from the as-of date to an investment date; past dates are negative. */
function yearsBetween(asOf: string, date: string): number {
  const end = Date.parse(`${asOf}T00:00:00Z`)
  const start = Date.parse(`${date}T00:00:00Z`)
  if (!Number.isFinite(end) || !Number.isFinite(start)) return 0
  return (start - end) / (365.2425 * 24 * 60 * 60 * 1000)
}

/** A dated flow for the IRR: `t` in years (fractional, negative for the past). */
export interface TimedFlow { t: number; amount: number }

/**
 * Annualised IRR of dated flows, by bisection. Flows are from the partners' side: called capital
 * negative, distributions and terminal NAV positive. Null without a sign change or a time spread.
 * Bisection rather than Newton because the simulation calls this thousands of times and a bracket
 * search cannot run away on an awkward flow pattern.
 */
export function irrOf(flows: TimedFlow[]): number | null {
  const live = flows.filter(f => Math.abs(f.amount) > 0.005)
  if (live.length < 2) return null
  if (!live.some(f => f.amount < 0) || !live.some(f => f.amount > 0)) return null
  const t0 = Math.min(...live.map(f => f.t))
  const t1 = Math.max(...live.map(f => f.t))
  if (t1 - t0 < 1 / 365) return null
  const npv = (rate: number) => live.reduce((s, f) => s + f.amount / Math.pow(1 + rate, f.t - t0), 0)
  let lo = -0.99
  let hi = 10
  let fLo = npv(lo)
  const fHi = npv(hi)
  if (!Number.isFinite(fLo) || !Number.isFinite(fHi) || fLo * fHi > 0) return null
  for (let i = 0; i < 200; i++) {
    const mid = (lo + hi) / 2
    const fMid = npv(mid)
    if (Math.abs(fMid) < 1e-7 || hi - lo < 1e-7) return mid
    if (fLo * fMid < 0) { hi = mid } else { lo = mid; fLo = fMid }
  }
  return (lo + hi) / 2
}

/**
 * The yearly schedule: what the plan calls, invests, spends, returns and holds in each year from
 * today, and the multiples and IRR that fall out of it.
 *
 * `proceedsOverride` lets the simulation replace each deal's proceeds and exit year with a sampled
 * outcome while reusing every other rule here, so the two never disagree about fees or pacing.
 */
export function forecastSchedule(
  model: ConstructionResult,
  a: ConstructionAssumptions,
  pacing: PacingAssumptions,
  baseline: ForecastBaseline,
  proceedsOverride?: Map<string, { proceeds: number; exitAt: number }>,
  /** Which years get an IRR. The simulation asks for the final year only; it is the slow part. */
  irr: 'all' | 'final' | 'none' = 'all',
): ForecastSchedule {
  const warnings: string[] = []
  let deals = dealTimelines(model, pacing, baseline.asOf).map(d => {
    const o = proceedsOverride?.get(d.key)
    return o && d.proceeds != null ? { ...d, proceeds: o.proceeds, exitAt: o.exitAt } : d
  })
  // Stated once the fund-wide pacing says anything, or any deal carries its own exit.
  const stated = pacing.holdYears > 0 || pacing.existingHoldYears > 0
    || deals.some(d => d.timing === 'stated' && d.exitAt > 0)

  const undatedPlannedDeals = model.returns.stages.length - deals.filter(d => d.kind === 'planned').length
  if (undatedPlannedDeals > 0) {
    warnings.push(`${undatedPlannedDeals} planned investment${undatedPlannedDeals === 1 ? '' : 's'} need${undatedPlannedDeals === 1 ? 's' : ''} investment timing before being included in the return forecast.`)
  }
  const untimedFollowOns = model.returns.positions.filter(p => p.forecast.plannedFollowOn > 0 && !Number.isFinite(p.forecast.followOnInYears)).length
    + model.returns.stages.filter(st => st.plannedFollowOn > 0 && !Number.isFinite(st.followOnInYears)).length
  if (untimedFollowOns > 0) {
    warnings.push(`${untimedFollowOns} follow-on reserve${untimedFollowOns === 1 ? '' : 's'} need${untimedFollowOns === 1 ? 's' : ''} timing before being included in the return forecast.`)
  }

  const lastExit = deals.reduce((m, d) => Math.max(m, d.exitAt, d.followOnAt, d.initialAt), 0)
  // An explicitly selected horizon can extend the display, but the fee term must not keep an
  // otherwise-liquidated fund alive. Once every modeled position has exited there is nothing left
  // to manage and therefore no recurring fee or expense base.
  const horizonYears = Math.max(1, Math.ceil(pacing.horizonYears > 0 ? pacing.horizonYears : lastExit))
  const modeledExitYears = deals.filter(d => d.proceeds != null).map(d => yearOf(d.exitAt))
  const finalExitYear = modeledExitYears.length > 0 ? Math.max(...modeledExitYears) : null

  // Calendar-year rows (./construction-calendar.ts): row 1 is the rest of this year.
  const grid = scheduleGrid(baseline.asOf || new Date().toISOString().slice(0, 10), horizonYears)
  const rows = grid.rows
  const rowOf = (t: number) => rowOfTime(grid, t)
  const committed = model.capital.committedCapital
  const deployedTotal = model.capital.deployedTotal
  const accretion = pacing.accretion === 'none' ? 'none' : 'linear'

  // Per-year flows.
  const invested = new Array<number>(rows + 1).fill(0)
  const proceeds = new Array<number>(rows + 1).fill(0)
  for (const d of deals) {
    if (d.initialCheck > 0) invested[rowOf(d.initialAt)] += d.initialCheck
    if (d.followOn > 0) invested[rowOf(d.followOnAt)] += d.followOn
    if (d.proceeds != null && d.proceeds > 0 && d.exitAt <= horizonYears + 1e-9) proceeds[rowOf(d.exitAt)] += d.proceeds
  }

  const years: ForecastYear[] = []
  let cumCalled = baseline.calledCapital
  let cumInvested = deployedTotal
  let cumDistributed = baseline.distributed
  // Use the same capital reconciliation as the summary above: capital already called, less
  // deployed capital and incurred expenses. NAV contains investment marks, so NAV minus portfolio
  // value is not a reliable cash balance and made the timeline disagree with Capital planning.
  let cash = Math.max(0, baseline.cashBalance != null
    ? baseline.cashBalance
    : model.capital.calledCapital - deployedTotal - model.capital.incurredExpenses)
  // The past, for the IRR: dated when the caller has the dates, one lump at today otherwise.
  const history: TimedFlow[] = baseline.historyFlows && baseline.historyFlows.length > 0
    ? baseline.historyFlows
    : [{ t: 0, amount: -baseline.calledCapital + baseline.distributed }]
  const forward: TimedFlow[] = []

  // Recycling: within the cap, exits fund the plan's later investments instead of being
  // distributed. Deals that set an amount go first, then the earliest exits (fund-engine
  // allocateRecycling). An exit after the plan's last investment has nothing left to fund, so it
  // is not recycled, and neither is one after the recycling period.
  const recycled = new Array<number>(rows + 1).fill(0)
  const recycledDeemed = new Array<number>(rows + 1).fill(0)
  const capRate = pacing.recycleCapRate ?? 0
  if (capRate > 0) {
    const lastInvestmentYear = invested.reduce((last, v, t) => (v > 0 ? t : last), 0)
    // Within the recycling period (years from today) and no later than the calendar year of the
    // plan's last investment.
    const exits = deals.filter(d => d.proceeds != null && d.proceeds > 0 && d.exitAt <= horizonYears + 1e-9
      && (pacing.recycleUntilYears == null || d.exitAt <= pacing.recycleUntilYears + 1e-9))
    const allocation = allocateRecycling(
      exits.map(d => ({
        at: rowOf(d.exitAt),
        proceeds: d.proceeds!,
        ...(d.recycleAmount !== undefined ? { amount: d.recycleAmount } : {}),
        ...(d.recycleTreatment ? { treatment: d.recycleTreatment } : {}),
      })),
      // Up to the cap, and no more than the plan still has to invest beyond the cash in hand:
      // recycling more than the plan can spend would only park cash.
      Math.min(capRate * committed, Math.max(0, invested.reduce((s, v) => s + v, 0) - cash)),
      { until: lastInvestmentYear, defaultTreatment: pacing.recycleTreatment ?? 'retained' },
    )
    const byDeal = new Map(exits.map((d, i) => [d, allocation[i]]))
    exits.forEach((d, i) => {
      recycled[rowOf(d.exitAt)] += allocation[i].recycled
      recycledDeemed[rowOf(d.exitAt)] += allocation[i].deemed
    })
    // On the deals too, so the monthly plan forecast books each exit's recycling in its own month.
    deals = deals.map(d => {
      const got = byDeal.get(d)
      return got && got.recycled > 0 ? { ...d, recycled: got.recycled, recycledDeemed: got.deemed } : d
    })
  }

  const navAt = (t: number): number => {
    // Unexited deals carry at their value today (existing) or at cost (planned), optionally
    // accreting straight-line to the forecast proceeds between now and the exit.
    let v = 0
    for (const d of deals) {
      if (d.exitAt <= t + 1e-9 && d.proceeds != null) continue // exited by now
      const cost = d.currentValue
        + (d.initialCheck > 0 && d.initialAt <= t ? d.initialCheck : 0)
        + (d.followOn > 0 && d.followOnAt <= t ? d.followOn : 0)
      if (d.proceeds == null) { v += cost; continue }
      const start = d.kind === 'planned' ? d.initialAt : 0
      if (accretion === 'linear' && d.exitAt > start && t > start) {
        const frac = Math.min(1, (t - start) / (d.exitAt - start))
        // From what is at work to the forecast proceeds, once all the capital is in.
        const fullCost = d.currentValue + d.initialCheck + d.followOn
        v += cost + Math.max(0, d.proceeds - fullCost) * frac
      } else {
        v += cost
      }
    }
    return v
  }

  // Fees and expenses. The plan's own when it has them (its rules decide when they stop), already
  // by calendar row (lib/forecast/plan-costs.ts). Else construction's inputs: stated per forward
  // year (year y = the twelve months ending y years from today), fee-paying commitments only — the
  // GP's own stake pays no fee — spread over their months and added up by calendar row.
  const planCosts = model.capital.planCosts
  const fwdYears = Math.ceil(horizonYears)
  const operating = (y: number) => y > 0 && (finalExitYear == null || y <= finalExitYear)
  const fwdFees = Array.from({ length: fwdYears + 1 }, (_, y) => operating(y)
    ? Math.round(projectFeesForYear(a, committed, deployedTotal, baseline.nav, y) * (model.capital.feePayingShare ?? 1) * 100) / 100 : 0)
  const fwdExpenses = Array.from({ length: fwdYears + 1 }, (_, y) => operating(y)
    ? (y <= a.feeTermYears ? a.annualPartnershipExpense : 0) + (y === 1 ? a.remainingOrgCosts : 0) : 0)
  const feesByRow = planCosts ? planCosts.feesByYear : forwardYearsToRows(grid, fwdFees)
  const expensesByRow = planCosts ? planCosts.expensesByYear : forwardYearsToRows(grid, fwdExpenses)

  for (let t = 0; t <= rows; t++) {
    const fees = t > 0 ? feesByRow[t] ?? 0 : 0
    const expenses = t > 0 ? expensesByRow[t] ?? 0 : 0
    const at = rowEndTime(grid, t)
    const inv = t === 0 ? 0 : invested[t]
    const grossProceeds = t === 0 ? 0 : proceeds[t]
    const recycledNow = t === 0 ? 0 : recycled[t]
    const deemedNow = t === 0 ? 0 : recycledDeemed[t]
    let dist = grossProceeds

    // Call what the dated plan needs after using cash on hand. Whether the investment plan fits
    // the fund is decided once by constructionModel; this timeline only places that plan in time.
    let called = 0
    if (t > 0) {
      // Recycled proceeds join the cash on hand, so they pay for investments before a call does.
      cash += recycledNow
      // Spend existing cash on scheduled investments first, then operating costs. Exit proceeds
      // beyond recycling are not put into investments, but they can cover same-year fees and
      // wind-down costs.
      const investmentFromCash = Math.min(cash, inv)
      cash -= investmentFromCash
      const investmentCall = inv - investmentFromCash
      const operatingNeed = fees + expenses
      const operatingFromCash = Math.min(cash, operatingNeed)
      cash -= operatingFromCash
      const remainingOperatingNeed = operatingNeed - operatingFromCash
      // Exit proceeds pay same-year operating and wind-down costs before cash is distributed.
      // That prevents a final capital call merely to pay expenses while proceeds leave the fund.
      const fromProceeds = Math.min(grossProceeds - recycledNow, remainingOperatingNeed)
      dist = grossProceeds - recycledNow - fromProceeds
      called = investmentCall + remainingOperatingNeed - fromProceeds
      // Recycling booked as distributed and recontributed: the same cash, shown on both sides.
      dist += deemedNow
      called += deemedNow
      cumCalled += called
      cumInvested += inv
      cumDistributed += dist
    }
    const nav = r(navAt(at) + cash)

    if (t > 0) forward.push({ t: at, amount: dist - called })
    const wantIrr = irr === 'all' || (irr === 'final' && t === rows)
    const netIrr = t === 0 || !wantIrr ? null : irrOf([...history, ...forward, { t: at, amount: nav }])

    years.push({
      year: t,
      calendarYear: rowCalendarYear(grid, t),
      t: at,
      invested: r(inv),
      fees: r(fees),
      expenses: r(expenses),
      called: r(called),
      distributed: r(dist),
      ...(recycledNow > 0 ? { recycled: r(recycledNow), recycledDeemed: r(deemedNow) } : {}),
      cumCalled: r(cumCalled),
      cumInvested: r(cumInvested),
      cumDistributed: r(cumDistributed),
      nav,
      dpi: cumCalled > 0 ? cumDistributed / cumCalled : null,
      rvpi: cumCalled > 0 ? nav / cumCalled : null,
      tvpi: cumCalled > 0 ? (cumDistributed + nav) / cumCalled : null,
      netIrr,
    })
  }

  const unexited = deals.filter(d => d.proceeds != null && d.exitAt > horizonYears + 1e-9).length
  if (unexited > 0) {
    warnings.push(`${unexited} deal${unexited === 1 ? '' : 's'} exit${unexited === 1 ? 's' : ''} after the ${horizonYears}-year horizon and still sit${unexited === 1 ? 's' : ''} in NAV at the end.`)
  }

  return { years, deals, horizonYears, grid, warnings, stated }
}

/**
 * Apply the vehicle's waterfall to a gross fund schedule and return the LP-only view. Carry is an
 * internal transfer at whole-fund level, so LP DPI/TVPI are the meaningful net-of-carry metrics.
 */
export function applyLpWaterfall(schedule: ForecastSchedule, projection?: ConstructionWaterfallProjection): ForecastSchedule {
  if (!projection) return schedule
  const share = Math.min(1, Math.max(0, projection.lpCommitmentShare))
  // Each year's flows land on its last day, so the deals' do too (deal by deal, forward-waterfall.ts).
  const yearEndOf = (t: number) => `${rowCalendarYear(schedule.grid, rowOfTime(schedule.grid, t))}-12-31`
  const deals = projection.kind === 'american'
    ? projectedDeals(schedule.deals, schedule.horizonYears, yearEndOf, schedule.years
      .filter(y => y.year > 0)
      .map(y => ({ date: `${y.calendarYear}-12-31`, amount: y.fees + y.expenses })))
    : undefined
  // Null when there is no carry: the LPs keep their share of everything.
  const waterfall = forwardWaterfall(projection, deals)
  const history: TimedFlow[] = [
    ...projection.contributions.map(flow => ({ t: yearsBetween(projection.asOf, flow.date), amount: -flow.amount })),
    ...(projection.distributions ?? []).map(flow => ({ t: yearsBetween(projection.asOf, flow.date), amount: flow.amount })),
  ]
  const forward: TimedFlow[] = []
  let called = projection.lpCalledCapital
  let distributed = projection.lpDistributedCapital
  const years = schedule.years.map((year, index) => {
    if (index === 0) {
      return {
        ...year,
        cumCalled: called,
        cumDistributed: distributed,
        carriedInterest: Math.max(0, projection.fundDistributedCapital - projection.lpDistributedCapital),
        nav: projection.lpNav,
        dpi: called > 0 ? distributed / called : null,
        rvpi: called > 0 ? projection.lpNav / called : null,
        tvpi: called > 0 ? (distributed + projection.lpNav) / called : null,
        netIrr: irrOf([...history, { t: 0, amount: projection.lpNav }]),
      }
    }
    const lpCall = year.called * share
    called += lpCall
    const yearEnd = `${year.calendarYear}-12-31`
    // The year's fees and expenses first, so terms that return only invested capital can tell what
    // the call paid for, as the books do.
    waterfall?.charge(yearEnd, year.fees * share, 'fees')
    waterfall?.charge(yearEnd, year.expenses * share, 'expenses')
    waterfall?.contribute(yearEnd, lpCall)
    // Only the LPs' share runs through the waterfall. The rest belongs to the carry recipients'
    // own stake (the GP's commitment), which is returned gross — no carry on the GP's own money.
    const lpDistributable = year.distributed * share
    const split = waterfall ? waterfall.distribute(yearEnd, lpDistributable) : { toLP: lpDistributable, toGP: 0 }
    distributed += split.toLP
    // Hypothetical liquidation of remaining NAV at this year end, without mutating the state.
    const netNav = waterfall ? runWaterfall(year.nav * share, waterfall.terms, waterfall.liquidationStateAt(yearEnd)).toLP : year.nav * share
    if (lpCall > 0) forward.push({ t: year.t, amount: -lpCall })
    if (split.toLP > 0) forward.push({ t: year.t, amount: split.toLP })
    const netIrr = irrOf([...history, ...forward, { t: year.t, amount: netNav }])
    return {
      ...year,
      called: lpCall,
      distributed: split.toLP,
      carriedInterest: split.toGP,
      cumCalled: called,
      cumDistributed: distributed,
      nav: netNav,
      dpi: called > 0 ? distributed / called : null,
      rvpi: called > 0 ? netNav / called : null,
      tvpi: called > 0 ? (distributed + netNav) / called : null,
      netIrr,
    }
  })
  // A waterfall per LP is forecast whole fund: a forecast has no per-LP timing.
  const warnings = projection.perLp && waterfall && !schedule.warnings.includes(PER_LP_FORECAST_WARNING)
    ? [...schedule.warnings, PER_LP_FORECAST_WARNING]
    : schedule.warnings
  return { ...schedule, years, warnings }
}
