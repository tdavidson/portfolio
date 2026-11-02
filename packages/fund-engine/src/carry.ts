// Accrued carried interest.
//
// THE IDEA. At each close, ask: "if the fund liquidated at today's NAV, what would the GP be
// entitled to?" That number is the TARGET accrual. Compare it to what has already been accrued,
// and post the difference. Because the target is recomputed from scratch every period, the
// accrual reverses on its own when NAV falls — no special case, no clawback logic.
//
// This is the hypothetical-liquidation method, and it is what ASC 946 expects. Without it every
// LP's NAV overstates what they would actually receive by the GP's share of the unrealized
// gain.
//
// IT IS AN EQUITY REALLOCATION, NOT AN EXPENSE. Dr each LP's capital, Cr the GP's capital.
// It never touches P&L and never touches cash — which is precisely why the close has to do it
// AFTER every other category has landed: carry is computed on the NAV that those allocations
// produce.

import { runWaterfall, type CarryStep } from './waterfall.ts'
import { roundCents } from './ledger.ts'
import { capitalContributions, hurdleTarget, type ContributionPurpose, type DatedContribution, type DayCount, type LpDatedContribution, type PrefBase } from './hurdle.ts'
import { replayWaterfallState, waterfallTermsOf, type PriorDistribution } from './replay.ts'
import { apportionCents } from './allocation.ts'

export { preferredTarget } from './hurdle.ts'
export { capitalContributions, hurdleTarget, yearFraction } from './hurdle.ts'
export type { ContributionPurpose, DatedContribution, DayCount, HurdleReduction, HurdleTerms, LpDatedContribution, PrefBase } from './hurdle.ts'

export type CarryKind = 'none' | 'straight' | 'american' | 'european'

/**
 * Whether the waterfall runs once for the whole fund or once per LP. 'per_lp': every distribution
 * (and the close's hypothetical liquidation) is divided among the LPs by contributions first, and
 * each LP's share runs through its own tiers on its own capital, hurdle and history.
 */
export type WaterfallScope = 'fund' | 'per_lp'

export interface CarryRecipient {
  lpEntityId: string
  /** Share of the accrued carry, 0–100. The set sums to 100. */
  pct: number
}

export interface VehicleCarryTerms {
  kind: CarryKind
  carryRate: number
  prefRate: number
  catchupRate: number
  /** How much of a full catch-up the GP gets, 0–1 (waterfall.ts). Absent means 1. */
  catchupSize?: number
  /** What the catch-up is measured on (waterfall.ts). Absent means 'preferred'. */
  catchupMeasure?: 'preferred' | 'profit'
  prefCompounds: boolean
  /** What the hurdle accrues on (hurdle.ts). Absent means 'contributed', the original reading. */
  prefBase?: PrefBase
  /** A hurdle set as a multiple of capital instead of a rate (hurdle.ts). Absent or null: the rate. */
  prefMultiple?: number | null
  /** How the rate's years are counted (hurdle.ts). Absent means ACT/365. */
  prefDayCount?: DayCount
  /** Where the carry steps up at an LP multiple or IRR (waterfall.ts). Absent: one carry rate. */
  carrySteps?: CarryStep[]
  /**
   * The contribution purposes returned as capital and accrued on (hurdle.ts). Absent: all of them.
   * ['investments'] is an LPA that returns only invested capital before carry.
   */
  capitalIncludes?: ContributionPurpose[]
  /**
   * Caps the clawback at the carry paid less tax at this assumed rate (replay.ts
   * clawbackAtFundEnd): the GP never gives back more than it kept after tax. Absent: no cap.
   */
  clawbackNetOfTaxRate?: number
  /** Single-recipient legacy field; kept for back-compat and as the fallback source. */
  gpEntityId: string | null
  /** Who receives the carry and in what split. Resolved from `carry_recipients`, or
   *  `[{ gpEntityId, 100 }]` when only the legacy field is set, else []. */
  recipients: CarryRecipient[]
  /**
   * The recipients' own commitments (the GP commit) bear carry like an LP's: their capital runs
   * through the tiers instead of taking a carry-free share beside them. Absent: carry-free, the
   * usual convention.
   */
  gpCommitBearsCarry?: boolean
  /**
   * The waterfall runs for each LP rather than for the whole fund. Absent: 'fund'. European and
   * straight only; American terms run whole fund whatever this says (not supported per LP).
   */
  waterfallScope?: WaterfallScope
}

/** Whether these terms run the waterfall per LP: 'per_lp', on European or straight terms. */
export function runsPerLp(terms: Pick<VehicleCarryTerms, 'kind' | 'waterfallScope'>): boolean {
  return terms.waterfallScope === 'per_lp' && (terms.kind === 'european' || terms.kind === 'straight')
}

/** The partners whose own capital is carry-free: the recipients, unless the GP commit bears carry. */
export function carryFreeIds(terms: Pick<VehicleCarryTerms, 'recipients' | 'gpCommitBearsCarry'>): Set<string> {
  return terms.gpCommitBearsCarry ? new Set() : new Set(terms.recipients.map(r => r.lpEntityId))
}

export const NO_CARRY: VehicleCarryTerms = {
  kind: 'none',
  carryRate: 0,
  prefRate: 0,
  catchupRate: 1,
  catchupSize: 1,
  prefCompounds: true,
  prefBase: 'contributed',
  gpEntityId: null,
  recipients: [],
}

/** Resolve the carry recipients: the explicit list if present, else the legacy single GP at 100%. */
export function resolveCarryRecipients(carryRecipients: unknown, gpEntityId: string | null): CarryRecipient[] {
  if (Array.isArray(carryRecipients)) {
    const list = carryRecipients
      .filter((r): r is { lpEntityId: string; pct: unknown } => !!r && typeof r.lpEntityId === 'string')
      .map(r => ({ lpEntityId: r.lpEntityId, pct: Number(r.pct) }))
      .filter(r => Number.isFinite(r.pct) && r.pct > 0)
    if (list.length > 0) return list
  }
  return gpEntityId ? [{ lpEntityId: gpEntityId, pct: 100 }] : []
}

/** One LP's economics, as at the accrual date. All from the ledger. */
export interface LpEconomics {
  lpEntityId: string
  /** Cumulative capital contributed (positive). */
  contributed: number
  /** Cumulative distributions received (positive). */
  distributed: number
  /**
   * Capital account balance BEFORE any carry accrual: today's balance with the carry already
   * debited from this LP added back. The target is what the GP would take from the LPs' gross
   * value; measuring it on a balance already net of carry counts the carry twice.
   */
  nav: number
  /**
   * Carry already charged to this LP by earlier accruals (positive). Given for every LP, the
   * accrual trues each LP up to its share of the whole target rather than sharing out only the
   * change; see `carryAccrual`.
   */
  charged?: number
}

export interface CarryTargetInput {
  lps: LpEconomics[]
  /** Dated LP contributions, for the preferred-return accrual. European/American. */
  contributions?: DatedContribution[]
  /** The date the accrual is measured at. European/American. */
  asOf?: string
  /**
   * Every prior distribution as a fund-wide total per date. Needed only when the hurdle accrues on
   * unreturned capital, because then what came back, and when, shrinks the hurdle.
   */
  distributions?: PriorDistribution[]
  /**
   * The same contributions tagged with the LP who made them, for a waterfall per LP. Without them
   * per-LP terms fall back to the whole-fund target.
   */
  lpContributions?: LpDatedContribution[]
}

/**
 * The GP's TOTAL carry entitlement if the fund liquidated at today's NAV.
 *
 * Not the amount to post — that is this minus whatever is already accrued. See `carryAccrual`.
 */
export function carryTarget(input: CarryTargetInput, terms: VehicleCarryTerms): number {
  if (terms.kind === 'none' || terms.carryRate <= 0) return 0
  const perLp = carryTargetByLp(input, terms)
  if (perLp) return perLp.total

  // The capital the first tier owes: every contribution, or only the purposes the terms return.
  const contributed = terms.capitalIncludes && input.contributions
    ? roundCents(capitalContributions(input.contributions, terms.capitalIncludes).reduce((s, c) => s + c.amount, 0))
    : roundCents(input.lps.reduce((s, l) => s + l.contributed, 0))
  const distributed = roundCents(input.lps.reduce((s, l) => s + l.distributed, 0))
  const nav = roundCents(input.lps.reduce((s, l) => s + l.nav, 0))

  // What the LPs would hold in total if we sold everything today.
  const liquidation = roundCents(nav + distributed)
  return liquidationTarget(liquidation, contributed, input.contributions ?? [], input.distributions ?? [], terms, input.asOf)
}

/**
 * The GP's take from a hypothetical liquidation of `liquidation` (what is left plus what was
 * already distributed) on `contributed` capital, `contributions` dated for the hurdle. The whole
 * fund's target, or one LP's under a waterfall per LP.
 */
function liquidationTarget(
  liquidation: number,
  contributed: number,
  dated: DatedContribution[],
  priors: PriorDistribution[],
  terms: VehicleCarryTerms,
  asOfInput: string | undefined,
): number {
  if (terms.kind === 'straight' && !terms.carrySteps?.length) {
    // Profit over contributed capital, GP takes its rate. No pref, no catch-up.
    const profit = roundCents(liquidation - contributed)
    if (profit <= 0) return 0
    return roundCents(profit * terms.carryRate)
  }

  // European (whole-fund) AND American (deal-by-deal) accrue the SAME target here.
  //
  // American doesn't earn the GP MORE carry than European — it earns the same total, just PAID
  // earlier (as individual deals realize), with a clawback that pulls back any carry later deals
  // prove was overpaid. Since this close accrues carry as-if-liquidated-at-today's-NAV — i.e. the
  // GP's ULTIMATE entitlement — and the clawback makes that ultimate total identical to European,
  // the prudent accrued MARK is the whole-fund result for both. (Accruing a deal-by-deal "winners
  // only" figure would overstate the GP and understate LP NAV.) The genuine American difference —
  // distributing realized carry cash per deal before the whole fund is made whole — is a
  // distribution-timing concern, not an accrual one: it is how `splitDistribution` splits an
  // American distribution (replay.ts). A liquidation realizes every deal, so here the deal-by-deal
  // capital base IS the whole fund. Run the real waterfall on the hypothetical liquidation.
  const asOf = asOfInput ?? new Date(0).toISOString().slice(0, 10)
  const contributions = capitalContributions(dated, terms.capitalIncludes)
  // On an unreturned base the hurdle depends on what the actual distributions returned and paid,
  // so replay them (whole-fund: the liquidation realizes every deal) and read its hurdle.
  const pref = terms.prefBase === 'unreturned' && terms.prefMultiple == null
    ? replayWaterfallState(priors, contributions, { ...terms, kind: 'european' }, asOf).preferredTarget
    : hurdleTarget(terms, contributions, contributed, asOf)

  const result = runWaterfall(liquidation, waterfallTermsOf(terms), {
    contributedCapital: contributed,
    returnedCapital: 0,
    preferredPaid: 0,
    preferredTarget: pref,
    gpCarryPaid: 0,
    // An IRR step measures the liquidation as if every dollar came back today, which can only
    // understate the LPs' IRR, so a step is never reached early in the accrual.
    ...(terms.carrySteps?.some(s => s.lpIrr != null) ? { irr: { asOf, contributions, lpDistributions: [] } } : {}),
  })

  // Everything the GP takes across the catch-up and carry tiers.
  return roundCents(result.toCatchUp + result.toCarryGP)
}

/** The per-LP carry target: each LP's own, their total, and what had to be assumed. */
export interface CarryTargetByLp {
  total: number
  byLp: Map<string, number>
  warnings: string[]
}

/**
 * The carry target under a waterfall per LP (`runsPerLp`), or undefined when the terms run whole
 * fund or the input has no per-LP contributions.
 *
 * 1. The hypothetical liquidation of the carry-bearing LPs as a whole is the sum of their NAV,
 *    gross of carry.
 * 2. It is divided by Capital Contribution Percentage as at `asOf` (each LP's cumulative
 *    contributions over all of theirs, to the cent by largest remainder). Not by each LP's own
 *    capital balance: that is circular, because the capital accounts are what the allocation is
 *    solving for.
 * 3. Each LP's share, plus what it has already received, runs through the waterfall on its own
 *    capital and its own hurdle (its own dated contributions; on an unreturned base, its own
 *    distributions replayed), exactly as the whole fund's liquidation does. So a step multiple counts
 *    that LP's prior distributions, and an IRR step that LP's own dated contributions.
 * 4. Each LP's target is the GP's take from it; the fund's is their sum.
 *
 * With every LP contributing pro rata on the same dates and receiving pro rata, this is the
 * whole-fund target to within a cent per LP per tier (the waterfall rounds each LP's tiers).
 */
export function carryTargetByLp(input: CarryTargetInput, terms: VehicleCarryTerms): CarryTargetByLp | undefined {
  if (!runsPerLp(terms) || !input.lpContributions) return undefined
  const warnings: string[] = []
  const byLp = new Map<string, number>()
  if (terms.carryRate <= 0 || input.lps.length === 0) return { total: 0, byLp, warnings }
  const asOf = input.asOf ?? new Date(0).toISOString().slice(0, 10)

  const own = new Map<string, DatedContribution[]>()
  for (const c of input.lpContributions) {
    if (c.date > asOf) continue
    const { lpEntityId, ...rest } = c
    const list = own.get(lpEntityId) ?? []
    list.push(rest)
    own.set(lpEntityId, list)
  }
  const contributedBy = (id: string, date: string) => roundCents((own.get(id) ?? []).filter(c => c.date <= date && c.amount > 0).reduce((s, c) => s + c.amount, 0))

  // 1–2. The liquidation, divided by contributions as at the date.
  const nav = roundCents(input.lps.reduce((s, l) => s + l.nav, 0))
  let weights = input.lps.map(l => contributedBy(l.lpEntityId, asOf))
  if (!weights.some(w => w > 0)) weights = input.lps.map(l => Math.max(0, l.contributed))
  const navCents = apportionCents(Math.round(nav * 100), weights)

  // Each LP's own distributions, for an unreturned hurdle: what the books say it received.
  let divided = false
  const priorsOf = (id: string): PriorDistribution[] => (input.distributions ?? []).flatMap(p => {
    if (p.paidToLp) {
      const amount = roundCents(Math.max(0, p.paidToLp[id] ?? 0))
      return amount > 0 ? [{ date: p.date, amount }] : []
    }
    divided = true
    const all = input.lps.reduce((s, l) => s + contributedBy(l.lpEntityId, p.date), 0)
    const amount = all > 0 ? roundCents((p.amount * contributedBy(id, p.date)) / all) : 0
    return amount > 0 ? [{ date: p.date, amount }] : []
  })
  const unreturned = terms.prefBase === 'unreturned' && terms.prefMultiple == null

  let total = 0
  input.lps.forEach((l, k) => {
    const dated = own.get(l.lpEntityId) ?? []
    const contributed = terms.capitalIncludes
      ? roundCents(capitalContributions(dated, terms.capitalIncludes).reduce((s, c) => s + c.amount, 0))
      : roundCents(l.contributed)
    const liquidation = roundCents(navCents[k] / 100 + l.distributed)
    const target = liquidationTarget(liquidation, contributed, dated, unreturned ? priorsOf(l.lpEntityId) : [], terms, asOf)
    byLp.set(l.lpEntityId, target)
    total = roundCents(total + target)
  })
  if (divided) warnings.push('The books do not say what each LP received from some earlier distributions, so those are divided by contributions for each LP\'s hurdle.')
  return { total, byLp, warnings }
}

/**
 * Normalize a stored terms row (the `vehicle_waterfall_terms` columns, snake_case) into
 * `VehicleCarryTerms`. An absent row is no carry, which is the only safe default: accruing carry
 * nobody agreed to is worse than accruing none. An unrecognised `kind` is also no carry.
 */
export function carryTermsFromRow(row: {
  kind?: unknown
  carry_rate?: unknown
  pref_rate?: unknown
  catchup_rate?: unknown
  catchup_size?: unknown
  catchup_measure?: unknown
  pref_compounds?: unknown
  pref_base?: unknown
  pref_multiple?: unknown
  pref_day_count?: unknown
  carry_steps?: unknown
  capital_includes?: unknown
  gp_entity_id?: unknown
  carry_recipients?: unknown
  gp_commit_bears_carry?: unknown
  waterfall_scope?: unknown
} | null | undefined): VehicleCarryTerms {
  if (!row) return NO_CARRY
  const kind: CarryKind =
    row.kind === 'straight' || row.kind === 'american' || row.kind === 'european' ? row.kind : 'none'
  const gpEntityId = (row.gp_entity_id ?? null) as string | null

  return {
    kind,
    carryRate: Number(row.carry_rate ?? 0),
    prefRate: Number(row.pref_rate ?? 0),
    catchupRate: Number(row.catchup_rate ?? 1),
    catchupSize: row.catchup_size == null ? 1 : Number(row.catchup_size),
    ...(row.catchup_measure === 'profit' ? { catchupMeasure: 'profit' as const } : {}),
    prefCompounds: row.pref_compounds !== false,
    prefBase: row.pref_base === 'unreturned' ? 'unreturned' : 'contributed',
    ...(row.pref_multiple != null && Number(row.pref_multiple) >= 1 ? { prefMultiple: Number(row.pref_multiple) } : {}),
    ...(row.pref_day_count === '30/360' ? { prefDayCount: '30/360' as DayCount } : {}),
    ...(carryStepsFromRow(row.carry_steps)),
    ...(capitalIncludesFromRow(row.capital_includes)),
    gpEntityId,
    recipients: resolveCarryRecipients(row.carry_recipients, gpEntityId),
    ...(row.gp_commit_bears_carry === true ? { gpCommitBearsCarry: true } : {}),
    ...(row.waterfall_scope === 'per_lp' ? { waterfallScope: 'per_lp' as const } : {}),
  }
}

const PURPOSES: ContributionPurpose[] = ['investments', 'fees', 'expenses', 'other']

/** The stored steps (`carry_steps`, jsonb), keeping only well-formed ones. */
function carryStepsFromRow(v: unknown): { carrySteps?: CarryStep[] } {
  if (!Array.isArray(v)) return {}
  const num = (x: unknown) => (x == null || x === '' ? undefined : Number(x))
  const steps: CarryStep[] = []
  for (const raw of v) {
    if (!raw || typeof raw !== 'object') continue
    const o = raw as Record<string, unknown>
    const carryRate = num(o.carryRate)
    const lpMultiple = num(o.lpMultiple)
    const lpIrr = num(o.lpIrr)
    if (carryRate == null || !Number.isFinite(carryRate)) continue
    if ((lpMultiple == null) === (lpIrr == null)) continue
    const catchUpRate = num(o.catchUpRate)
    const catchUpTarget = num(o.catchUpTarget)
    steps.push({
      carryRate,
      ...(lpMultiple != null ? { lpMultiple } : { lpIrr: lpIrr! }),
      ...(catchUpRate != null && catchUpRate > 0 ? { catchUpRate } : {}),
      ...(catchUpTarget != null ? { catchUpTarget } : {}),
      ...(o.catchUpMeasure === 'split' ? { catchUpMeasure: 'split' as const } : {}),
    })
  }
  return steps.length > 0 ? { carrySteps: steps } : {}
}

/** The stored purposes (`capital_includes`, text[]). All four, or none stored, is the default. */
function capitalIncludesFromRow(v: unknown): { capitalIncludes?: ContributionPurpose[] } {
  if (!Array.isArray(v)) return {}
  const list = PURPOSES.filter(p => v.includes(p))
  return list.length > 0 && list.length < PURPOSES.length ? { capitalIncludes: list } : {}
}

export interface CarryAccrual {
  /** Total entitlement at today's NAV. */
  target: number
  /** What is already sitting in the GP's carriedInterest bucket. */
  alreadyAccrued: number
  /** What to post. Negative = a reversal, because NAV fell. */
  delta: number
  /** Per-LP debit. Positive reduces that LP's capital. Sums to `delta`. */
  perLp: Map<string, number>
  /** A waterfall per LP: each LP's own target, which its charge trues up to. */
  targetByLp?: Map<string, number>
  /** What a waterfall per LP had to assume. Absent when nothing was. */
  warnings?: string[]
}

/** `total` shared by `weights` to the cent, largest remainder; the odd cent goes to the largest share. */
function shareByWeight(total: number, weights: { lpEntityId: string; weight: number }[]): Map<string, number> {
  const out = new Map<string, number>()
  const sum = weights.reduce((s, w) => s + w.weight, 0)
  if (sum <= 0) return out
  const rounded = weights.map(w => ({ ...w, exact: (total * w.weight) / sum, amount: roundCents((total * w.weight) / sum) }))
  const drift = roundCents(total - rounded.reduce((s, r) => s + r.amount, 0))
  if (drift !== 0 && rounded.length > 0) {
    const biggest = rounded.reduce((a, b) => (Math.abs(b.exact) > Math.abs(a.exact) ? b : a))
    biggest.amount = roundCents(biggest.amount + drift)
  }
  for (const r of rounded) out.set(r.lpEntityId, r.amount)
  return out
}

/**
 * What this period's close should post.
 *
 * Carry is shared across LPs in proportion to each one's PROFIT: carry is a share of gains, so an
 * LP sitting on a loss does not pay it, and an LP with twice the gain pays twice as much.
 *
 * When every LP's `charged` is given, the accrual is a TRUE-UP: each LP is charged its share of the
 * whole target, by today's profits, less what it has already been charged. Its cumulative charge is
 * then always its share of the GP's entitlement, so every LP ends the fund at the same effective
 * carry rate on its profit, however the earlier accruals were shared out. A period whose total
 * does not change can still move carry between LPs; one in which nobody is in profit reverses
 * every LP's charge.
 *
 * Without `charged`, only the change in the target is shared out, by today's profits, and a
 * period in which nobody is in profit posts nothing.
 */
export function carryAccrual(
  input: CarryTargetInput,
  terms: VehicleCarryTerms,
  alreadyAccrued: number,
  /** The GP commit bears carry: the recipients are among `input.lps` too (carryAccrualInputs). */
  bearing?: BearingRecipients,
): CarryAccrual {
  // A waterfall per LP charges each LP the GP's take from its own waterfall, not a share by profit.
  const perLpTarget = terms.kind === 'none' || terms.carryRate <= 0 ? undefined : carryTargetByLp(input, terms)
  if (perLpTarget) {
    const extra = { targetByLp: perLpTarget.byLp, ...(perLpTarget.warnings.length ? { warnings: perLpTarget.warnings } : {}) }
    if (bearing) return { ...bearingAccrual(input, perLpTarget.total, bearing, perLpTarget.byLp), ...extra }
    return { ...perLpAccrual(input, perLpTarget.total, perLpTarget.byLp, alreadyAccrued), ...extra }
  }
  const target = carryTarget(input, terms)
  if (bearing) return bearingAccrual(input, target, bearing)
  // Each LP's gain, measured the same way the target was: value today plus what they've taken
  // out, less what they put in.
  const profits = input.lps
    .map(l => ({ lpEntityId: l.lpEntityId, weight: roundCents(l.nav + l.distributed - l.contributed) }))
    .filter(p => p.weight > 0)

  if (input.lps.length > 0 && input.lps.every(l => typeof l.charged === 'number')) {
    const charged = roundCents(input.lps.reduce((s, l) => s + (l.charged ?? 0), 0))
    // Nobody in profit means a zero target (the target is the fund's profit through the waterfall).
    const share = shareByWeight(target, profits)
    const perLp = new Map<string, number>()
    for (const l of input.lps) {
      const amount = roundCents((share.get(l.lpEntityId) ?? 0) - (l.charged ?? 0))
      if (amount !== 0) perLp.set(l.lpEntityId, amount)
    }
    return { target, alreadyAccrued: charged, delta: roundCents(target - charged), perLp }
  }

  const delta = roundCents(target - alreadyAccrued)
  const perLp = new Map<string, number>()
  if (delta === 0 || profits.length === 0) {
    // No change to share, or no one is in profit: a positive target can't be sourced from anybody
    // and a reversal has nothing left to reverse against.
    return { target, alreadyAccrued, delta: 0, perLp }
  }
  for (const [id, amount] of shareByWeight(delta, profits)) if (amount !== 0) perLp.set(id, amount)
  return { target, alreadyAccrued, delta, perLp }
}

/**
 * The accrual under a waterfall per LP: each LP is trued up to its own target. With every LP's
 * `charged` given, an LP's line is its target less what it has been charged, so a falling NAV
 * reverses that LP's charge and nobody else's. Without it, only the change in the total is posted,
 * shared by each LP's own target.
 */
function perLpAccrual(input: CarryTargetInput, target: number, byLp: Map<string, number>, alreadyAccrued: number): CarryAccrual {
  const perLp = new Map<string, number>()
  if (input.lps.length > 0 && input.lps.every(l => typeof l.charged === 'number')) {
    const charged = roundCents(input.lps.reduce((s, l) => s + (l.charged ?? 0), 0))
    for (const l of input.lps) {
      const amount = roundCents((byLp.get(l.lpEntityId) ?? 0) - (l.charged ?? 0))
      if (amount !== 0) perLp.set(l.lpEntityId, amount)
    }
    return { target, alreadyAccrued: charged, delta: roundCents(target - charged), perLp }
  }
  const delta = roundCents(target - alreadyAccrued)
  const weights = [...byLp].map(([lpEntityId, weight]) => ({ lpEntityId, weight })).filter(w => w.weight > 0)
  if (delta === 0 || weights.length === 0) return { target, alreadyAccrued, delta: 0, perLp }
  for (const [id, amount] of shareByWeight(delta, weights)) if (amount !== 0) perLp.set(id, amount)
  return { target, alreadyAccrued, delta, perLp }
}

/**
 * The carry recipients when their own commitments bear carry (VehicleCarryTerms.gpCommitBearsCarry),
 * with what the books already hold for each.
 */
export interface BearingRecipients {
  recipients: CarryRecipient[]
  /**
   * Each recipient's net carry accrued to date, credit-positive: what earlier accruals credited it
   * as a recipient less what they charged it as a bearer. Carry PAID is not in it. The books can't
   * split the two sides, because one accrual posts both to the same capital line, but the true-up
   * only needs the net.
   */
  posted: Map<string, number>
}

/**
 * The accrual when the recipients bear carry as well as receive it. The target is the whole fund's
 * carry, recipients' capital included; every partner in profit (a recipient too) bears its share of
 * it by profit, and each recipient receives its percent of it. A recipient's line is the difference,
 * so a single recipient at 100% posts only the carry the LPs bear: what it pays itself nets out.
 *
 * A true-up like the LP-only one: each LP ends at its share less what it was charged, each recipient
 * at its share less its receipt, less what it already holds net. The lines sum to zero, so the entry
 * needs no separate credit to the recipients. Under a waterfall per LP (`byLp`) each bearer's share
 * is its own target rather than a share by profit. `delta` and `alreadyAccrued` are the LPs' side only,
 * which is what the memo reports.
 */
function bearingAccrual(input: CarryTargetInput, target: number, bearing: BearingRecipients, byLp?: Map<string, number>): CarryAccrual {
  const recipientIds = new Set(bearing.recipients.map(r => r.lpEntityId))
  const profits = input.lps
    .map(l => ({ lpEntityId: l.lpEntityId, weight: roundCents(l.nav + l.distributed - l.contributed) }))
    .filter(p => p.weight > 0)
  // Per LP, each bearer's share is its own target (a recipient's too); otherwise by profit.
  const share = byLp ?? shareByWeight(target, profits)

  // Each recipient's receipt, split as buildCarryEntry splits it: the last takes the remainder.
  const receipt = new Map<string, number>()
  let allocated = 0
  bearing.recipients.forEach((r, i) => {
    const amt = i === bearing.recipients.length - 1 ? roundCents(target - allocated) : roundCents((target * r.pct) / 100)
    allocated = roundCents(allocated + amt)
    receipt.set(r.lpEntityId, roundCents((receipt.get(r.lpEntityId) ?? 0) + amt))
  })

  const perLp = new Map<string, number>()
  let charged = 0
  let lpShare = 0
  for (const l of input.lps) {
    if (recipientIds.has(l.lpEntityId)) continue
    charged = roundCents(charged + (l.charged ?? 0))
    lpShare = roundCents(lpShare + (share.get(l.lpEntityId) ?? 0))
    const amount = roundCents((share.get(l.lpEntityId) ?? 0) - (l.charged ?? 0))
    if (amount !== 0) perLp.set(l.lpEntityId, amount)
  }
  for (const id of recipientIds) {
    const amount = roundCents((bearing.posted.get(id) ?? 0) + (share.get(id) ?? 0) - (receipt.get(id) ?? 0))
    if (amount !== 0) perLp.set(id, amount)
  }
  return { target, alreadyAccrued: charged, delta: roundCents(lpShare - charged), perLp }
}
