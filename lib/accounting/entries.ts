// Journal-entry builders. Each turns an engine result into ONE balanced entry
// with a single source_type, so the capital-account roll-forward buckets it
// correctly. Allocations post directly to LP capital (debit positive, so a
// credit that increases capital is negative), offset to the real account.
//
// Sign convention: contributions/gains credit LP capital (negative posting);
// distributions/fees/expenses/carry debit LP capital (positive posting).

import { roundCents, assertBalanced } from './ledger'
import { allocateAmount, type LpOwnership } from './allocation'
import type { FeeResult } from './fees'
import type { JournalEntry, Posting } from './types'

export type CapitalAccountMap = Map<string, string> // lpEntityId → account_id

interface Base {
  fundId: string
  entryDate: string
  memo?: string
}

function lpDebit(capMap: CapitalAccountMap, lpEntityId: string, amount: number, currency = 'USD'): Posting {
  const accountId = capMap.get(lpEntityId)
  if (!accountId) throw new Error(`No capital account for LP entity ${lpEntityId}`)
  return { accountId, amount: roundCents(amount), currency, lpEntityId }
}

function finalize(base: Base, sourceType: string, postings: Posting[]): JournalEntry {
  const entry: JournalEntry = { fundId: base.fundId, entryDate: base.entryDate, memo: base.memo, sourceType, postings }
  assertBalanced(entry)
  return entry
}

/** Capital call: debit cash, credit each LP's capital pro-rata by commitment. */
export function buildCapitalCallEntry(
  base: Base,
  total: number,
  owners: LpOwnership[],
  capMap: CapitalAccountMap,
  cashAccountId: string,
  currency = 'USD'
): JournalEntry {
  const alloc = allocateAmount(total, owners)
  const postings: Posting[] = [{ accountId: cashAccountId, amount: roundCents(total), currency, lpEntityId: null }]
  for (const [lpEntityId, share] of Array.from(alloc.entries())) {
    postings.push(lpDebit(capMap, lpEntityId, -share, currency)) // credit LP capital
  }
  return finalize(base, 'capital_call', postings)
}

/**
 * Capital-call issuance (recognize-at-call): for each LP, debit the capital-call
 * receivable (Due from LPs) and credit their capital. Funding later clears the
 * receivable. `perLp` holds each LP's called amount. The receivable posting
 * carries the LP id so per-LP receivable balances derive from the ledger.
 */
export function buildCapitalCallIssuanceEntry(
  base: Base,
  perLp: Map<string, number>,
  capMap: CapitalAccountMap,
  receivableAccountId: string,
  currency = 'USD'
): JournalEntry {
  const postings: Posting[] = []
  for (const [lpEntityId, amt] of Array.from(perLp.entries())) {
    if (!amt) continue
    postings.push({ accountId: receivableAccountId, amount: roundCents(amt), currency, lpEntityId }) // Dr receivable
    postings.push(lpDebit(capMap, lpEntityId, -amt, currency)) // Cr LP capital
  }
  return finalize(base, 'capital_call', postings)
}

/**
 * Record an LP's funding against an open call: debit cash, credit the capital-call
 * receivable for that LP (no capital effect — capital was recognized at the call).
 */
export function buildFundingEntry(
  base: Base,
  lpEntityId: string,
  amount: number,
  cashAccountId: string,
  receivableAccountId: string,
  currency = 'USD'
): JournalEntry {
  return finalize(base, 'contribution_funding', [
    { accountId: cashAccountId, amount: roundCents(amount), currency, lpEntityId: null },
    { accountId: receivableAccountId, amount: roundCents(-amount), currency, lpEntityId }, // Cr receivable
  ])
}

/** Distribution: debit each LP's capital, credit cash. `perLp` amounts per LP. */
export function buildDistributionEntry(
  base: Base,
  perLp: Map<string, number>,
  capMap: CapitalAccountMap,
  cashAccountId: string,
  currency = 'USD'
): JournalEntry {
  let total = 0
  const postings: Posting[] = []
  for (const [lpEntityId, amt] of Array.from(perLp.entries())) {
    total = roundCents(total + amt)
    postings.push(lpDebit(capMap, lpEntityId, amt, currency))
  }
  postings.push({ accountId: cashAccountId, amount: roundCents(-total), currency, lpEntityId: null })
  return finalize(base, 'distribution', postings)
}

/**
 * DECLARE a distribution: reduce each partner's capital now, park the obligation in
 * Distributions payable until the money actually leaves.
 *
 * The mirror of `buildCapitalCallIssuanceEntry`. Recognition and settlement are separate
 * events on the way out just as they are on the way in — and the payable is what an outgoing
 * wire later settles, which is what makes a distribution matchable to the declaration that
 * authorized it. Booking straight to cash would leave nothing to match against.
 *
 * Each posting carries the LP id, so per-LP payable balances derive from the ledger.
 */
export function buildDistributionDeclarationEntry(
  base: Base,
  perLp: Map<string, number>,
  capMap: CapitalAccountMap,
  payableAccountId: string,
  currency = 'USD'
): JournalEntry {
  const postings: Posting[] = []
  for (const [lpEntityId, amt] of Array.from(perLp.entries())) {
    if (!amt) continue
    postings.push(lpDebit(capMap, lpEntityId, amt, currency))                                  // Dr LP capital
    postings.push({ accountId: payableAccountId, amount: roundCents(-amt), currency, lpEntityId }) // Cr payable
  }
  return finalize(base, 'distribution', postings)
}

/**
 * SETTLE a declared distribution: clear the payable with cash. No capital effect — capital
 * was reduced at declaration, exactly as `buildFundingEntry` adds none because capital was
 * recognized at the call.
 */
export function buildDistributionSettlementEntry(
  base: Base,
  lpEntityId: string,
  amount: number,
  cashAccountId: string,
  payableAccountId: string,
  currency = 'USD'
): JournalEntry {
  const amt = roundCents(Math.abs(amount))
  return finalize(base, 'distribution_settlement', [
    { accountId: payableAccountId, amount: amt, currency, lpEntityId },        // Dr payable
    { accountId: cashAccountId, amount: roundCents(-amt), currency, lpEntityId: null }, // Cr cash
  ])
}

/**
 * The two accounts a P&L entry touches.
 *
 * These source entries deliberately contain no LP-capital lines. Once posted,
 * `continuous-allocation.ts` writes a linked balance-sheet allocation through the
 * undistributed-earnings bridge. Drafts have no capital effect; unposting or voiding
 * keeps the generated allocation in step.
 */
export interface PnlAccounts {
  /** The income/expense account for the income statement. */
  pnlAccountId: string
  /** Cash, Due-to-GP, or the investment account — the real asset/liability side. */
  offsetAccountId: string
}

/**
 * Management fee:
 *   Dr Management fee expense     Cr Due to GP / Cash
 * The income statement shows the expense; posting allocates it to capital immediately.
 */
export function buildManagementFeeEntry(
  base: Base,
  fee: FeeResult,
  accts: PnlAccounts,
  currency = 'USD'
): JournalEntry {
  return finalize(base, 'management_fee', [
    { accountId: accts.pnlAccountId, amount: roundCents(fee.total), currency, lpEntityId: null },
    { accountId: accts.offsetAccountId, amount: roundCents(-fee.total), currency, lpEntityId: null },
  ])
}

/**
 * Partnership expense:
 *   Dr Partnership expense   Cr Cash
 */
export function buildExpenseEntry(
  base: Base,
  total: number,
  accts: PnlAccounts,
  currency = 'USD'
): JournalEntry {
  return finalize(base, 'partnership_expense', [
    { accountId: accts.pnlAccountId, amount: roundCents(total), currency, lpEntityId: null },
    { accountId: accts.offsetAccountId, amount: roundCents(-total), currency, lpEntityId: null },
  ])
}

/**
 * Realized gain:
 *   Dr Cash / Investment   Cr Realized gains
 */
export function buildGainEntry(
  base: Base,
  total: number,
  accts: PnlAccounts,
  currency = 'USD'
): JournalEntry {
  return finalize(base, 'realized_gain', [
    { accountId: accts.offsetAccountId, amount: roundCents(total), currency, lpEntityId: null }, // Dr asset
    { accountId: accts.pnlAccountId, amount: roundCents(-total), currency, lpEntityId: null },   // Cr income
  ])
}

/**
 * Period close: zero every P&L account into the bridge. Given each P&L account's
 * debit-side balance, post the negation to flatten it and offset the sum to the
 * bridge — which, because the compound entries already parked the allocation
 * there, nets the bridge back to zero. Capital was updated by those entries, so
 * this touches no LP accounts.
 */
export function buildPeriodCloseEntry(
  base: Base,
  pnlBalances: { accountId: string; balance: number }[],
  bridgeAccountId: string,
  currency = 'USD'
): JournalEntry {
  const nonzero = pnlBalances.filter(b => roundCents(b.balance) !== 0)
  if (nonzero.length === 0) throw new Error('Nothing to close — no P&L balances')
  let sum = 0
  const postings: Posting[] = nonzero.map(b => {
    sum = roundCents(sum + b.balance)
    return { accountId: b.accountId, amount: roundCents(-b.balance), currency, lpEntityId: null }
  })
  postings.push({ accountId: bridgeAccountId, amount: roundCents(sum), currency, lpEntityId: null })
  return finalize(base, 'period_close', postings)
}

/**
 * Transfer of capital between partners (LP secondary / assignment): debit the
 * transferor's capital, credit the transferee's. Nets to zero at the fund level —
 * no cash moves and NAV is unchanged; only the ownership of it changes.
 */
export function buildTransferEntry(
  base: Base,
  fromLpEntityId: string,
  toLpEntityId: string,
  amount: number,
  capMap: CapitalAccountMap,
  currency = 'USD'
): JournalEntry {
  const amt = roundCents(amount)
  if (amt <= 0) throw new Error('Transfer amount must be positive')
  if (fromLpEntityId === toLpEntityId) throw new Error('Cannot transfer capital to the same partner')
  return finalize(base, 'transfer', [
    lpDebit(capMap, fromLpEntityId, amt, currency),  // reduce the transferor
    lpDebit(capMap, toLpEntityId, -amt, currency),   // increase the transferee
  ])
}

/**
 * Carried interest: debit each LP's capital by their carry share, credit the GP.
 *
 * `gpEntityId` names the PARTNER receiving the carry. Pass it and the credit lands in that
 * partner's own capital account, carrying its `lp_entity_id` — which is what puts the amount
 * into their `carriedInterest` roll-forward bucket, and what the associates look-through
 * splits by carry points.
 *
 * Without it the credit goes to the pooled GP capital account (3000) with no partner attached.
 * That still balances, but the carry then belongs to nobody in particular: it never appears in
 * any partner's capital account, and it cannot be looked through. Only do that when the GP
 * genuinely isn't modelled as a partner.
 *
 * Amounts may be NEGATIVE — an accrual reverses when NAV falls, and the entry simply runs the
 * other way.
 */
export function buildCarryEntry(
  base: Base,
  perLpCarry: Map<string, number>,
  capMap: CapitalAccountMap,
  gpCapitalAccountId: string,
  currency = 'USD',
  // The carry recipients and each one's PERCENT share (summing to 100). The total the LPs pay
  // is split across them here — the last recipient absorbs the rounding remainder so the credits
  // always tie to the total to the cent. Omit/empty → credit the pooled GP capital account (legacy).
  recipients?: { lpEntityId: string; pct: number }[] | null
): JournalEntry {
  let total = 0
  const postings: Posting[] = []
  for (const [lpEntityId, amt] of Array.from(perLpCarry.entries())) {
    if (amt === 0) continue
    total = roundCents(total + amt)
    postings.push(lpDebit(capMap, lpEntityId, amt, currency))
  }
  if (recipients && recipients.length > 0) {
    let allocated = 0
    recipients.forEach((r, i) => {
      const amt = i === recipients.length - 1 ? roundCents(total - allocated) : roundCents((total * r.pct) / 100)
      allocated = roundCents(allocated + amt)
      if (amt !== 0) postings.push(lpDebit(capMap, r.lpEntityId, roundCents(-amt), currency))
    })
  } else {
    postings.push({ accountId: gpCapitalAccountId, amount: roundCents(-total), currency, lpEntityId: null })
  }
  return finalize(base, 'carried_interest', postings)
}

/**
 * The GP/associate side of an equity-method markup: book, on the associate's OWN books, its share
 * of ONE line of the fund's performance (an unrealized gain, a realized gain, carried interest,
 * fees, …) — allocated to its members and marked onto its stake in the fund (Investment in Fund,
 * 1500). The `sourceType` sets which roll-forward bucket the members' capital lands in, so the
 * associate's books mirror the fund-book position line for line.
 *
 * For the associate, the fund's performance is INCOME: its 1500 marks up (or down), and that
 * change is allocated to its members' capital. So this debits the investment asset and credits
 * each member's capital (a credit is a negative debit-amount).
 *
 * `perMember` is each member's share of this line (already split — by ownership for capital lines,
 * by carry points for carried interest). Amounts may be negative — the mark reverses when the
 * fund's value falls (or a fee is borne), and the entry simply runs the other way.
 */
export function buildAssociateMarkupEntry(
  base: Base,
  perMember: Map<string, number>,
  capMap: CapitalAccountMap,
  investmentAccountId: string,
  sourceType: string,
  currency = 'USD',
): JournalEntry {
  let total = 0
  const postings: Posting[] = []
  for (const [lpEntityId, amt] of Array.from(perMember.entries())) {
    if (amt === 0) continue
    total = roundCents(total + amt)
    postings.push(lpDebit(capMap, lpEntityId, roundCents(-amt), currency))
  }
  // Debit Investment in Fund by the same total — the associate's stake marked up by this line.
  postings.push({ accountId: investmentAccountId, amount: roundCents(total), currency, lpEntityId: null })
  return finalize(base, sourceType, postings)
}

/** Back-compat: the carried-interest line specifically. Prefer `buildAssociateMarkupEntry`. */
export function buildAssociateCarryAccrualEntry(
  base: Base,
  perMemberCarry: Map<string, number>,
  capMap: CapitalAccountMap,
  investmentAccountId: string,
  currency = 'USD',
): JournalEntry {
  return buildAssociateMarkupEntry(base, perMemberCarry, capMap, investmentAccountId, 'carried_interest', currency)
}
