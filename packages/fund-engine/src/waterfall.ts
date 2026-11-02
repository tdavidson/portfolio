// Carried-interest waterfall (European / whole-fund).
//
// A distribution flows through tiers in order:
//   1. Return of capital — to LPs until cumulative distributions = contributed capital
//   2. Preferred return  — to LPs until the accrued hurdle (preferredTarget) is met
//   3. GP catch-up       — catchUpRate of the flow to the GP, the rest to LPs, until the GP's
//                          catch-up reaches catchUpSize of a full catch-up
//   4. Carry split       — remainder split carryRate to GP, the rest to LPs
//
// A catch-up is two terms. Its SIZE is how much of a full catch-up the GP gets, where a full one is
// the carry the GP would have earned on the profit that paid the pref: enough that the GP holds
// carryRate of (preferred + catch-up), i.e. carryRate / (1 − carryRate) of the pref. Its RATE is the
// share of each dollar that goes to the GP while it catches up; the LPs get the rest. Any rate
// works: at 10% on 20% carry the GP takes 10% of the flow until it has its catch-up.
//
// LPAs measure a catch-up in one of two ways, and they part when the LPs share the catch-up flow.
// 'preferred' (the default, and the reading above) gives the GP carryRate / (1 − carryRate) of the
// pref paid however much of the flow went to the LPs. 'profit' runs the catch-up until the GP holds
// its target share of all the profit distributed so far ("until the GP has received 20% of the
// amounts distributed under (ii) and (iii)"), so the LPs' part of the flow counts too, and the GP
// reaches its full share.
//
// CARRY THAT STEPS UP. Some LPAs raise the carry once the LPs are well ahead: 20% until the LPs
// have 2x their capital (or a 15% IRR), then 25%. `steps` lists each step. The split before it
// runs until the LPs reach the step's multiple of capital or IRR, an optional catch-up then brings
// the GP to its new share of all profit, and the next split runs at the new rate. This is the Walter
// spec's reading (spec/04-distributions.md): a multiple step ends when the LPs' total received is
// m × capital, an IRR step when what they've received, compounded at the IRR to the distribution
// date, covers their contributions compounded the same way. A step's catch-up can instead be
// measured on the splits alone (`catchUpMeasure: 'split'`): the GP is owed its new rate of what the
// splits have paid, the way the first catch-up's 'preferred' measure is owed a share of the pref.
//
// This is a pure function of a distributable amount and the cumulative state, so
// it's fully testable and can be replayed. Hurdle ACCRUAL (how preferredTarget
// grows over time) is supplied by the caller, keeping timing out of the waterfall.

export interface WaterfallTerms {
  /** GP carry share of profits, e.g. 0.20. */
  carryRate: number
  /** The GP's share of each dollar during the catch-up; 1.0 = all of it. */
  catchUpRate?: number
  /** How much of a full catch-up the GP gets, 0–1. Absent means 1, a full catch-up. */
  catchUpSize?: number
  /** What the catch-up is measured on (see above). Absent means 'preferred'. */
  catchUpMeasure?: 'preferred' | 'profit'
  /** Where the carry steps up, in order (see above). Absent or empty: one carry rate. */
  steps?: CarryStep[]
}

/** One step up in the carry: where the split before it ends, and what follows. */
export interface CarryStep {
  /** The split before the step ends when the LPs have received this multiple of their capital… */
  lpMultiple?: number
  /** …or when they reach this IRR (ACT/365, annual compounding). */
  lpIrr?: number
  /** The carry rate after the step. */
  carryRate: number
  /** A catch-up at the step: the GP's share of each dollar. Absent: none. */
  catchUpRate?: number
  /** The GP's share the catch-up runs to. Absent: `carryRate`. */
  catchUpTarget?: number
  /**
   * What the step's catch-up is measured on. 'profit' (the default): the GP catches up until it
   * holds the target share of ALL profit, the pref and the first catch-up included. 'split': the GP
   * is owed the target share of what the carry splits have paid (both sides), less the carry it has
   * had from them and from earlier step catch-ups: an LPA that sizes the step's catch-up by the split
   * tier before it, the way the first catch-up's 'preferred' measure is sized by the pref tier. The
   * pref and the first catch-up are left out, and what the LPs get of the catch-up flow doesn't count
   * toward it.
   */
  catchUpMeasure?: 'profit' | 'split'
}

/** What one split (and the catch-up before it) took. The first band is the split after the first catch-up. */
export interface CarryBand {
  carryRate: number
  catchUp: number
  catchUpToLP: number
  toLP: number
  toGP: number
}

/** The LPs' dated cash, which an IRR step measures. Kept on the state only when a step needs it. */
export interface IrrHistory {
  /** The distribution date the IRR is measured to. */
  asOf: string
  /** The carry-bearing contributions. */
  contributions: { date: string; amount: number }[]
  /** What the LPs have received from earlier distributions, dated. */
  lpDistributions: { date: string; amount: number }[]
}

export interface WaterfallState {
  /** Total LP capital contributed — the return-of-capital target. */
  contributedCapital: number
  /** Distributions already returned to LPs as return of capital. */
  returnedCapital: number
  /** Preferred already paid to LPs. */
  preferredPaid: number
  /** Total preferred owed to date (accrued hurdle) — supplied by the caller. */
  preferredTarget: number
  /** Carry already paid to the GP. */
  gpCarryPaid: number
  /**
   * The GP's catch-up paid so far. Absent means all of `gpCarryPaid`, which is exact for a state
   * that has never reached the split.
   */
  gpCatchUpPaid?: number
  /**
   * The LPs' profit paid so far: everything after return of capital. Absent means `preferredPaid`,
   * exact for a state that has never reached the catch-up. A 'profit' catch-up measures on it.
   */
  lpProfitPaid?: number
  /**
   * Everything the carry splits have paid so far, LPs and GP together, step catch-ups left out.
   * Kept only when the carry steps up; a 'split' step catch-up measures on it. Absent means 0,
   * exact for a state that has never reached the split.
   */
  splitPaid?: number
  /** The LPs' dated cash, for an IRR step. Without it an IRR step never ends its split. */
  irr?: IrrHistory
}

export interface WaterfallResult {
  toReturnOfCapital: number
  toPreferred: number
  /** The GP's part of the catch-up flow. */
  toCatchUp: number
  /** The LPs' part of the catch-up flow: 1 − catchUpRate of it. 0 for a full catch-up. */
  toCatchUpLP: number
  /** The LPs' part of every split, and of any catch-up at a step. */
  toCarryLP: number
  /** The GP's part of every split, and of any catch-up at a step. */
  toCarryGP: number
  /** Each split and the catch-up before it, when the carry steps up. Absent with one rate. */
  bands?: CarryBand[]
  toLP: number
  toGP: number
  state: WaterfallState
}

/** ACT/365 years from one date to another (YYYY-MM-DD). */
function yearsBetween(from: string, to: string): number {
  return (Date.parse(to) - Date.parse(from)) / (365 * 24 * 60 * 60 * 1000)
}

function r(n: number): number {
  return Math.round((n + Number.EPSILON) * 100) / 100
}

/** Run one distribution of `distributable` through the waterfall. */
export function runWaterfall(
  distributable: number,
  terms: WaterfallTerms,
  state: WaterfallState
): WaterfallResult {
  const carry = terms.carryRate
  const catchUpRate = terms.catchUpRate ?? 1.0
  let remaining = r(Math.max(0, distributable))

  const take = (want: number): number => {
    const amt = r(Math.max(0, Math.min(remaining, want)))
    remaining = r(remaining - amt)
    return amt
  }

  // 1. Return of capital
  const toReturnOfCapital = take(state.contributedCapital - state.returnedCapital)

  // 2. Preferred return
  const toPreferred = take(state.preferredTarget - state.preferredPaid)

  // 3. GP catch-up: the GP's catch-up totals catchUpSize × c·P'/(1 − c) (a full one leaves it holding
  //    c of pref + catch-up). Of each dollar in this tier it takes catchUpRate and the LPs the rest.
  //    Measured on the GP's catch-up so far, so a later step in the hurdle is caught up in turn.
  const prefAfter = r(state.preferredPaid + toPreferred)
  const gpCatchUpBefore = state.gpCatchUpPaid ?? state.gpCarryPaid
  const size = Math.min(1, Math.max(0, terms.catchUpSize ?? 1))
  let toCatchUp = 0
  let toCatchUpLP = 0
  if (terms.catchUpMeasure === 'profit' && carry > 0 && carry < 1 && catchUpRate > 0 && size > 0) {
    // The target share t that the size stands for: t / (1 − t) = size × c / (1 − c).
    const x = (size * carry) / (1 - carry)
    const target = x / (1 + x)
    if (catchUpRate > target) {
      const profit = r((state.lpProfitPaid ?? state.preferredPaid) + toPreferred + state.gpCarryPaid)
      const want = r(Math.max(0, (target * profit - state.gpCarryPaid) / (catchUpRate - target)))
      const gross = take(want)
      // A completed catch-up lands the GP on its share to the cent, as the preferred measure does.
      toCatchUp = gross === want ? r(Math.max(0, target * (profit + gross) - state.gpCarryPaid)) : r(gross * catchUpRate)
      toCatchUpLP = r(gross - toCatchUp)
    }
  } else if (carry > 0 && carry < 1 && catchUpRate > 0 && size > 0) {
    const gpNeeded = r(Math.max(0, (size * carry * prefAfter) / (1 - carry) - gpCatchUpBefore))
    if (gpNeeded > 0) {
      // Round the GP's catch-up, not the gross flow, so a completed catch-up lands to the cent;
      // the LPs' part is what is left of the flow.
      const want = r(gpNeeded / catchUpRate)
      const gross = take(want)
      toCatchUp = gross === want ? gpNeeded : r(gross * catchUpRate)
      toCatchUpLP = r(gross - toCatchUp)
    }
  }

  // 4. The split, or the splits when the carry steps up, on the remainder.
  const steps = terms.steps ?? []
  let toCarryGP = 0
  let toCarryLP = 0
  let bands: CarryBand[] | undefined
  let splitAfter: number | undefined
  if (steps.length === 0) {
    toCarryGP = r(remaining * carry)
    toCarryLP = r(remaining - toCarryGP)
    remaining = 0
  } else {
    bands = []
    const lpBefore = r(state.returnedCapital + (state.lpProfitPaid ?? state.preferredPaid))
    let lp = r(lpBefore + toReturnOfCapital + toPreferred + toCatchUpLP)
    let gp = r(state.gpCarryPaid + toCatchUp)
    const returned = r(state.returnedCapital + toReturnOfCapital)
    // The GP's first catch-up, which a 'split' step catch-up leaves out of the GP's side.
    const firstCatchUp = r(gpCatchUpBefore + toCatchUp)
    let split = r(state.splitPaid ?? 0)
    // What the LPs still need to reach `rate`, in today's dollars (spec 04 §3).
    const irrShortfall = (rate: number): number => {
      const h = state.irr
      if (!h) return Infinity
      const grow = (date: string, amount: number) => amount * Math.pow(1 + rate, yearsBetween(date, h.asOf))
      const owed = h.contributions.reduce((s, c) => s + grow(c.date, c.amount), 0)
      const paid = h.lpDistributions.reduce((s, d) => s + grow(d.date, d.amount), 0) + (lp - lpBefore)
      return Math.max(0, owed - paid)
    }
    for (let j = 0; j <= steps.length; j++) {
      const rate = j === 0 ? carry : steps[j - 1].carryRate
      let cuGP = 0
      let cuLP = 0
      const at = j > 0 ? steps[j - 1] : undefined
      if (at?.catchUpRate != null && at.catchUpRate > 0) {
        const k = at.catchUpRate
        const t = at.catchUpTarget ?? rate
        if (at.catchUpMeasure === 'split') {
          // Owed t of what the splits have paid, less the GP's carry outside the first catch-up.
          const owed = r(Math.max(0, t * split - (gp - firstCatchUp)))
          if (owed > 0) {
            const want = r(owed / k)
            const gross = take(want)
            cuGP = gross === want ? owed : r(gross * k)
            cuLP = r(gross - cuGP)
            lp = r(lp + cuLP)
            gp = r(gp + cuGP)
          }
        } else if (k > t) {
          const profit = r(lp - returned + gp)
          const want = r(Math.max(0, (t * profit - gp) / (k - t)))
          const gross = take(want)
          cuGP = gross === want ? r(Math.max(0, t * (profit + gross) - gp)) : r(gross * k)
          cuLP = r(gross - cuGP)
          lp = r(lp + cuLP)
          gp = r(gp + cuGP)
        }
      }
      const end = steps[j]
      let want = remaining
      if (end?.lpMultiple != null) want = Math.max(0, (end.lpMultiple * state.contributedCapital - lp) / (1 - rate))
      else if (end?.lpIrr != null) want = irrShortfall(end.lpIrr) / (1 - rate)
      const gross = take(want)
      const toGPHere = r(gross * rate)
      const toLPHere = r(gross - toGPHere)
      lp = r(lp + toLPHere)
      gp = r(gp + toGPHere)
      split = r(split + gross)
      bands.push({ carryRate: rate, catchUp: cuGP, catchUpToLP: cuLP, toLP: toLPHere, toGP: toGPHere })
      toCarryGP = r(toCarryGP + cuGP + toGPHere)
      toCarryLP = r(toCarryLP + cuLP + toLPHere)
    }
    remaining = 0
    splitAfter = split
  }

  const toLP = r(toReturnOfCapital + toPreferred + toCatchUpLP + toCarryLP)
  const toGP = r(toCatchUp + toCarryGP)

  const newState: WaterfallState = {
    contributedCapital: state.contributedCapital,
    returnedCapital: r(state.returnedCapital + toReturnOfCapital),
    preferredPaid: prefAfter,
    preferredTarget: state.preferredTarget,
    gpCarryPaid: r(state.gpCarryPaid + toGP),
    gpCatchUpPaid: r(gpCatchUpBefore + toCatchUp),
    // Kept only where a profit catch-up or a step reads it, so a state for the usual terms is unchanged.
    ...(terms.catchUpMeasure === 'profit' || steps.length > 0 || state.lpProfitPaid != null
      ? { lpProfitPaid: r((state.lpProfitPaid ?? state.preferredPaid) + toPreferred + toCatchUpLP + toCarryLP) }
      : {}),
    ...(splitAfter != null ? { splitPaid: splitAfter } : {}),
    ...(state.irr
      ? { irr: { ...state.irr, lpDistributions: toLP > 0 ? [...state.irr.lpDistributions, { date: state.irr.asOf, amount: toLP }] : state.irr.lpDistributions } }
      : {}),
  }

  return { toReturnOfCapital, toPreferred, toCatchUp, toCatchUpLP, toCarryLP, toCarryGP, ...(bands ? { bands } : {}), toLP, toGP, state: newState }
}
