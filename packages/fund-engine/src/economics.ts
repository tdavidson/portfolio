// From capital postings to the inputs the carry accrual and the distribution waterfall take.
//
// Both the period close and a distribution preview start from the same thing — every posting to a
// partner's capital account — and both treat the carry RECIPIENTS the same way: they receive carry,
// they do not pay it, so their own contributions are outside the hurdle. Keeping that derivation
// here (rather than inline in each loader) is what lets an outside party reproduce the app's
// numbers from an exported ledger.

import { roundCents } from './ledger.ts'
import { bucketForSourceType, computeCapitalAccounts, type CapitalPosting } from './capital-account.ts'
import type { BearingRecipients, CarryRecipient, DatedContribution, LpEconomics } from './carry.ts'
import type { PartnerEconomics, PriorDistribution } from './distribution-waterfall.ts'

export interface CarryAccrualInputs {
  /** Every non-recipient partner's economics, from the inception-to-date roll-forward. */
  lps: LpEconomics[]
  /** Dated non-recipient contributions, for the preferred return. */
  contributions: DatedContribution[]
  /**
   * Carry already charged to the LPs: what earlier accruals debited from their carriedInterest
   * lines. Not the recipients' balance, which carry PAID has already drawn down.
   */
  alreadyAccrued: number
  /** Every prior distribution as a fund-wide total per date, for an unreturned-capital hurdle. */
  distributions: PriorDistribution[]
  /** Only when the GP commit bears carry: the recipients, who are then in `lps` too. Pass to carryAccrual. */
  bearing?: BearingRecipients
}

/**
 * The carry accrual's inputs from capital postings already scoped to the accrual date (the
 * caller passes only postings on or before `asOf`). `asOf` stands in for an undated posting.
 */
export function carryAccrualInputs(
  capitalPostings: CapitalPosting[],
  recipients: CarryRecipient[],
  asOf: string,
  /** The GP commit bears carry (VehicleCarryTerms.gpCommitBearsCarry): the recipients are in the economics too. */
  gpCommitBearsCarry = false,
): CarryAccrualInputs {
  const recipientIds = new Set(recipients.map(r => r.lpEntityId))
  const carryFree = gpCommitBearsCarry ? new Set<string>() : recipientIds
  const accounts = computeCapitalAccounts(capitalPostings)

  // Carry is measured LP-side. Each LP's carriedInterest line holds what earlier accruals charged
  // it (a debit, so negative). The target is what the GP would take from the LPs' value GROSS of
  // carry, so that charge is added back to the balance, and it is also what is already accrued.
  // The recipients' own balance is the wrong figure for the second: carry PAID is drawn from it, so
  // measuring against it would accrue again every dollar already paid out. Passing each LP's charge
  // makes the accrual a true-up: every LP ends at its share of the whole target.
  const charged = (a: { carriedInterest: number }) => roundCents(-a.carriedInterest)
  const lpAccounts = Array.from(accounts.entries()).filter(([id]) => !recipientIds.has(id)) // recipients receive carry; they don't pay it
  const alreadyAccrued = roundCents(lpAccounts.reduce((s, [, a]) => s + charged(a), 0))

  const lps: LpEconomics[] = lpAccounts.map(([lpEntityId, a]) => ({
    lpEntityId,
    contributed: roundCents(a.contributions),
    distributed: roundCents(-a.distributions), // stored negative on the account
    nav: roundCents(a.ending + charged(a)),
    charged: charged(a),
  }))

  // When the GP commit bears carry the recipients pay it on their own capital as well. Their
  // carriedInterest line mixes carry received, carry charged and carry paid, so their NAV before
  // any carry is the balance with that whole line taken out, and what the accrual already holds for
  // them is the line before payouts (carry_distribution), net.
  let bearing: BearingRecipients | undefined
  if (gpCommitBearsCarry) {
    const posted = new Map<string, number>()
    for (const p of capitalPostings) {
      if (!recipientIds.has(p.lpEntityId) || p.sourceType === 'carry_distribution') continue
      if (bucketForSourceType(p.sourceType, p.amount) !== 'carriedInterest') continue
      posted.set(p.lpEntityId, roundCents((posted.get(p.lpEntityId) ?? 0) - p.amount))
    }
    for (const r of recipients) {
      const a = accounts.get(r.lpEntityId)
      if (!a || lps.some(l => l.lpEntityId === r.lpEntityId)) continue
      lps.push({
        lpEntityId: r.lpEntityId,
        contributed: roundCents(a.contributions),
        distributed: roundCents(-a.distributions),
        nav: roundCents(a.ending - a.carriedInterest),
        charged: 0,
      })
    }
    bearing = { recipients, posted }
  }

  // Dated contributions, for the hurdle. The pref accrues from when cash actually arrived.
  const contributions = datedContributions(capitalPostings, carryFree, asOf)

  const { priors: distributions } = priorDistributions(capitalPostings, recipientIds, asOf, carryFree)
  return { lps, contributions, alreadyAccrued, distributions, ...(bearing ? { bearing } : {}) }
}

/**
 * The LPs' dated contributions, recipients left out, each tagged with what it paid for.
 *
 * The books don't say which call paid which fee, so the tagging is first in, first out per LP: a
 * management fee or partnership expense charged to an LP's account uses that LP's oldest capital
 * not yet used, and a charge with no capital left to use is paid by the next contribution. What is
 * never used by a charge is invested capital. Terms that return every contribution
 * (`capitalIncludes` absent) read the same totals on the same dates either way; terms that return
 * only invested capital leave the fee and expense slices out (hurdle.ts `capitalContributions`).
 */
export function datedContributions(capitalPostings: CapitalPosting[], recipientIds: Set<string>, asOf: string): DatedContribution[] {
  type Ev = { date: string; order: number; kind: 'in' | 'fees' | 'expenses'; amount: number }
  const byLp = new Map<string, Ev[]>()
  for (const p of capitalPostings) {
    if (!p.lpEntityId || recipientIds.has(p.lpEntityId)) continue
    const bucket = bucketForSourceType(p.sourceType, p.amount)
    const date = p.entryDate ?? asOf
    const ev: Ev | null = bucket === 'contributions' && -p.amount > 0 ? { date, order: 1, kind: 'in', amount: roundCents(-p.amount) }
      : bucket === 'managementFees' && p.amount > 0 ? { date, order: 0, kind: 'fees', amount: p.amount }
      : bucket === 'expenses' && p.amount > 0 ? { date, order: 0, kind: 'expenses', amount: p.amount }
      : null
    if (!ev) continue
    const list = byLp.get(p.lpEntityId) ?? []
    list.push(ev)
    byLp.set(p.lpEntityId, list)
  }

  const out: DatedContribution[] = []
  for (const events of byLp.values()) {
    events.sort((a, b) => a.date.localeCompare(b.date) || a.order - b.order)
    const unused: { date: string; amount: number }[] = []
    const owed: { purpose: 'fees' | 'expenses'; amount: number }[] = []
    const tag = (date: string, amount: number, purpose: 'fees' | 'expenses') => {
      if (amount > 0.000001) out.push({ date, amount: roundCents(amount), purpose })
    }
    for (const e of events) {
      if (e.kind === 'in') {
        let left = e.amount
        while (left > 0.000001 && owed.length > 0) {
          const use = Math.min(left, owed[0].amount)
          tag(e.date, use, owed[0].purpose)
          left -= use
          owed[0].amount -= use
          if (owed[0].amount <= 0.000001) owed.shift()
        }
        if (left > 0.000001) unused.push({ date: e.date, amount: left })
      } else {
        let need = e.amount
        while (need > 0.000001 && unused.length > 0) {
          const use = Math.min(need, unused[0].amount)
          tag(unused[0].date, use, e.kind)
          need -= use
          unused[0].amount -= use
          if (unused[0].amount <= 0.000001) unused.shift()
        }
        if (need > 0.000001) owed.push({ purpose: e.kind, amount: need })
      }
    }
    for (const u of unused) if (u.amount > 0.000001) out.push({ date: u.date, amount: roundCents(u.amount), purpose: 'investments' })
  }
  return out.filter(c => c.amount > 0).sort((a, b) => a.date.localeCompare(b.date))
}

/**
 * Every distribution that left the fund on or before `asOf`, as a fund-wide total per date — LP
 * distributions and carry paid both, because the waterfall is defined over what left — and the
 * carry paid to the recipients.
 */
export function priorDistributions(
  capitalPostings: CapitalPosting[],
  recipientIds: Set<string>,
  asOf: string,
  /** The partners whose own capital is outside the tiers. Defaults to the recipients. */
  carryFree: Set<string> = recipientIds,
): { priors: PriorDistribution[]; carryPaidToDate: number } {
  const priorByDate = new Map<string, number>()
  let carryPaidToDate = 0
  for (const p of capitalPostings) {
    if (!p.lpEntityId || p.amount <= 0) continue
    const isDist = bucketForSourceType(p.sourceType, p.amount) === 'distributions'
    const isCarry = p.sourceType === 'carry_distribution'
    if (!isDist && !isCarry) continue
    // A recipient's own distributions are its carry-free share, taken outside the tiers, so only
    // its carry is in what the waterfall has paid out (distribution-waterfall.ts). When its commit
    // bears carry its distributions went through the tiers like an LP's.
    if (!isCarry && carryFree.has(p.lpEntityId)) continue
    const date = p.entryDate ?? asOf
    if (date > asOf) continue
    priorByDate.set(date, roundCents((priorByDate.get(date) ?? 0) + p.amount))
    if (isCarry && recipientIds.has(p.lpEntityId)) carryPaidToDate = roundCents(carryPaidToDate + p.amount)
  }
  const priors = Array.from(priorByDate.entries()).map(([date, amount]) => ({ date, amount }))
  return { priors, carryPaidToDate }
}

export interface DistributionSplitInputs {
  /** Every partner with a capital account at `asOf`, recipients included. */
  partners: PartnerEconomics[]
  /** Dated non-recipient contributions, for the hurdle. */
  contributions: DatedContribution[]
  /** Every prior distribution (LP distributions and carry paid) as a fund-wide total per date. */
  priors: PriorDistribution[]
  /** Carry actually paid to the recipients to date. */
  carryPaidToDate: number
}

/**
 * The distribution waterfall's inputs from capital postings, as at the distribution date.
 * Postings after `asOf` are ignored.
 */
export function distributionSplitInputs(
  capitalPostings: CapitalPosting[],
  recipients: CarryRecipient[],
  asOf: string,
  /** The GP commit bears carry (VehicleCarryTerms.gpCommitBearsCarry): the recipients run through the tiers. */
  gpCommitBearsCarry = false,
): DistributionSplitInputs {
  const recipientIds = new Set(recipients.map(r => r.lpEntityId))
  const carryFree = gpCommitBearsCarry ? new Set<string>() : recipientIds

  const accounts = computeCapitalAccounts(capitalPostings, { end: asOf })
  const partners: PartnerEconomics[] = Array.from(accounts.entries()).map(([lpEntityId, a]) => ({
    lpEntityId,
    contributed: roundCents(a.contributions),
    distributed: roundCents(-a.distributions),
    ending: roundCents(a.ending),
    ...(gpCommitBearsCarry && recipientIds.has(lpEntityId) ? { carryBearing: true } : {}),
  }))

  // Dated contributions for the hurdle: carry-free capital excluded, as the close excludes it.
  const contributions = datedContributions(capitalPostings, carryFree, asOf)

  const { priors, carryPaidToDate } = priorDistributions(capitalPostings, recipientIds, asOf, carryFree)

  return { partners, contributions, priors, carryPaidToDate }
}
