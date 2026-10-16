// Match a bank transaction to the partner whose declared call or distribution it settles.
//
// The settlement entries already exist and are correct (`buildFundingEntry` for a call,
// `buildDistributionSettlementEntry` for a distribution). What was missing is knowing WHICH
// partner a wire belongs to without being told. This decides that, and — just as importantly
// — decides when it cannot be decided.
//
// TWO SIGNALS, AND BOTH MATTER:
//
//   amount — an open balance equal to the transaction. On its own this is often ambiguous:
//            partners frequently hold identical commitments, so several can owe or be owed
//            exactly the same figure.
//   name   — the partner's name appearing in the bank description. Bank wires carry it
//            ("WIRED FUNDS SENT BENE: <name> ACCT: …"), and it is what resolves the ties
//            that amount alone cannot.
//
// The rule is deliberately conservative: auto-match only when the two signals agree on ONE
// partner. A wrong guess here moves someone else's money in the books, and a human glancing
// at a reconciled row has no reason to re-check it. Ambiguity is returned, not resolved.

/** An outstanding receivable (call) or payable (distribution) for one partner. */
export interface OpenBalance {
  lpEntityId: string
  name: string
  /** Always positive: what is still owed, in either direction. */
  amount: number
  /**
   * The wire references the partner gave when acknowledging their notices in the portal. A
   * third signal, for the tie the name cannot break: two partners with the same amount and a
   * description that names neither, but quotes the reference one of them told us to expect.
   */
  references?: string[]
}

export type AutoMatch =
  | { kind: 'matched'; lpEntityId: string; name: string; by: 'amount' | 'amount+name' | 'amount+reference' }
  /** Several partners fit the amount and the description didn't separate them. */
  | { kind: 'ambiguous'; candidates: OpenBalance[] }
  | { kind: 'none' }

const CENT = 0.005

/**
 * Normalize for name comparison: case-folded, punctuation dropped, whitespace collapsed.
 * Bank descriptions mangle names ("Klaus Beispiel Holding Gmb" for "…GmbH", "Katarina Moreno"
 * for "Kat Moreno"), so comparison has to survive truncation and formatting.
 */
export function normalizeName(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9\s]/g, ' ').replace(/\s+/g, ' ').trim()
}

/**
 * Does `description` name this partner?
 *
 * Matches on the partner's distinctive name TOKENS rather than the whole string, because the
 * bank truncates ("Klaus Beispiel Holding Gmb") and reorders. Requires every token of length ≥3
 * to appear, so "Michael Brandt" does not match a wire to "Michael J. Corwin" — a first name
 * alone is never enough.
 */
export function descriptionNamesPartner(description: string, partnerName: string): boolean {
  const hay = normalizeName(description)
  const tokens = normalizeName(partnerName).split(' ').filter(t => t.length >= 3)
  if (tokens.length === 0) return false
  // Truncation can cut the LAST token short, so allow a prefix match on it alone.
  const last = tokens[tokens.length - 1]
  const head = tokens.slice(0, -1)
  if (!head.every(t => hay.includes(t))) return false
  if (hay.includes(last)) return true
  // "…Holding Gmb" for "…GmbH": the final token survives only as a prefix.
  return last.length >= 4 && hay.split(' ').some(w => w.length >= 3 && last.startsWith(w))
}

/**
 * Which partner does this transaction settle?
 *
 * `open` holds only balances in the RIGHT direction for this transaction — the caller passes
 * receivables for an inflow and payables for an outflow, so this never has to reason about
 * sign.
 */
export function matchTransaction(
  amount: number,
  description: string | null,
  open: OpenBalance[],
): AutoMatch {
  const target = Math.abs(amount)
  if (target < CENT) return { kind: 'none' }

  const byAmount = open.filter(o => Math.abs(o.amount - target) < 0.01)
  if (byAmount.length === 0) return { kind: 'none' }
  if (byAmount.length === 1) return { kind: 'matched', lpEntityId: byAmount[0].lpEntityId, name: byAmount[0].name, by: 'amount' }

  // Several partners owe (or are owed) exactly this. The description is the tiebreak.
  const named = byAmount.filter(o => description && descriptionNamesPartner(description, o.name))
  if (named.length === 1) {
    return { kind: 'matched', lpEntityId: named[0].lpEntityId, name: named[0].name, by: 'amount+name' }
  }
  // Then the reference a partner said their wire would carry.
  const referenced = byAmount.filter(o => description && descriptionCarriesReference(description, o.references ?? []))
  if (referenced.length === 1) {
    return { kind: 'matched', lpEntityId: referenced[0].lpEntityId, name: referenced[0].name, by: 'amount+reference' }
  }
  return { kind: 'ambiguous', candidates: byAmount }
}

/**
 * Does `description` quote one of the partner's wire references? Compared with the same
 * normalisation as names, and only for references long enough to be distinctive — a
 * three-character reference would match half the bank's descriptions.
 */
export function descriptionCarriesReference(description: string, references: string[]): boolean {
  const hay = normalizeName(description)
  return references.some(r => {
    const ref = normalizeName(r)
    return ref.length >= 4 && hay.includes(ref)
  })
}
