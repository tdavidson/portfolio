import { bucketForSourceType, type CapitalPosting } from './capital-account'
import type { CapitalEvidence } from './capital-evidence'

/**
 * The dated flows a partner's IRR is built from, with LP-to-LP transfers resolved.
 *
 * A transfer moves capital from one partner to another and nets to zero across the fund, but what
 * it means for each partner's IRR depends on what kind of transfer it was:
 *
 * - `transfer` is an ASSIGNMENT (a gift, an estate or trust move, a move to an affiliate). Nothing
 *   was sold: the new holder steps into the old holder's position. So the transferee takes over
 *   the transferor's dated contributions and distributions up to the transfer, pro rata to the
 *   share of the transferor's capital that moved, and the transferor keeps the rest. Nothing is
 *   added on the transfer date. This is the default, and what every existing transfer is.
 * - `secondary_transfer` is a SECONDARY SALE. The fund does not know the price the parties agreed,
 *   only the capital-account value moved, so it is the seller's exit and the buyer's purchase at
 *   that value (NAV). The buyer's IRR at the price they actually paid is theirs to work out.
 *
 * Either way the flows across the whole fund are unchanged, so fund-level IRR does not move.
 */
export const SECONDARY_TRANSFER_SOURCE = 'secondary_transfer'
export const ASSIGNMENT_TRANSFER_SOURCE = 'transfer'

/** A posting that is a flow in its own right: a contribution, a distribution or a secondary sale. */
export function isIrrFlow(p: CapitalPosting): boolean {
  if (p.sourceType === SECONDARY_TRANSFER_SOURCE) return true
  const bucket = bucketForSourceType(p.sourceType, p.amount)
  return bucket === 'contributions' || bucket === 'distributions'
}

const isTransfer = (p: CapitalPosting) =>
  p.sourceType === ASSIGNMENT_TRANSFER_SOURCE || p.sourceType === SECONDARY_TRANSFER_SOURCE

/**
 * Every partner's IRR flows (debit-positive `amount`, as the postings carry it), with each
 * assignment's history moved from the transferor to the transferee. Pass the whole vehicle's
 * postings, not one partner's: an assignment needs both sides. Then filter by `lpEntityId`.
 *
 * An assignment's legs are paired by journal entry, or by date for capital events, which carry no
 * entry. Legs that do not net to zero (one side never recorded) are left out, as before.
 */
export function irrFlowPostings(postings: CapitalPosting[]): CapitalPosting[] {
  return carryTransferHistory(postings.filter(isIrrFlow), postings, [ASSIGNMENT_TRANSFER_SOURCE])
}

/**
 * Each partner's CALLED capital (contributions recognized, positive), with the called history of
 * every transferred interest moved to the partner who now holds it.
 *
 * Called capital is measured against the commitment, and a commitment moves with the interest
 * whether it was given (an assignment) or sold (a secondary sale). So unlike the IRR flows, which
 * treat a sale as the seller's exit, this carries the seller's called history over in BOTH cases,
 * pro rata to the share of the seller's capital that moved. Without it the buyer shows the
 * seller's called capital as still uncalled, and the seller shows a negative uncalled balance
 * against a commitment of zero. This is how administrators report it: the transferee takes over
 * the transferor's contributed capital and unfunded commitment.
 *
 * Pass the whole vehicle's postings, not one partner's.
 */
export function calledAfterTransfers(postings: CapitalPosting[]): Map<string, number> {
  // Postings are debit-positive; a contribution is a credit, so called is the negated sum.
  return bucketAfterTransfers(postings, 'contributions', -1)
}

/**
 * Each partner's DISTRIBUTIONS received (positive), with the distribution history of every
 * transferred interest moved to the partner who now holds it, on the same terms as
 * `calledAfterTransfers`. Paid-in is called capital, so it moves with the interest; distributions
 * have to move with it too, or the transferee's DPI and TVPI compare the seller's contributions
 * with only the transferee's own distributions. This is how administrators report a transfer: the
 * transferee takes over the transferor's contributed capital and distributions.
 *
 * Pass the whole vehicle's postings, not one partner's.
 */
export function distributionsAfterTransfers(postings: CapitalPosting[]): Map<string, number> {
  // A distribution is a debit to capital, so the sum is already positive.
  return bucketAfterTransfers(postings, 'distributions', 1)
}

function bucketAfterTransfers(postings: CapitalPosting[], bucket: 'contributions' | 'distributions', sign: 1 | -1): Map<string, number> {
  const inBucket = postings.filter(p => bucketForSourceType(p.sourceType, p.amount) === bucket)
  const flows = carryTransferHistory(inBucket, postings, [ASSIGNMENT_TRANSFER_SOURCE, SECONDARY_TRANSFER_SOURCE])
  // Every partner with a posting gets a figure, so one whose whole interest moved reads 0.
  const out = new Map<string, number>(postings.filter(p => p.lpEntityId).map(p => [p.lpEntityId, 0]))
  for (const f of flows) if (f.lpEntityId) out.set(f.lpEntityId, (out.get(f.lpEntityId) ?? 0) + sign * f.amount)
  for (const [id, v] of out) out.set(id, Math.round(v * 100) / 100)
  return out
}

/**
 * Move each transferor's dated `flows` up to a transfer to its transferees, for the transfer kinds
 * given. An entry's legs are paired by journal entry, or by date for capital events, which carry no
 * entry. Legs that do not net to zero (one side never recorded) are left out.
 */
/**
 * A partner's called capital for display. Every partner carries evidence, ledger-basis ones too, and
 * a ledger-basis evidence figure is the partner's own contributions only. So the evidence figure is
 * used only when it is a reported observation (no books to carry a transfer through); otherwise the
 * figure includes the called history of any interest transferred to the partner.
 */
export function calledCapitalFor(lpEntityId: string, evidence: CapitalEvidence | undefined, calledBy: Map<string, number>): number | null {
  return evidence?.basis === 'reported' ? evidence.values.contributions : calledBy.get(lpEntityId) ?? 0
}

function carryTransferHistory(flowsIn: CapitalPosting[], postings: CapitalPosting[], kinds: string[]): CapitalPosting[] {
  let flows = flowsIn

  const groups = new Map<string, CapitalPosting[]>()
  for (const p of postings) {
    if (!kinds.includes(p.sourceType ?? '') || !p.entryDate || !p.lpEntityId) continue
    const key = p.entryId ? `entry:${p.entryId}` : `date:${p.entryDate}:${p.sourceType}`
    groups.set(key, [...(groups.get(key) ?? []), p])
  }

  // Oldest first, so a partner who received a transfer passes the inherited history on.
  const ordered = Array.from(groups.values()).sort((a, b) => a[0].entryDate!.localeCompare(b[0].entryDate!))

  for (const legs of ordered) {
    const date = legs[0].entryDate!
    const delta = new Map<string, number>() // capital change per partner: credit positive
    for (const l of legs) delta.set(l.lpEntityId, (delta.get(l.lpEntityId) ?? 0) - l.amount)
    const from = Array.from(delta.entries()).filter(([, d]) => d < -0.005)
    const to = Array.from(delta.entries()).filter(([, d]) => d > 0.005)
    const given = from.reduce((s, [, d]) => s - d, 0)
    const received = to.reduce((s, [, d]) => s + d, 0)
    if (from.length === 0 || to.length === 0 || Math.abs(given - received) >= 0.01) continue

    for (const [lp, d] of from) {
      // The transferor's capital just before the transfer: everything dated earlier, and anything
      // else on the day (a transfer is taken as the day's last movement).
      const balance = -postings
        .filter(p => p.lpEntityId === lp && p.entryDate && (p.entryDate < date || (p.entryDate === date && !isTransfer(p))))
        .reduce((s, p) => s + p.amount, 0)
      const share = balance > 0.005 ? Math.min(1, -d / balance) : 1

      flows = flows.flatMap(f => {
        if (f.lpEntityId !== lp || !f.entryDate || f.entryDate > date) return [f]
        const out: CapitalPosting[] = []
        if (share < 1) out.push({ ...f, amount: f.amount * (1 - share) })
        for (const [toLp, r] of to) out.push({ ...f, lpEntityId: toLp, amount: (f.amount * share * r) / received })
        return out
      })
    }
  }
  return flows
}
