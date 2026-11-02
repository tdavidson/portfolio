// Splitting a distribution the way the LPA says to — through the waterfall, not pro-rata.
//
// THE BUG THIS REPLACES. Declaring a distribution split the total across every partner by capital
// balance, GP included. That is not a waterfall. Under a European waterfall the first dollar out
// returns LP capital, the next pays the preferred return, then the GP catches up, and only the
// remainder is split at the carry rate. Pro-rata by capital hands the GP a share of every dollar
// from the first one, sized by whatever carry the close happened to have accrued — a number that
// depends on when the last close ran, not on what the partners agreed.
//
// HOW IT WORKS. Replay every prior distribution through the waterfall to find where its tiers
// stand (replay.ts), then run this one from there. Declaring twice on the same books gives the same
// split; a corrected prior distribution corrects every later one. The gap between what the GP has
// actually been paid and what the replay says it should hold is surfaced as a warning, never
// silently corrected.
//
// AMERICAN. Under a deal-by-deal waterfall the capital tier is the LP capital in deals realized so
// far (sold or written off, with their share of fees and expenses), not all contributed capital, so
// the GP is paid carry on a winner once the realized deals are made whole. The caller supplies that
// base as `realizedCapital`; without it an American split falls back to the whole-fund waterfall
// and says so.
//
// PER LP. Terms with `waterfallScope: 'per_lp'` divide the distribution among the carry-bearing LPs
// by contributions first and run each LP's share through its own tiers, each replayed from what that
// LP actually received (lp-groups.ts). The caller supplies the contributions tagged by LP
// (`lpContributions`); without them the split falls back to the whole fund and warns.
//
// CONSISTENCY WITH THE CLOSE. The close accrues carry on a hypothetical liquidation using the same
// `runWaterfall`, with the carry recipients excluded from the LP economics (they receive carry;
// they do not pay it). This split makes the same exclusion, so a distribution and the next close
// agree about what the GP is owed. A recipient entity that has ALSO contributed capital is
// therefore outside the waterfall here exactly as it is there — a warning says so, and the GP can
// edit the lines.

import { runWaterfall, type CarryBand, type WaterfallState } from './waterfall.ts'
import type { DatedContribution, LpDatedContribution } from './hurdle.ts'
import { runsPerLp, type VehicleCarryTerms } from './carry.ts'
import {
  replayWaterfallState,
  usesRealizedBase,
  waterfallTermsOf,
  type PriorDistribution,
  type RealizedCapital,
} from './replay.ts'
import { allocateAmount } from './allocation.ts'
import { groupLpsByTerms, splitAcrossGroups, type LpGroup } from './lp-groups.ts'
import { roundCents } from './ledger.ts'

/** One partner's economics as at the distribution date, from the capital account. */
export interface PartnerEconomics {
  lpEntityId: string
  /** Cumulative capital contributed (positive). */
  contributed: number
  /** Cumulative distributions received (positive). */
  distributed: number
  /** Capital account balance today. */
  ending: number
  /**
   * A carry recipient whose own capital bears carry, as an LP's does: it runs through the LP tiers
   * instead of taking a carry-free slice, and its contributions belong in `contributions`. Rare;
   * ignored for anyone who isn't a recipient, since they bear carry already.
   */
  carryBearing?: boolean
}

export { replayWaterfallState } from './replay.ts'
export type { PriorDistribution, RealizedCapital, ReplayOptions } from './replay.ts'

export type SplitMethod = 'waterfall' | 'pro_rata' | 'manual'

/** What each tier of THIS distribution took. */
export interface WaterfallTiers {
  returnOfCapital: number
  preferred: number
  /** The GP's part of the catch-up tier. */
  catchUp: number
  /** The LPs' part of the catch-up tier (below a full catch-up). Absent on older stored tiers. */
  catchUpToLP?: number
  /** The GP's share of the final split tier. */
  carry: number
  /** The LPs' share of the final split tier. */
  profitToLP: number
  toLP: number
  toGP: number
  /**
   * What the carry recipients' own capital took, pro-rata by capital and outside the tiers (the
   * GP's commitment bears no carry): `carryFreeCapital` of it returns their capital, the rest is
   * their profit. Absent on older stored tiers.
   */
  carryFree?: number
  carryFreeCapital?: number
  /** Each split, and the catch-up at each step, when the carry steps up. `carry` and `profitToLP` are their totals. */
  bands?: CarryBand[]
}

export interface DistributionSplit {
  method: SplitMethod
  /** LP lines — every partner outside the carry recipients (and any recipient that bears carry), pro-rata within the LP tiers. */
  lines: { lpEntityId: string; amount: number }[]
  /** Carry lines — the GP's take, split across the recipients by their percentages. */
  carryLines: { lpEntityId: string; amount: number }[]
  /**
   * The recipients' carry-free shares, which are also in `lines`: what returned their capital and
   * what is their profit. Empty when no recipient has contributed.
   */
  carryFreeLines?: { lpEntityId: string; capital: number; profit: number }[]
  tiers: WaterfallTiers
  /** With LPs on terms of their own: each group's share and tiers. `tiers` is their sum. */
  groups?: { groupId: string; lpEntityIds: string[]; amount: number; tiers: WaterfallTiers }[]
  stateBefore: WaterfallState
  stateAfter: WaterfallState
  warnings: string[]
}

export const ZERO_TIERS: WaterfallTiers = {
  returnOfCapital: 0, preferred: 0, catchUp: 0, catchUpToLP: 0, carry: 0, profitToLP: 0, toLP: 0, toGP: 0,
}

/** Pro-rata across a basis, falling back to equal shares when the basis is empty. */
function share(total: number, basis: { lpEntityId: string; weight: number }[]): { lpEntityId: string; amount: number }[] {
  if (basis.length === 0 || total <= 0) return []
  const positive = basis.filter(b => b.weight > 0)
  const use = positive.length > 0 ? positive : basis.map(b => ({ ...b, weight: 1 }))
  return Array.from(allocateAmount(total, use.map(b => ({ lpEntityId: b.lpEntityId, commitment: b.weight }))).entries())
    .map(([lpEntityId, amount]) => ({ lpEntityId, amount }))
    .filter(l => l.amount > 0)
}

export interface SplitInput {
  total: number
  terms: VehicleCarryTerms
  /** Every partner with a capital account, recipients included — they are separated here. */
  partners: PartnerEconomics[]
  /** Dated LP contributions, for the hurdle. Recipients' contributions excluded, as in the close. */
  contributions: DatedContribution[]
  priors: PriorDistribution[]
  /** The distribution date — the hurdle accrues to here. */
  asOf: string
  /** The GP's carry actually paid to date, for the reconciliation warning. Optional. */
  carryPaidToDate?: number
  /** American only: LP capital in deals realized to date, which is the capital tier. */
  realizedCapital?: RealizedCapital[]
  /**
   * LPs on terms of their own, grouped by `groupLpsByTerms` (lp-groups.ts). Given, each group
   * runs its own tiers on its share, and `contributions` and `realizedCapital` are read from the
   * groups instead. Omitted, every LP is on `terms`.
   */
  groups?: LpGroup[]
  /**
   * The contributions tagged by LP (distributionSplitInputs with `perLp`). With terms that run the
   * waterfall per LP (`waterfallScope: 'per_lp'`), each carry-bearing LP becomes its own group, the
   * amount is divided by contributions, and each LP's tiers are replayed from what it received
   * (`PriorDistribution.paidToLp`).
   */
  lpContributions?: LpDatedContribution[]
}

function tiersOf(result: ReturnType<typeof runWaterfall>): WaterfallTiers {
  return {
    returnOfCapital: result.toReturnOfCapital,
    preferred: result.toPreferred,
    catchUp: result.toCatchUp,
    catchUpToLP: result.toCatchUpLP,
    carry: result.toCarryGP,
    profitToLP: result.toCarryLP,
    toLP: result.toLP,
    toGP: result.toGP,
    ...(result.bands ? { bands: result.bands } : {}),
  }
}

// The groups' states summed. The profit and split totals are kept when either side has them, each
// read with its own default (lpProfitPaid: the pref paid; splitPaid: 0), so a grouped total with a
// step or a profit-measured catch-up is right.
const addStates = (a: WaterfallState, b: WaterfallState): WaterfallState => ({
  contributedCapital: roundCents(a.contributedCapital + b.contributedCapital),
  returnedCapital: roundCents(a.returnedCapital + b.returnedCapital),
  preferredPaid: roundCents(a.preferredPaid + b.preferredPaid),
  preferredTarget: roundCents(a.preferredTarget + b.preferredTarget),
  gpCarryPaid: roundCents(a.gpCarryPaid + b.gpCarryPaid),
  gpCatchUpPaid: roundCents((a.gpCatchUpPaid ?? a.gpCarryPaid) + (b.gpCatchUpPaid ?? b.gpCarryPaid)),
  ...(a.lpProfitPaid != null || b.lpProfitPaid != null
    ? { lpProfitPaid: roundCents((a.lpProfitPaid ?? a.preferredPaid) + (b.lpProfitPaid ?? b.preferredPaid)) }
    : {}),
  ...(a.splitPaid != null || b.splitPaid != null ? { splitPaid: roundCents((a.splitPaid ?? 0) + (b.splitPaid ?? 0)) } : {}),
})

/**
 * Split a distribution total into LP lines and carry lines.
 *
 * With no carry terms this degrades to the old behaviour — pro-rata by capital balance across
 * every partner, method 'pro_rata' — so a vehicle that never set terms is unchanged.
 */
export function splitDistribution(input: SplitInput): DistributionSplit {
  const total = roundCents(input.total)
  const { terms } = input
  const warnings: string[] = []

  const recipientIds = new Set(terms.recipients.map(r => r.lpEntityId))
  // A zero carry rate still runs the tiers, so the split says what came back as capital.
  const noCarry = terms.kind === 'none' || (terms.carryRate > 0 && terms.recipients.length === 0)

  if (noCarry) {
    if (terms.kind !== 'none' && terms.carryRate > 0 && terms.recipients.length === 0) {
      warnings.push('Carry terms are set but no recipient is named, so the distribution is split pro-rata by capital balance with no carry.')
    }
    const lines = share(total, input.partners.map(p => ({ lpEntityId: p.lpEntityId, weight: Math.max(0, p.ending) })))
    const empty: WaterfallState = { contributedCapital: 0, returnedCapital: 0, preferredPaid: 0, preferredTarget: 0, gpCarryPaid: 0, gpCatchUpPaid: 0 }
    return {
      method: 'pro_rata',
      lines,
      carryLines: [],
      tiers: { ...ZERO_TIERS, toLP: total },
      stateBefore: empty,
      stateAfter: empty,
      warnings,
    }
  }

  const lps = input.partners.filter(p => !recipientIds.has(p.lpEntityId) || p.carryBearing)

  // THE GP'S OWN CAPITAL. A carry recipient that has contributed (the GP's commitment) bears no
  // carry, as the close assumes, so it takes its pro-rata share of the distribution by capital
  // outside the tiers: its capital back first, then its profit. The tiers divide the rest.
  // A recipient marked carryBearing is an LP here instead.
  const carryFree = input.partners.filter(p => recipientIds.has(p.lpEntityId) && !p.carryBearing && p.contributed > 0)
  const slices = new Map<string, { capital: number; profit: number }>()
  if (carryFree.length > 0) {
    const byCapital = allocateAmount(total, input.partners.map(p => ({ lpEntityId: p.lpEntityId, commitment: Math.max(0, p.contributed) })))
    for (const p of carryFree) {
      const slice = byCapital.get(p.lpEntityId) ?? 0
      // Carry is not in `distributed` (it's on the carried-interest line), so this is its own capital.
      const returned = Math.max(0, Math.min(p.contributed, p.distributed))
      const capital = roundCents(Math.min(slice, Math.max(0, p.contributed - returned)))
      slices.set(p.lpEntityId, { capital, profit: roundCents(slice - capital) })
    }
  }
  const sliced = roundCents([...slices.values()].reduce((s, v) => s + v.capital + v.profit, 0))
  const pool = roundCents(total - sliced)

  const opts = { realizedCapital: input.realizedCapital }
  if (terms.kind === 'american' && !usesRealizedBase(terms, opts)) {
    warnings.push('These are American (deal-by-deal) terms, but no realized deals were supplied, so the distribution is split by the whole-fund waterfall.')
  } else if (terms.kind === 'american' && !input.realizedCapital!.some(c => c.realizedOn <= input.asOf && c.amount > 0)) {
    warnings.push('No deal has been realized yet, so under the deal-by-deal waterfall none of this distribution is a return of capital. If it returns capital that was never invested, split it pro-rata instead.')
  }
  // LP tiers: capital comes back in proportion to what each partner put in; the preferred return
  // and the profit share follow the same basis, because both are earned on contributed capital.
  // A partner with no contributions (a transferee whose capital arrived as a transfer) falls back
  // to capital balance so they are not skipped.
  const basisOf = (members: PartnerEconomics[]) => {
    const contributed = members.map(p => ({ lpEntityId: p.lpEntityId, weight: Math.max(0, p.contributed) }))
    return contributed.some(b => b.weight > 0) ? contributed : members.map(p => ({ lpEntityId: p.lpEntityId, weight: Math.max(0, p.ending) }))
  }
  const carryFreeTiers = sliced > 0 ? { carryFree: sliced, carryFreeCapital: roundCents([...slices.values()].reduce((s, v) => s + v.capital, 0)) } : {}

  let tiers: WaterfallTiers
  let stateBefore: WaterfallState
  let stateAfter: WaterfallState
  let lines: { lpEntityId: string; amount: number }[]
  let groups: DistributionSplit['groups']
  // A waterfall per LP: each carry-bearing LP is a group on the fund's terms, divided by contributions.
  const perLp = runsPerLp(terms)
  let lpGroups = input.groups
  if (perLp && !(lpGroups && lpGroups.length > 0)) {
    if (input.lpContributions) {
      lpGroups = groupLpsByTerms({ fundTerms: terms, lpEntityIds: lps.map(p => p.lpEntityId), contributions: input.lpContributions, perLp: true })
    } else {
      warnings.push('The terms run the waterfall per LP, but contributions were not given per LP, so the distribution is split by the whole-fund waterfall.')
    }
  }
  if (lpGroups && lpGroups.length > 0) {
    // Each group runs its own tiers on its share (lp-groups.ts).
    const splits = splitAcrossGroups(pool, input.priors, lpGroups, input.asOf, perLp ? { division: 'contributions', warnings } : undefined)
    groups = splits.map(s => ({ groupId: s.group.id, lpEntityIds: s.group.lpEntityIds, amount: s.amount, tiers: tiersOf(s.result) }))
    const sumOf = (k: 'returnOfCapital' | 'preferred' | 'catchUp' | 'carry' | 'profitToLP' | 'toLP' | 'toGP') =>
      roundCents(groups!.reduce((s, g) => s + g.tiers[k], 0))
    tiers = {
      returnOfCapital: sumOf('returnOfCapital'),
      preferred: sumOf('preferred'),
      catchUp: sumOf('catchUp'),
      catchUpToLP: roundCents(groups.reduce((s, g) => s + (g.tiers.catchUpToLP ?? 0), 0)),
      carry: sumOf('carry'),
      profitToLP: sumOf('profitToLP'),
      toLP: sumOf('toLP'),
      toGP: sumOf('toGP'),
      ...(groups.length === 1 && groups[0].tiers.bands ? { bands: groups[0].tiers.bands } : {}),
      ...carryFreeTiers,
    }
    const zero: WaterfallState = { contributedCapital: 0, returnedCapital: 0, preferredPaid: 0, preferredTarget: 0, gpCarryPaid: 0, gpCatchUpPaid: 0 }
    stateBefore = splits.reduce((s, g) => addStates(s, g.stateBefore), zero)
    stateAfter = splits.reduce((s, g) => addStates(s, g.result.state), zero)
    lines = splits.flatMap((s, k) => {
      const members = new Set(s.group.lpEntityIds)
      return share(groups![k].tiers.toLP, basisOf(lps.filter(p => members.has(p.lpEntityId))))
    })
  } else {
    stateBefore = replayWaterfallState(input.priors, input.contributions, terms, input.asOf, opts)
    const result = runWaterfall(pool, waterfallTermsOf(terms), stateBefore)
    tiers = { ...tiersOf(result), ...carryFreeTiers }
    stateAfter = result.state
    lines = share(tiers.toLP, basisOf(lps))
  }
  for (const [lpEntityId, v] of slices) {
    const amount = roundCents(v.capital + v.profit)
    if (amount > 0) lines.push({ lpEntityId, amount })
  }

  // The GP's take, split across the recipients by percentage; the last absorbs the rounding
  // cent so the carry lines always tie to `toGP`.
  const carryLines: { lpEntityId: string; amount: number }[] = []
  if (tiers.toGP > 0) {
    let allocated = 0
    terms.recipients.forEach((r, i) => {
      const amt = i === terms.recipients.length - 1
        ? roundCents(tiers.toGP - allocated)
        : roundCents((tiers.toGP * r.pct) / 100)
      allocated = roundCents(allocated + amt)
      if (amt > 0) carryLines.push({ lpEntityId: r.lpEntityId, amount: amt })
    })
  }

  if (input.carryPaidToDate != null && Math.abs(input.carryPaidToDate - stateBefore.gpCarryPaid) > 0.01) {
    warnings.push(
      `The waterfall implies ${stateBefore.gpCarryPaid.toFixed(2)} of carry paid to date from prior distributions, ` +
      `but the books show ${input.carryPaidToDate.toFixed(2)}. Earlier distributions were split differently; review before declaring.`,
    )
  }

  return {
    method: 'waterfall',
    lines,
    carryLines,
    ...(sliced > 0 ? { carryFreeLines: [...slices].map(([lpEntityId, v]) => ({ lpEntityId, ...v })).filter(l => l.capital + l.profit > 0) } : {}),
    tiers,
    ...(groups ? { groups } : {}),
    stateBefore,
    stateAfter,
    warnings,
  }
}

/**
 * The tax character the waterfall suggests: what came back as capital is return of capital, and
 * everything else is gain. Income cannot be told apart here — the close knows what the fund
 * earned, a distribution only knows what it paid — so it is left for the GP to move.
 */
export function suggestedCharacter(tiers: WaterfallTiers, total: number): { returnOfCapital: number; realizedGain: number; income: number } {
  const roc = roundCents(Math.min(tiers.returnOfCapital + (tiers.carryFreeCapital ?? 0), total))
  return { returnOfCapital: roc, realizedGain: roundCents(total - roc), income: 0 }
}
