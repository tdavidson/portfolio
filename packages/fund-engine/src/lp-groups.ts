// LPs on terms of their own: the waterfall across groups of LPs.
//
// The books know every LP, so terms can be set per LP: an anchor at a lower carry, a side letter
// with no pref, a first-loss LP that takes losses before everyone else. LPs on identical terms
// form a group (`groupLpsByTerms`), and each group runs the fund's waterfall on its own terms, its
// own capital and its own share of the cash. With every LP on the fund's terms there is one group
// and this is the fund's waterfall, unchanged. It's the Walter spec's reading of LP classes
// (spec/11-lp-classes.md).
//
// HOW CASH IS SHARED. Every distribution to the carry-bearing LPs is divided before any group's
// tiers see it:
//   1. Return of capital, senior first. The senior groups (every group that isn't subordinated)
//      are paid what their capital tier owes, each in proportion to what it's owed when the cash
//      is short. Whatever is left pays the subordinated groups the same way.
//   2. Everything after goes to the groups pro rata by capital, and each runs its own tiers on it.
// A group's share then runs through `runWaterfall` from the group's own state. Since return of
// capital is the first tier, one run on the whole share is the same as the two stages run apart.
//
// Recycling deemed recontributed is paid straight back to the LPs who recontributed it
// (`PriorDistribution.byLp`), as the single-group replay already treats it.
//
// STATE IS REPLAYED, as in replay.ts: nothing stores a group's tier state, and every prior
// distribution is divided and run again. The fund-end view (what a clawback measures against)
// runs the same division with each group owed all its capital from the first distribution, and
// the clawback is netted across the groups: the GP returns its total carry less its total
// entitlement, and each group that was overpaid gets back its share of the excess.

import { runWaterfall, type WaterfallResult, type WaterfallState } from './waterfall.ts'
import { capitalContributions, hurdleTarget, type DatedContribution, type HurdleReduction } from './hurdle.ts'
import { roundCents } from './ledger.ts'
import type { VehicleCarryTerms } from './carry.ts'
import { netOfTaxCap, waterfallTermsOf, type PriorDistribution, type RealizedCapital } from './replay.ts'

/** One LP's own waterfall terms. Anything absent is the fund's. */
export interface LpWaterfallTerms {
  lpEntityId: string
  /** The LP's carry terms. The carry recipients and what counts as capital stay the fund's. */
  terms?: VehicleCarryTerms
  /** First loss: senior LPs get their capital back before this LP gets any. */
  subordinated?: boolean
}

/** LPs on identical terms, with what they've put in. */
export interface LpGroup {
  id: string
  lpEntityIds: string[]
  terms: VehicleCarryTerms
  subordinated: boolean
  /** The group's dated contributions: its capital, and its hurdle's base. */
  contributions: DatedContribution[]
  /** American: the group's capital in deals realized so far. */
  realizedCapital?: RealizedCapital[]
}

const ZERO_STATE: WaterfallState = {
  contributedCapital: 0, returnedCapital: 0, preferredPaid: 0, preferredTarget: 0, gpCarryPaid: 0, gpCatchUpPaid: 0,
}

/** The terms that decide a group, as a key: two LPs share a group when these match. */
function termsKey(terms: VehicleCarryTerms, subordinated: boolean): string {
  const { recipients: _r, gpEntityId: _g, ...rest } = terms
  return JSON.stringify([rest, subordinated])
}

/**
 * Group LPs by their terms. LPs with no terms of their own are on the fund's terms. Groups come
 * in the order of their first LP. Contributions are matched to LPs by `lpEntityId`; the American
 * base, when the fund's terms are American, comes from `realizedCapitalFor` on each group's LPs.
 */
export function groupLpsByTerms(input: {
  fundTerms: VehicleCarryTerms
  lpEntityIds: string[]
  lpTerms?: LpWaterfallTerms[]
  contributions: (DatedContribution & { lpEntityId: string })[]
  realizedCapitalFor?: (lpEntityIds: string[]) => RealizedCapital[] | undefined
}): LpGroup[] {
  const own = new Map((input.lpTerms ?? []).map(t => [t.lpEntityId, t]))
  const groups = new Map<string, LpGroup>()
  for (const id of input.lpEntityIds) {
    const t = own.get(id)
    // An LP's terms keep the fund's recipients, capital and basis.
    const terms: VehicleCarryTerms = t?.terms
      ? {
          ...t.terms,
          kind: input.fundTerms.kind === 'american' ? 'american' : t.terms.kind,
          recipients: input.fundTerms.recipients,
          gpEntityId: input.fundTerms.gpEntityId,
          ...(input.fundTerms.capitalIncludes ? { capitalIncludes: input.fundTerms.capitalIncludes } : {}),
        }
      : input.fundTerms
    const subordinated = t?.subordinated ?? false
    const key = termsKey(terms, subordinated)
    const g = groups.get(key) ?? { id: key, lpEntityIds: [], terms, subordinated, contributions: [] }
    g.lpEntityIds.push(id)
    groups.set(key, g)
  }
  return [...groups.values()].map((g, i) => {
    const members = new Set(g.lpEntityIds)
    const realized = input.realizedCapitalFor?.(g.lpEntityIds)
    return {
      ...g,
      id: `group-${i + 1}`,
      contributions: input.contributions.filter(c => members.has(c.lpEntityId)).map(({ lpEntityId: _l, ...c }) => c),
      ...(realized ? { realizedCapital: realized } : {}),
    }
  })
}

/** One group's tier state, stepped through the distributions in date order. */
class GroupCursor {
  readonly group: LpGroup
  state: WaterfallState
  private readonly lifetime: DatedContribution[] | undefined
  private readonly capital: DatedContribution[]
  private readonly reductions: HurdleReduction[] = []
  private readonly realized: boolean

  constructor(group: LpGroup, fundEndAsOf?: string) {
    this.group = group
    this.capital = capitalContributions(group.contributions, group.terms.capitalIncludes).filter(c => c.amount > 0)
    // The fund-end view is whole fund and owes all the capital from the first distribution.
    this.lifetime = fundEndAsOf ? this.capital.filter(c => c.date <= fundEndAsOf) : undefined
    this.realized = !this.lifetime && group.terms.kind === 'american' && Array.isArray(group.realizedCapital)
    this.state = { ...ZERO_STATE, contributedCapital: this.lifetime ? total(this.lifetime) : 0 }
  }

  private contributedAsOf(date: string) {
    return this.lifetime ?? this.capital.filter(c => c.date <= date)
  }
  private capitalAsOf(date: string): DatedContribution[] {
    if (this.realized) {
      return this.group.realizedCapital!.filter(c => c.realizedOn <= date && c.amount > 0).map(c => ({ date: c.date, amount: c.amount }))
    }
    return this.lifetime ? this.lifetime : this.contributedAsOf(date)
  }
  private capitalTotal(date: string): number {
    return this.realized
      ? Math.min(total(this.capitalAsOf(date)), total(this.contributedAsOf(date)))
      : total(this.capitalAsOf(date))
  }
  private hurdleBase(date: string): DatedContribution[] {
    // The fund-end view accrues each contribution from its own date, as it arrives.
    return this.lifetime ? this.lifetime.filter(c => c.date <= date) : this.capitalAsOf(date)
  }

  /** The state on `date`, with the capital owed and the hurdle accrued to it. */
  at(date: string): WaterfallState {
    const t = this.group.terms
    const owed = this.capitalTotal(date)
    const target = t.kind === 'straight'
      ? 0
      : hurdleTarget(t, this.lifetime ? this.lifetime : this.capitalAsOf(date), owed, date, t.prefBase === 'unreturned' ? this.reductions : undefined)
    const irr = t.carrySteps?.some(s => s.lpIrr != null)
      ? { irr: { asOf: date, contributions: this.hurdleBase(date), lpDistributions: this.state.irr?.lpDistributions ?? [] } }
      : {}
    return { ...this.state, contributedCapital: owed, preferredTarget: target, ...irr }
  }

  /** What the capital tier still owes on `date`. */
  owed(date: string): number {
    return Math.max(0, this.capitalTotal(date) - this.state.returnedCapital)
  }

  /** The group's capital to date: its weight in the split after return of capital. */
  weight(date: string): number {
    return total(this.capital.filter(c => c.date <= date))
  }

  step(date: string, amount: number): WaterfallResult {
    const result = runWaterfall(amount, waterfallTermsOf(this.group.terms), this.at(date))
    this.reductions.push({ date, capital: result.toReturnOfCapital, preferred: result.toPreferred })
    this.state = result.state
    return result
  }
}

const total = (cs: DatedContribution[]) => roundCents(cs.reduce((s, c) => s + c.amount, 0))

/**
 * Divide `amount` across the groups on `date`: what's paid straight back to LPs first, then
 * return of capital by seniority, then the rest by capital.
 */
function divide(amount: number, date: string, cursors: GroupCursor[], byLp?: Record<string, number>): number[] {
  const shares = cursors.map(c => c.group.lpEntityIds.reduce((s, id) => s + Math.max(0, byLp?.[id] ?? 0), 0))
  let rest = Math.max(0, amount - shares.reduce((s, v) => s + v, 0))
  for (const subordinated of [false, true]) {
    const level = cursors.map((c, k) => k).filter(k => cursors[k].group.subordinated === subordinated)
    // Recontributed capital paid straight back is capital the tier no longer owes.
    const owed = level.map(k => Math.max(0, cursors[k].owed(date) - shares[k]))
    const owedTotal = owed.reduce((s, v) => s + v, 0)
    if (owedTotal <= 0 || rest <= 0) continue
    const paid = Math.min(rest, owedTotal)
    rest -= paid
    level.forEach((k, j) => (shares[k] += (paid * owed[j]) / owedTotal))
  }
  if (rest > 0) {
    const weights = cursors.map(c => c.weight(date))
    const wTotal = weights.reduce((s, v) => s + v, 0)
    cursors.forEach((_, k) => (shares[k] += wTotal > 0 ? (rest * weights[k]) / wTotal : rest / cursors.length))
  }
  return shares
}

/** Step every group through the prior distributions, in date order. */
function replay(priors: PriorDistribution[], groups: LpGroup[], asOf: string, fundEnd: boolean): GroupCursor[] {
  const cursors = groups.map(g => new GroupCursor(g, fundEnd ? asOf : undefined))
  const sorted = [...priors].filter(p => p.amount > 0 && p.date <= asOf).sort((a, b) => a.date.localeCompare(b.date))
  for (const p of sorted) {
    const shares = divide(p.amount, p.date, cursors, p.byLp)
    cursors.forEach((c, k) => { if (shares[k] > 0) c.step(p.date, shares[k]) })
  }
  return cursors
}

export interface GroupSplit {
  group: LpGroup
  /** The group's share of the distribution. */
  amount: number
  stateBefore: WaterfallState
  result: WaterfallResult
}

/** Run one distribution to the carry-bearing LPs across the groups, from where the priors leave them. */
export function splitAcrossGroups(pool: number, priors: PriorDistribution[], groups: LpGroup[], asOf: string): GroupSplit[] {
  const cursors = replay(priors, groups, asOf, false)
  const shares = divide(pool, asOf, cursors)
  return cursors.map((c, k) => {
    const amount = roundCents(shares[k])
    const stateBefore = c.at(asOf)
    return { group: c.group, amount, stateBefore, result: c.step(asOf, amount) }
  })
}

/** The GP's carry on the fund-end view, by group and in total. */
export function groupedFundEndEntitlement(priors: PriorDistribution[], groups: LpGroup[], asOf: string): { total: number; byGroup: number[] } {
  const byGroup = replay(priors, groups, asOf, true).map(c => c.state.gpCarryPaid)
  return { total: roundCents(byGroup.reduce((s, v) => s + v, 0)), byGroup }
}

/**
 * The clawback across groups: the GP's carry paid (as the replay implies it, group by group) less
 * its fund-end entitlement, netted across the fund. `back` is what each group gets of it, in
 * proportion to how much the GP was overpaid on it.
 */
export function groupedClawback(
  priors: PriorDistribution[],
  groups: LpGroup[],
  asOf: string,
  carryPaid: number,
  /** Caps the clawback at the carry paid less tax at this assumed rate (replay.ts netOfTaxCap). */
  netOfTaxRate?: number,
): { paid: number; entitlement: number; amount: number; back: number[]; cap?: number } {
  const paidBy = replay(priors, groups, asOf, false).map(c => c.state.gpCarryPaid)
  const ent = groupedFundEndEntitlement(priors, groups, asOf)
  const cap = netOfTaxCap(carryPaid, netOfTaxRate)
  const owed = roundCents(Math.max(0, carryPaid - ent.total))
  const amount = cap === undefined ? owed : Math.min(cap, owed)
  const excess = paidBy.map((p, k) => Math.max(0, p - ent.byGroup[k]))
  const excessTotal = excess.reduce((s, v) => s + v, 0)
  return {
    paid: roundCents(carryPaid),
    entitlement: ent.total,
    amount,
    back: excess.map(e => (excessTotal > 0 ? (amount * e) / excessTotal : 0)),
    ...(cap === undefined ? {} : { cap }),
  }
}
