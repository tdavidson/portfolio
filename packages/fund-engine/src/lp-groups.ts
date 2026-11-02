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
// A WATERFALL PER LP (`waterfallScope: 'per_lp'`). Some LPAs divide every distribution among the
// LPs first and then run each LP's share through its own tiers. `groupLpsByTerms` with `perLp`
// makes each LP its own group, and the division is then `'contributions'`: the whole amount pro
// rata by each LP's cumulative contributed capital as at the distribution date, with no senior
// return of capital (that stays the division for LP classes). Each LP's tier state is replayed from
// what it actually received (`PriorDistribution.paidToLp`, the booked lines), not from a re-division
// of the fund's totals, because history may not have followed the waterfall and the books are the
// record. The carry on each prior is attributed to the LPs whose tiers can account for it
// (`attributePrior`). Without per-LP amounts a prior is divided by contributions, and a warning says
// so.
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
import { apportionCents } from './allocation.ts'

/**
 * How a distribution is divided among the groups before their tiers run.
 *   'seniority'     — return of capital senior first by what each is owed, then pro rata by capital
 *                     (LP classes, the default).
 *   'contributions' — all of it pro rata by cumulative contributions as at the date (a waterfall per
 *                     LP); prior distributions are replayed from what each LP actually received.
 */
export type GroupDivision = 'seniority' | 'contributions'

export interface GroupOptions {
  /** Absent: 'seniority'. */
  division?: GroupDivision
  /** Collects what the replay had to assume (a prior with no per-LP amounts, carry it can't place). */
  warnings?: string[]
}

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
  /** A waterfall per LP: every LP is its own group, whatever its terms. */
  perLp?: boolean
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
    const key = input.perLp ? JSON.stringify([id]) : termsKey(terms, subordinated)
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
  /** The gross share of each prior this group took, by the prior's place in date order. */
  readonly taken: number[] = []

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

  /** Every contribution to date, whatever it paid for: its Capital Contribution Percentage's numerator. */
  contributed(date: string): number {
    return total(this.group.contributions.filter(c => c.date <= date && c.amount > 0))
  }

  /** What the LPs would receive of `amount` on `date`, without stepping. */
  toLp(date: string, amount: number): number {
    return runWaterfall(amount, waterfallTermsOf(this.group.terms), this.at(date)).toLP
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

/**
 * Divide `amount` across the groups by contributions to date (a waterfall per LP): what's paid
 * straight back to LPs first, then the rest pro rata by each group's cumulative contributions, to
 * the cent by largest remainder.
 */
function divideByContributions(amount: number, date: string, cursors: GroupCursor[], byLp?: Record<string, number>): number[] {
  const straight = cursors.map(c => c.group.lpEntityIds.reduce((s, id) => s + Math.max(0, byLp?.[id] ?? 0), 0))
  const restCents = Math.max(0, Math.round(roundCents(amount) * 100) - Math.round(straight.reduce((s, v) => s + v, 0) * 100))
  const parts = apportionCents(restCents, cursors.map(c => c.contributed(date)))
  return cursors.map((_, k) => roundCents(straight[k] + parts[k] / 100))
}

/**
 * The gross of a prior each group's tiers took, from what its LPs actually received
 * (`paidToLp`). The tiers give the LPs a non-decreasing part of any amount, so each group's net
 * pins its gross to a range: one point where the LPs share every dollar, a span where the GP
 * takes all of it (a full catch-up). The carry paid that day (what left beyond the LPs' lines) is
 * placed within those spans, in proportion to their slack, so a history that followed the per-LP
 * waterfall replays exactly. Carry the spans can't hold is left out, with a warning.
 */
function attributePrior(p: PriorDistribution, cursors: GroupCursor[], warnings?: string[]): number[] {
  const paid = p.paidToLp!
  const net = cursors.map(c => roundCents(c.group.lpEntityIds.reduce((s, id) => s + Math.max(0, paid[id] ?? 0), 0)))
  const allNet = roundCents(Object.values(paid).reduce((s, v) => s + Math.max(0, v), 0))
  const carry = roundCents(Math.max(0, p.amount - allNet))
  // Smallest and largest gross (in cents) whose LP part is the net.
  const ranges = cursors.map((c, k) => {
    const target = Math.round(net[k] * 100)
    if (target <= 0) return { lo: 0, hi: 0 }
    const lpAt = (cents: number) => Math.round(c.toLp(p.date, cents / 100) * 100)
    let top = Math.max(1, target)
    for (let i = 0; i < 60 && lpAt(top) <= target; i++) top *= 2
    // lo: first gross with lp >= target; hi: last gross with lp <= target.
    let a = target - 1, b = top
    while (b - a > 1) { const m = Math.floor((a + b) / 2); if (lpAt(m) >= target) b = m; else a = m }
    const lo = b
    a = lo; b = top
    while (b - a > 1) { const m = Math.floor((a + b) / 2); if (lpAt(m) <= target) a = m; else b = m }
    return { lo, hi: a }
  })
  const carryCents = Math.round(carry * 100)
  const gpLo = ranges.map((r, k) => r.lo - Math.round(net[k] * 100))
  const slack = ranges.map(r => r.hi - r.lo)
  const loSum = gpLo.reduce((s, v) => s + v, 0)
  const slackSum = slack.reduce((s, v) => s + v, 0)
  const tag = `the distribution on ${p.date}`
  let extra: number[]
  if (carryCents <= loSum) {
    if (loSum - carryCents > cursors.length) warnings?.push(`The carry booked on ${tag} is less than each LP's waterfall implies from what the LPs received, so the replay assumes the waterfall's figure.`)
    extra = cursors.map(() => 0)
  } else if (carryCents <= loSum + slackSum) {
    extra = apportionCents(carryCents - loSum, slack)
  } else {
    warnings?.push(`The carry booked on ${tag} is more than any LP's waterfall can account for from what the LPs received, so the replay leaves the excess out.`)
    extra = slack
  }
  return cursors.map((_, k) => roundCents((ranges[k].lo + extra[k]) / 100))
}

/**
 * Step every group through the prior distributions, in date order. The fund-end view divides each
 * prior as the actual replay did (what each LP received doesn't change with the view), then runs
 * it with all the capital owed from the start.
 */
function replay(priors: PriorDistribution[], groups: LpGroup[], asOf: string, fundEnd: boolean, opts?: GroupOptions): GroupCursor[] {
  const sorted = [...priors].filter(p => p.amount > 0 && p.date <= asOf).sort((a, b) => a.date.localeCompare(b.date))
  const byContributions = opts?.division === 'contributions'
  const actual = byContributions && fundEnd ? replay(priors, groups, asOf, false, { ...opts, warnings: undefined }) : undefined
  const cursors = groups.map(g => new GroupCursor(g, fundEnd ? asOf : undefined))
  let divided = false
  sorted.forEach((p, i) => {
    let shares: number[]
    if (actual) shares = actual.map(c => c.taken[i] ?? 0)
    else if (!byContributions) shares = divide(p.amount, p.date, cursors, p.byLp)
    else if (p.paidToLp) shares = attributePrior(p, cursors, opts?.warnings)
    else {
      divided = true
      shares = divideByContributions(p.amount, p.date, cursors, p.byLp)
    }
    cursors.forEach((c, k) => {
      c.taken[i] = shares[k]
      if (shares[k] > 0) c.step(p.date, shares[k])
    })
  })
  if (divided) opts?.warnings?.push('The books do not say what each LP received from some earlier distributions, so those are divided by contributions to replay each LP\'s tiers.')
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
export function splitAcrossGroups(pool: number, priors: PriorDistribution[], groups: LpGroup[], asOf: string, opts?: GroupOptions): GroupSplit[] {
  const cursors = replay(priors, groups, asOf, false, opts)
  const shares = opts?.division === 'contributions' ? divideByContributions(pool, asOf, cursors) : divide(pool, asOf, cursors)
  return cursors.map((c, k) => {
    const amount = roundCents(shares[k])
    const stateBefore = c.at(asOf)
    return { group: c.group, amount, stateBefore, result: c.step(asOf, amount) }
  })
}

/** The GP's carry on the fund-end view, by group and in total. */
export function groupedFundEndEntitlement(priors: PriorDistribution[], groups: LpGroup[], asOf: string, opts?: GroupOptions): { total: number; byGroup: number[] } {
  const byGroup = replay(priors, groups, asOf, true, opts).map(c => c.state.gpCarryPaid)
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
  opts?: GroupOptions,
): { paid: number; entitlement: number; amount: number; back: number[]; cap?: number } {
  const paidBy = replay(priors, groups, asOf, false, opts).map(c => c.state.gpCarryPaid)
  const ent = groupedFundEndEntitlement(priors, groups, asOf, opts)
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
