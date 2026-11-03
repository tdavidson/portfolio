// From capital postings to the inputs the carry accrual and the distribution waterfall take.
//
// Both the period close and a distribution preview start from the same thing — every posting to a
// partner's capital account — and both treat the carry RECIPIENTS the same way: they receive carry,
// they do not pay it, so their own contributions are outside the hurdle. Keeping that derivation
// here (rather than inline in each loader) is what lets an outside party reproduce the app's
// numbers from an exported ledger.

import { roundCents } from './ledger.ts'
import { bucketForSourceType, computeCapitalAccounts, type CapitalPosting } from './capital-account.ts'
import type { BearingRecipients, CarryRecipient, DatedContribution, LpDatedContribution, LpEconomics } from './carry.ts'
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
  /**
   * Only with `perLp`: the same contributions tagged by LP. `distributions` then also carry what
   * each LP received (`paidToLp`). Pass both to carryAccrual for a waterfall per LP.
   */
  lpContributions?: LpDatedContribution[]
}

/**
 * What a waterfall per LP needs on top: contributions tagged by LP, and each prior's per-LP lines.
 * With `perLp`, an LP who holds its interest by transfer also steps into the transferor's history
 * (`inheritTransferredHistory`), so its tiers run on the original LP's dated contributions.
 */
export interface EconomicsOptions {
  perLp?: boolean
}

const TRANSFER_SOURCES = new Set(['transfer', 'secondary_transfer'])

/**
 * The postings with each LP-to-LP transfer resolved as a succession: the transferee takes over the
 * transferor's postings up to the transfer (contributions, fees, expenses, P&L, distributions and
 * carry charged), pro rata to the share of the transferor's capital that moved, and the transfer's
 * own legs drop out. Every partner's capital balance is unchanged; what changes is whose dated
 * contributions and receipts they are.
 *
 * A waterfall per LP needs this: a transferee has no contributions of its own, and the LPA puts it in
 * the original LP's shoes, so its share of a distribution, its capital, its hurdle and its step
 * multiple are the transferor's. That holds for an assignment and a secondary sale alike, because
 * the price a buyer paid is not in the fund's books and does not change the waterfall. (Partner IRR
 * treats the two differently, lib/accounting/irr-flows.ts; this is not IRR.)
 *
 * Legs are paired by journal entry, or by date when they carry none, and only legs that net to zero
 * are resolved; the rest are left as they are. Transfers are taken oldest first, so an interest
 * transferred twice carries the original history through.
 */
export function inheritTransferredHistory(capitalPostings: CapitalPosting[]): CapitalPosting[] {
  const groups = new Map<string, CapitalPosting[]>()
  for (const p of capitalPostings) {
    if (!TRANSFER_SOURCES.has(p.sourceType ?? '') || !p.entryDate || !p.lpEntityId) continue
    const key = p.entryId ? `entry:${p.entryId}` : `date:${p.entryDate}`
    groups.set(key, [...(groups.get(key) ?? []), p])
  }
  if (groups.size === 0) return capitalPostings
  const ordered = Array.from(groups.values()).sort((a, b) => a[0].entryDate!.localeCompare(b[0].entryDate!))

  let out = capitalPostings
  for (const legs of ordered) {
    const date = legs[0].entryDate!
    const delta = new Map<string, number>() // capital change per partner: credit positive
    for (const l of legs) delta.set(l.lpEntityId, (delta.get(l.lpEntityId) ?? 0) - l.amount)
    const from = Array.from(delta.entries()).filter(([, d]) => d < -0.005)
    const to = Array.from(delta.entries()).filter(([, d]) => d > 0.005)
    const given = from.reduce((s, [, d]) => s - d, 0)
    const received = to.reduce((s, [, d]) => s + d, 0)
    if (from.length === 0 || to.length === 0 || Math.abs(given - received) >= 0.01) continue

    const legSet = new Set(legs)
    out = out.filter(p => !legSet.has(p))
    for (const [lp, d] of from) {
      // What the transferor held just before: everything dated earlier, and the day's other
      // movements (a transfer is the day's last).
      const before = (p: CapitalPosting) => p.lpEntityId === lp && !!p.entryDate && p.entryDate <= date && !TRANSFER_SOURCES.has(p.sourceType ?? '')
      const balance = -out.filter(p => p.lpEntityId === lp && p.entryDate && (p.entryDate < date || (p.entryDate === date && !TRANSFER_SOURCES.has(p.sourceType ?? ''))))
        .reduce((s, p) => s + p.amount, 0)
      if (balance <= 0.005) continue
      const share = Math.min(1, -d / balance)
      out = out.flatMap(p => {
        if (!before(p)) return [p]
        const moved: CapitalPosting[] = share < 1 ? [{ ...p, amount: p.amount * (1 - share) }] : []
        for (const [toLp, r] of to) moved.push({ ...p, lpEntityId: toLp, amount: (p.amount * share * r) / received })
        return moved
      })
    }
  }
  return out
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
  opts?: EconomicsOptions,
): CarryAccrualInputs {
  if (opts?.perLp) capitalPostings = inheritTransferredHistory(capitalPostings)
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
  const tagged = datedContributionsByLp(capitalPostings, carryFree, asOf)
  const contributions = untag(tagged)

  const { priors: distributions } = priorDistributions(capitalPostings, recipientIds, asOf, carryFree, opts)
  return { lps, contributions, alreadyAccrued, distributions, ...(bearing ? { bearing } : {}), ...(opts?.perLp ? { lpContributions: tagged } : {}) }
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
  return untag(datedContributionsByLp(capitalPostings, recipientIds, asOf))
}

const untag = (cs: LpDatedContribution[]): DatedContribution[] => cs.map(({ lpEntityId: _l, ...c }) => c)

/** `datedContributions`, each tagged with the LP who made it, in the same order. */
export function datedContributionsByLp(capitalPostings: CapitalPosting[], recipientIds: Set<string>, asOf: string): LpDatedContribution[] {
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

  const out: LpDatedContribution[] = []
  for (const [lpEntityId, events] of byLp) {
    events.sort((a, b) => a.date.localeCompare(b.date) || a.order - b.order)
    const unused: { date: string; amount: number }[] = []
    const owed: { purpose: 'fees' | 'expenses'; amount: number }[] = []
    const tag = (date: string, amount: number, purpose: 'fees' | 'expenses') => {
      if (amount > 0.000001) out.push({ date, amount: roundCents(amount), purpose, lpEntityId })
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
    for (const u of unused) if (u.amount > 0.000001) out.push({ date: u.date, amount: roundCents(u.amount), purpose: 'investments', lpEntityId })
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
  /** `perLp`: each prior also says what each LP received of it (`paidToLp`), carry excluded. */
  opts?: EconomicsOptions,
): { priors: PriorDistribution[]; carryPaidToDate: number } {
  const priorByDate = new Map<string, number>()
  const paidByDate = new Map<string, Record<string, number>>()
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
    if (opts?.perLp) {
      const paid = paidByDate.get(date) ?? {}
      if (!isCarry) paid[p.lpEntityId] = roundCents((paid[p.lpEntityId] ?? 0) + p.amount)
      paidByDate.set(date, paid)
    }
  }
  const priors = Array.from(priorByDate.entries()).map(([date, amount]) => (
    opts?.perLp ? { date, amount, paidToLp: paidByDate.get(date) ?? {} } : { date, amount }
  ))
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
  /** Only with `perLp`: the contributions tagged by LP, for a waterfall per LP; `priors` carry `paidToLp`. */
  lpContributions?: LpDatedContribution[]
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
  opts?: EconomicsOptions,
): DistributionSplitInputs {
  if (opts?.perLp) capitalPostings = inheritTransferredHistory(capitalPostings)
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
  const tagged = datedContributionsByLp(capitalPostings, carryFree, asOf)
  const contributions = untag(tagged)

  const { priors, carryPaidToDate } = priorDistributions(capitalPostings, recipientIds, asOf, carryFree, opts)

  return { partners, contributions, priors, carryPaidToDate, ...(opts?.perLp ? { lpContributions: tagged } : {}) }
}
