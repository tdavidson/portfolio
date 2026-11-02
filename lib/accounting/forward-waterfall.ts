// The waterfall run forward from today's books, for the forecasts.
//
// Both forecasts (construction's yearly schedule and the plan's monthly one) start from the state the
// books show and push projected calls and distributions through the vehicle's waterfall. They used
// to build that state by hand and pass only the carry rate and catch-up rate, so a half-size
// catch-up, a hurdle on unreturned capital, or a deal-by-deal waterfall forecast differently from
// what the accounting engine would book. This keeps them on the same terms as `runWaterfall` and
// `preferredTarget` in the fund engine.
//
// Deal by deal. An American waterfall owes the LPs back only the capital in deals realized so far
// (sold or written off, with their share of fees and expenses), and the hurdle accrues only on that
// capital, so the GP can be paid carry on an early winner before the whole fund is returned. The
// forecasts know each deal's checks and exit, so with the deals on the books (`dealByDeal` on the
// projection) and the projected ones (`ProjectedDeals`) the base is the same one the accounting
// measures (realized-capital.ts, `realizedCapitalFromDeals`). Without them an American waterfall
// still runs whole fund, and `wholeFundFallback` says so.
//
// A hypothetical liquidation realizes every deal, so the value of what's left (`liquidationStateAt`)
// is measured whole fund under either kind, as the close accrues it (carry.ts).
//
// Per LP. Terms that run the waterfall per LP (waterfallScope 'per_lp') are still forecast whole
// fund: a forecast projects the fund's calls and distributions, not each LP's, so there is no per-LP
// timing to run the tiers on. That is exact while the LPs are pro rata, and the forecasts say so
// (PER_LP_FORECAST_WARNING).

import {
  capitalContributions,
  hurdleTarget,
  realizedCapitalFromDeals,
  runWaterfall,
  type DatedContribution,
  type DealHistory,
  type HurdleReduction,
  type WaterfallResult,
  type WaterfallState,
  type WaterfallTerms,
} from '@portfolio/fund-engine'
import { roundCents } from './ledger'
import { factorOf } from './realized-capital'
import type { ConstructionWaterfallProjection } from './construction'
import type { DealTimeline } from './construction-forecast'

export interface ForwardWaterfall {
  terms: WaterfallTerms
  /** True when the terms are deal by deal and the forecast runs them whole fund. */
  wholeFundFallback: boolean
  /** Add an LP contribution (the LPs' share of a call). */
  contribute(date: string, amount: number): void
  /**
   * The LPs' share of a management fee or fund expense charged on `date`. It only matters under
   * terms that return some purposes and not others (`capitalIncludes`): the charge then uses the
   * LPs' oldest capital not yet used, or the next call, the way the books tag what each call paid
   * for (`datedContributions`). Charge before the same date's call, as the books order them.
   */
  charge(date: string, amount: number, purpose: 'fees' | 'expenses'): void
  /** Run one LP distribution through the waterfall on `date`, and keep the result. */
  distribute(date: string, amount: number): WaterfallResult
  /** The state on `date`: capital contributed so far and the hurdle accrued to then. */
  stateAt(date: string): WaterfallState
  /** The state a liquidation on `date` would run from: every deal realized, so whole fund. */
  liquidationStateAt(date: string): WaterfallState
}

/** What the forecast says the deals will do, for an American waterfall. Dates are bucket ends. */
export interface ProjectedDeals {
  /** Checks still to write. `deal` is the company id for a company already held. */
  investments: { deal: string; date: string; amount: number }[]
  /** Exits and write-offs: what is left of the deal's cost is realized on `date`. */
  exits: { deal: string; date: string }[]
  /** Fees and expenses still to come, which the realized base carries by cost share. */
  expenses: { date: string; amount: number }[]
}

/**
 * The deals' projected checks and exits, placed by `dateOf` (the end of the bucket a time from
 * today falls in, or null to leave it out). Only flows after today are projected; what's already
 * happened is on the books. A deal that exits for nothing is a write-off, and realizes all the same.
 */
export function projectedDeals(
  deals: DealTimeline[],
  horizonYears: number,
  dateOf: (t: number) => string,
  expenses: { date: string; amount: number }[] = [],
): ProjectedDeals {
  const out: ProjectedDeals = { investments: [], exits: [], expenses }
  for (const d of deals) {
    const place = (t: number, amount: number) => {
      if (amount > 0 && t > 0) out.investments.push({ deal: d.key, date: dateOf(Math.min(t, horizonYears)), amount })
    }
    place(d.initialAt, d.initialCheck)
    place(d.followOnAt, d.followOn)
    if (d.proceeds != null && d.exitAt > 0 && d.exitAt <= horizonYears + 1e-9) out.exits.push({ deal: d.key, date: dateOf(d.exitAt) })
  }
  return out
}

/** A waterfall to run forward, or null when the projection carries no carry. */
export function forwardWaterfall(p: ConstructionWaterfallProjection, projected?: ProjectedDeals): ForwardWaterfall | null {
  if (p.kind === 'none' || !(p.carryRate > 0)) return null
  const straight = p.kind === 'straight'
  const terms: WaterfallTerms = {
    carryRate: p.carryRate,
    catchUpRate: straight ? 1 : p.catchupRate,
    catchUpSize: p.catchupSize ?? 1,
    ...(p.catchupMeasure === 'profit' ? { catchUpMeasure: 'profit' as const } : {}),
    ...(p.carrySteps?.length ? { steps: p.carrySteps } : {}),
  }
  const prefOn = !straight && (p.prefRate > 0 || p.prefMultiple != null)
  const unreturned = p.prefBase === 'unreturned'
  // Only the purposes the terms return count as capital. The books' calls come tagged; a projected
  // call is tagged here as the charges the forecast makes arrive (`charge`), first in, first out.
  const tagging = callTagging(p)
  const contributions = tagging.contributions
  const reductions: HurdleReduction[] = []
  const irr = irrHistory(p, contributions)

  const target = (date: string) => prefOn
    ? hurdleTarget(p, contributions, calledTo(date), date, unreturned ? reductions : undefined)
    : 0
  const calledTo = (date: string) => roundCents(contributions.filter(c => c.date <= date && c.amount > 0).reduce((s, c) => s + c.amount, 0))

  if (p.kind === 'american' && p.dealByDeal && projected) return dealByDealWaterfall(p, projected, terms, tagging, calledTo, irr)

  // On the unreturned basis the hurdle stops on capital already returned and pref already paid, so
  // the history has to say what each past distribution returned. The capital and pref tiers go
  // wholly to the LPs, so their net distributions show those two amounts exactly.
  if (unreturned && prefOn) {
    let hist: WaterfallState = { contributedCapital: 0, returnedCapital: 0, preferredPaid: 0, preferredTarget: 0, gpCarryPaid: 0 }
    const sorted = [...(p.distributions ?? [])].filter(d => d.amount > 0).sort((a, b) => a.date.localeCompare(b.date))
    for (const d of sorted) {
      const contributed = roundCents(contributions.filter(c => c.date <= d.date && c.amount > 0).reduce((s, c) => s + c.amount, 0))
      const step = runWaterfall(d.amount, terms, { ...hist, contributedCapital: contributed, preferredTarget: target(d.date) })
      reductions.push({ date: d.date, capital: step.toReturnOfCapital, preferred: step.toPreferred })
      hist = step.state
    }
  }

  let called = p.capitalIncludes ? calledTo(p.asOf) : p.lpCalledCapital
  const initialPref = target(p.asOf)
  let state: WaterfallState = {
    contributedCapital: called,
    returnedCapital: Math.min(called, p.lpDistributedCapital),
    preferredPaid: Math.min(initialPref, Math.max(0, p.lpDistributedCapital - p.lpCalledCapital)),
    preferredTarget: initialPref,
    gpCarryPaid: Math.max(0, p.fundDistributedCapital - p.lpDistributedCapital),
  }

  const stateAt = (date: string): WaterfallState => ({ ...state, contributedCapital: called, preferredTarget: target(date), ...irr(date, state) })

  return {
    terms,
    wholeFundFallback: p.kind === 'american',
    contribute(date, amount) {
      if (!(amount > 0)) return
      tagging.contribute(date, amount)
      called = p.capitalIncludes ? calledTo('9999-12-31') : roundCents(called + amount)
    },
    charge(date, amount, purpose) {
      if (!tagging.charge(date, amount, purpose)) return
      called = calledTo('9999-12-31')
    },
    distribute(date, amount) {
      const result = runWaterfall(amount, terms, stateAt(date))
      state = result.state
      if (result.toReturnOfCapital > 0 || result.toPreferred > 0) {
        reductions.push({ date, capital: result.toReturnOfCapital, preferred: result.toPreferred })
      }
      return result
    },
    stateAt,
    liquidationStateAt: stateAt,
  }
}

/**
 * The American waterfall run forward on the realized base. The deals are the books' plus the
 * forecast's; the base on any date counts only what was invested and realized by then.
 */
function dealByDealWaterfall(
  p: ConstructionWaterfallProjection,
  projected: ProjectedDeals,
  terms: WaterfallTerms,
  tagging: CallTagging,
  calledTo: (date: string) => number,
  irr: ReturnType<typeof irrHistory>,
): ForwardWaterfall {
  const basis = p.dealByDeal!
  const contributions = tagging.contributions
  const deals = new Map<string, DealHistory>()
  for (const d of basis.deals) {
    deals.set(d.companyId, { ...d, investments: [...d.investments], realizations: [...d.realizations] })
  }
  const dealOf = (key: string) => deals.get(key) ?? (deals.set(key, { companyId: key, investments: [], realizations: [] }), deals.get(key)!)
  for (const i of projected.investments) if (i.amount > 0) dealOf(i.deal).investments.push({ date: i.date, amount: i.amount })
  for (const x of projected.exits) dealOf(x.deal).realizations.push({ date: x.date, costExited: null })
  const expenses = projected.expenses.filter(e => e.amount > 0)

  const prefOn = p.prefRate > 0 || p.prefMultiple != null
  const unreturned = p.prefBase === 'unreturned'
  const reductions: HurdleReduction[] = []

  // The realized base on a date, from the deals as they stood then.
  const baseCache = new Map<string, DatedContribution[]>()
  const realizedTo = (date: string): DatedContribution[] => {
    const hit = baseCache.get(date)
    if (hit) return hit
    const asOfDate = [...deals.values()].map(d => ({
      companyId: d.companyId,
      investments: d.investments.filter(i => i.date <= date),
      realizations: d.realizations.filter(r => r.date <= date),
      closedOn: d.closedOn && d.closedOn <= date ? d.closedOn : null,
    }))
    const cost = asOfDate.reduce((s, d) => s + d.investments.reduce((t, i) => t + i.amount, 0), 0)
    const spent = basis.expenses + expenses.filter(e => e.date <= date).reduce((s, e) => s + e.amount, 0)
    const out = realizedCapitalFromDeals(asOfDate, { factor: factorOf(basis.lpShare, spent, cost) })
      .filter(c => c.realizedOn <= date && c.amount > 0)
      .map(c => ({ date: c.date, amount: c.amount }))
    baseCache.set(date, out)
    return out
  }
  // Never more capital owed back than the LPs have put in (replay.ts).
  const capitalTo = (date: string) => Math.min(roundCents(realizedTo(date).reduce((s, c) => s + c.amount, 0)), calledTo(date))
  const target = (date: string) => prefOn
    ? hurdleTarget(p, realizedTo(date), capitalTo(date), date, unreturned ? reductions : undefined)
    : 0
  const wholeTarget = (date: string) => prefOn
    ? hurdleTarget(p, contributions, calledTo(date), date, unreturned ? reductions : undefined)
    : 0

  // Where the tiers stand today: the books' distributions replayed on the base as it stood at each.
  // They're the LPs' net figures, which the capital and pref tiers pay in full, so the replay gives
  // returned capital and pref paid exactly. Carry paid comes from the books.
  let state: WaterfallState = { contributedCapital: 0, returnedCapital: 0, preferredPaid: 0, preferredTarget: 0, gpCarryPaid: 0 }
  const priors = [...(p.distributions ?? [])].filter(d => d.amount > 0 && d.date <= p.asOf).sort((a, b) => a.date.localeCompare(b.date))
  for (const d of priors) {
    const step = runWaterfall(d.amount, terms, { ...state, contributedCapital: capitalTo(d.date), preferredTarget: target(d.date) })
    reductions.push({ date: d.date, capital: step.toReturnOfCapital, preferred: step.toPreferred })
    state = { ...step.state }
  }
  state = {
    contributedCapital: capitalTo(p.asOf),
    returnedCapital: state.returnedCapital,
    preferredPaid: state.preferredPaid,
    preferredTarget: target(p.asOf),
    gpCarryPaid: Math.max(0, p.fundDistributedCapital - p.lpDistributedCapital),
  }

  const stateAt = (date: string): WaterfallState => ({ ...state, contributedCapital: capitalTo(date), preferredTarget: target(date), ...irr(date, state) })

  return {
    terms,
    wholeFundFallback: false,
    contribute(date, amount) {
      if (!(amount > 0)) return
      tagging.contribute(date, amount)
    },
    charge(date, amount, purpose) {
      tagging.charge(date, amount, purpose)
    },
    distribute(date, amount) {
      const result = runWaterfall(amount, terms, stateAt(date))
      state = result.state
      if (result.toReturnOfCapital > 0 || result.toPreferred > 0) {
        reductions.push({ date, capital: result.toReturnOfCapital, preferred: result.toPreferred })
      }
      return result
    },
    stateAt,
    liquidationStateAt: (date: string) => ({ ...state, contributedCapital: calledTo(date), preferredTarget: wholeTarget(date) }),
  }
}

interface CallTagging {
  /** The contributions the terms return as capital, kept current as calls and charges arrive. */
  contributions: DatedContribution[]
  contribute(date: string, amount: number): void
  /** False when the terms return every purpose, so a charge changes nothing. */
  charge(date: string, amount: number, purpose: 'fees' | 'expenses'): boolean
}

/**
 * What each LP dollar paid for, carried forward from the books' tags (economics.ts
 * `datedContributions`) over the forecast's own calls and charges: a charge uses the oldest capital
 * not yet used, and a charge with none left is paid by the next call. The books tag LP by LP; the
 * forecast's calls and charges are the LPs' totals, so it tags the totals the same way.
 */
function callTagging(p: ConstructionWaterfallProjection): CallTagging {
  const includes = p.capitalIncludes
  if (!includes) {
    const contributions: DatedContribution[] = [...p.contributions]
    return {
      contributions,
      contribute: (date, amount) => { contributions.push({ date, amount }) },
      charge: () => false,
    }
  }
  const tagged: DatedContribution[] = p.contributions.map(c => ({ ...c }))
  const owed: { purpose: 'fees' | 'expenses'; amount: number }[] = []
  const contributions: DatedContribution[] = []
  const refresh = () => {
    contributions.length = 0
    contributions.push(...capitalContributions(tagged, includes).filter(c => c.amount > 0))
  }
  refresh()
  return {
    contributions,
    contribute(date, amount) {
      let left = amount
      while (left > 0.000001 && owed.length > 0) {
        const use = Math.min(left, owed[0].amount)
        tagged.push({ date, amount: roundCents(use), purpose: owed[0].purpose })
        left -= use
        owed[0].amount -= use
        if (owed[0].amount <= 0.000001) owed.shift()
      }
      if (left > 0.000001) tagged.push({ date, amount: roundCents(left), purpose: 'investments' })
      refresh()
    },
    charge(date, amount, purpose) {
      if (!(amount > 0)) return true
      let need = amount
      const unused = tagged
        .filter(c => (c.purpose ?? 'investments') === 'investments' && c.amount > 0 && c.date <= date)
        .sort((a, b) => a.date.localeCompare(b.date))
      for (const u of unused) {
        if (need <= 0.000001) break
        const use = Math.min(need, u.amount)
        u.amount = roundCents(u.amount - use)
        tagged.push({ date: u.date, amount: roundCents(use), purpose })
        need -= use
      }
      if (need > 0.000001) owed.push({ purpose, amount: need })
      refresh()
      return true
    },
  }
}

/**
 * The LPs' dated cash for a carry step measured on their IRR: the contributions and their
 * distributions so far, and what each distribution the forecast runs adds (the state carries it).
 * Nothing when no step measures an IRR.
 */
function irrHistory(p: ConstructionWaterfallProjection, contributions: DatedContribution[]) {
  const on = !!p.carrySteps?.some(s => s.lpIrr != null)
  const booked = (p.distributions ?? []).filter(d => d.amount > 0 && d.date <= p.asOf)
  return (date: string, state: WaterfallState): Partial<WaterfallState> => on
    ? { irr: { asOf: date, contributions: contributions.filter(c => c.date <= date), lpDistributions: state.irr?.lpDistributions ?? booked } }
    : {}
}

/**
 * The warning a forecast shows when the vehicle runs its waterfall per LP. A forecast projects the
 * fund's calls and distributions, not each LP's, so it has no per-LP timing to run the tiers on; it
 * runs them whole fund, which is exact while every LP contributes and receives pro rata.
 */
export const PER_LP_FORECAST_WARNING =
  'The waterfall runs for each LP, but a forecast has no per-LP timing, so it runs the waterfall for the whole fund. That is exact while the LPs contribute and receive pro rata; where their timing differs the actual carry per LP, and its total, can differ.'

/** The warning a forecast shows when deal-by-deal terms run whole fund, for want of the deals. */
export const WHOLE_FUND_FALLBACK_WARNING =
  'The waterfall is deal by deal, but this forecast has no deal-level timing to measure it on, so it runs the waterfall whole fund. The total carry is the same, but deal by deal the GP may be paid some of it earlier than the forecast shows.'
