import { bucketForSourceType, type CapitalPosting } from './capital-account'

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
  let flows = postings.filter(isIrrFlow)

  const groups = new Map<string, CapitalPosting[]>()
  for (const p of postings) {
    if (p.sourceType !== ASSIGNMENT_TRANSFER_SOURCE || !p.entryDate || !p.lpEntityId) continue
    const key = p.entryId ? `entry:${p.entryId}` : `date:${p.entryDate}`
    groups.set(key, [...(groups.get(key) ?? []), p])
  }
  // Oldest first, so a partner who received an assignment passes the inherited history on.
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
