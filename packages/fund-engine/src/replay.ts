// Where the waterfall's tiers stand on a date: replay every prior distribution through it.
//
// `runWaterfall` (waterfall.ts) is pure over a cumulative STATE — capital returned so far, preferred
// paid so far, carry paid so far. Nothing stores that state, and it should not be stored: it is a
// function of the distributions that came before. So we REPLAY them. Every prior distribution total,
// in date order, runs through the waterfall with the preferred return accrued to that date, and the
// state it leaves behind is where the next one starts.
//
// The replay is over TOTALS, not over who received what. The LPA defines the tiers on cumulative
// amounts, so the tier state is what the agreement implies given the money that has left the fund.
//
// Two term choices change what the replay measures against:
//   - prefBase 'unreturned': the hurdle stops accruing on capital the replay has returned and on
//     preferred it has paid (hurdle.ts), so each step feeds the next one's hurdle.
//   - kind 'american' with `realizedCapital`: the capital tier covers only capital in deals that
//     have been realized (sold or written off) by that date, plus their share of fees and expenses,
//     and the hurdle accrues only on that capital. That is the deal-by-deal waterfall: carry is
//     paid on a winner once the LPs have their money back on every deal realized so far, losers
//     included — not once the whole fund is returned.

import { runWaterfall, type WaterfallState, type WaterfallTerms } from './waterfall.ts'
import { capitalContributions, hurdleTarget, type DatedContribution, type HurdleReduction } from './hurdle.ts'
import { roundCents } from './ledger.ts'
import type { VehicleCarryTerms } from './carry.ts'

/** A prior distribution — the fund-wide total that left on that date, carry included. */
export interface PriorDistribution {
  date: string
  amount: number
  /**
   * Part of it paid straight back to these LPs, outside the tiers' division: recycling deemed
   * recontributed. Only the grouped waterfall reads it (lp-groups.ts); one group runs it as capital.
   */
  byLp?: Record<string, number>
}

/**
 * LP capital that joins an American waterfall's capital tier when its deal is realized.
 *
 * `date` is when the capital went in (the hurdle accrues from there); `realizedOn` is when the
 * deal was sold or written off (the capital is owed back from there). One deal can contribute
 * several entries: one per investment, scaled to the cost a realization took out.
 */
export interface RealizedCapital {
  companyId?: string
  date: string
  realizedOn: string
  amount: number
}

export interface ReplayOptions {
  /** The American capital base. Ignored unless `terms.kind` is 'american'. */
  realizedCapital?: RealizedCapital[]
}

export function waterfallTermsOf(terms: VehicleCarryTerms): WaterfallTerms {
  // 'straight' is the waterfall with no hurdle: return of capital, then the split. Setting the
  // preferred target to zero makes the catch-up tier vanish on its own (there is nothing to catch
  // up to), which is exactly the straight definition.
  return {
    carryRate: terms.carryRate,
    catchUpRate: terms.kind === 'straight' ? 1 : terms.catchupRate,
    catchUpSize: terms.catchupSize ?? 1,
    ...(terms.catchupMeasure === 'profit' ? { catchUpMeasure: 'profit' as const } : {}),
    ...(terms.carrySteps && terms.carrySteps.length > 0 ? { steps: terms.carrySteps } : {}),
  }
}

/** Whether a step in the carry is measured on the LPs' IRR, so the replay must keep their dated cash. */
function measuresIrr(terms: VehicleCarryTerms): boolean {
  return !!terms.carrySteps?.some(s => s.lpIrr != null)
}

/** Whether the replay measures an American (realized-deals) capital base. */
export function usesRealizedBase(terms: VehicleCarryTerms, opts?: ReplayOptions): boolean {
  return terms.kind === 'american' && Array.isArray(opts?.realizedCapital)
}

/**
 * Replay every prior distribution through the waterfall to find where the tiers stand at `asOf`.
 *
 * `contributions` are the LPs' dated contributions: capital to be returned once it has arrived,
 * and the hurdle's base. Each prior runs with the preferred return accrued to ITS date, so a
 * distribution made before the hurdle had accrued much correctly went mostly to capital.
 */
export function replayWaterfallState(
  priors: PriorDistribution[],
  contributions: DatedContribution[],
  terms: VehicleCarryTerms,
  asOf: string,
  opts?: ReplayOptions,
): WaterfallState {
  const realized = usesRealizedBase(terms, opts)
  const capital = capitalContributions(contributions, terms.capitalIncludes)
  const contributedAsOf = (date: string) => capital.filter(c => c.date <= date && c.amount > 0)
  const capitalAsOf = (date: string): DatedContribution[] => realized
    ? opts!.realizedCapital!.filter(c => c.realizedOn <= date && c.amount > 0).map(c => ({ date: c.date, amount: c.amount }))
    : contributedAsOf(date)
  const total = (cs: DatedContribution[]) => roundCents(cs.reduce((s, c) => s + c.amount, 0))
  // The realized base never owes back more capital than the LPs have actually put in.
  const capitalTotal = (date: string) => realized
    ? Math.min(total(capitalAsOf(date)), total(contributedAsOf(date)))
    : total(capitalAsOf(date))

  const unreturned = terms.prefBase === 'unreturned'
  const reductions: HurdleReduction[] = []
  const target = (date: string): number => {
    if (terms.kind === 'straight') return 0
    return hurdleTarget(terms, capitalAsOf(date), capitalTotal(date), date, unreturned ? reductions : undefined)
  }

  let state: WaterfallState = {
    contributedCapital: 0,
    returnedCapital: 0,
    preferredPaid: 0,
    preferredTarget: 0,
    gpCarryPaid: 0,
    gpCatchUpPaid: 0,
  }
  const sorted = [...priors].filter(p => p.amount > 0 && p.date <= asOf).sort((a, b) => a.date.localeCompare(b.date))
  const irr = measuresIrr(terms)
  const irrAt = (date: string) => irr
    ? { irr: { asOf: date, contributions: capitalAsOf(date), lpDistributions: state.irr?.lpDistributions ?? [] } }
    : {}
  for (const p of sorted) {
    state = { ...state, contributedCapital: capitalTotal(p.date), preferredTarget: target(p.date), ...irrAt(p.date) }
    const step = runWaterfall(p.amount, waterfallTermsOf(terms), state)
    reductions.push({ date: p.date, capital: step.toReturnOfCapital, preferred: step.toPreferred })
    state = step.state
  }
  return { ...state, contributedCapital: capitalTotal(asOf), preferredTarget: target(asOf), ...irrAt(asOf) }
}

/**
 * The GP's carry on the fund-end view, which is what a clawback measures the carry paid against.
 *
 * Return of capital owes only capital called so far, so an early exit can pay the GP carry the
 * fund's life doesn't support: the capital called later, and its pref, still had to come back
 * first. The fund-end view replays every distribution with return of capital owing all the capital
 * contributed to `asOf` from the first one, whole fund (a liquidation realizes every deal). The
 * pref still accrues on each contribution from its own date.
 */
export function fundEndEntitlement(
  priors: PriorDistribution[],
  contributions: DatedContribution[],
  terms: VehicleCarryTerms,
  asOf: string,
): number {
  const lifetime = capitalContributions(contributions, terms.capitalIncludes).filter(c => c.date <= asOf && c.amount > 0)
  const owed = roundCents(lifetime.reduce((s, c) => s + c.amount, 0))
  const unreturned = terms.prefBase === 'unreturned'
  const reductions: HurdleReduction[] = []
  const target = (date: string): number => terms.kind === 'straight'
    ? 0
    : hurdleTarget(terms, lifetime, owed, date, unreturned ? reductions : undefined)
  let state: WaterfallState = { contributedCapital: owed, returnedCapital: 0, preferredPaid: 0, preferredTarget: 0, gpCarryPaid: 0, gpCatchUpPaid: 0 }
  const sorted = [...priors].filter(p => p.amount > 0 && p.date <= asOf).sort((a, b) => a.date.localeCompare(b.date))
  const irr = measuresIrr(terms)
  for (const p of sorted) {
    const at = irr ? { irr: { asOf: p.date, contributions: lifetime.filter(c => c.date <= p.date), lpDistributions: state.irr?.lpDistributions ?? [] } } : {}
    const step = runWaterfall(p.amount, waterfallTermsOf(terms), { ...state, preferredTarget: target(p.date), ...at })
    reductions.push({ date: p.date, capital: step.toReturnOfCapital, preferred: step.toPreferred })
    state = step.state
  }
  return state.gpCarryPaid
}

/** What the GP gives back at the end of the fund: carry paid beyond the fund-end entitlement. */
export function clawbackAtFundEnd(
  priors: PriorDistribution[],
  contributions: DatedContribution[],
  terms: VehicleCarryTerms,
  asOf: string,
  carryPaid: number,
): { paid: number; entitlement: number; amount: number; cap?: number } {
  const entitlement = terms.kind === 'none' || terms.carryRate <= 0 ? 0 : fundEndEntitlement(priors, contributions, terms, asOf)
  const cap = netOfTaxCap(carryPaid, terms.clawbackNetOfTaxRate)
  const owed = roundCents(Math.max(0, carryPaid - entitlement))
  return { paid: roundCents(carryPaid), entitlement, amount: cap === undefined ? owed : Math.min(cap, owed), ...(cap === undefined ? {} : { cap }) }
}

/** The carry paid less tax at the assumed rate, half to even to the cent; undefined without a rate. */
export function netOfTaxCap(carryPaid: number, rate: number | undefined): number | undefined {
  if (rate === undefined) return undefined
  const c = carryPaid * (1 - rate) * 100
  const f = Math.floor(c)
  const cents = Math.abs(c - f - 0.5) < 1e-7 ? (f % 2 === 0 ? f : f + 1) : Math.round(c)
  return cents / 100
}

