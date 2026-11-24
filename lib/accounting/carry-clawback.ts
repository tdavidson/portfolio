import type { SupabaseClient } from '@supabase/supabase-js'
import { netOfTaxCap, type VehicleCarryTerms } from '@portfolio/fund-engine'
import type { CapitalPosting } from './capital-account'
import { roundCents } from './ledger'
import { accountIdByCode, ensureCapitalAccounts, persistEntry } from './persist'
import { ensureVehicleAccounts } from './provision-accounts'
import { loadPostedLedger } from './load'
import { CLAWBACK_RECEIVABLE_CODE } from './chart'
import type { JournalEntry, Posting } from './types'

/**
 * THE GP CLAWBACK AT FUND END, booked.
 *
 * The close accrues carry as a true-up to the GP's whole-fund entitlement at each period's NAV
 * (close.ts accrueCarry), so carry PAID early (an American waterfall, or an exit before later
 * losses) beyond that entitlement shows as a negative carry balance on the recipients' capital
 * accounts. At fund end that negative balance is what the GP owes back, and until now the
 * operator had to write the entry. Now a close through the vehicle's `fundEndDate` (or later)
 * books it: Dr 1370 Clawback receivable from GP / Cr each recipient's capital, source type
 * `carry_clawback` (the carried-interest line), so the recipients' carry nets to their
 * entitlement and the LPs' capital, which the accrual already left at their share, is backed by
 * the receivable. The GP's repayment later clears 1370 against cash.
 *
 * Measured from the ledger, per recipient: carry credited to them, less carry paid to them, less
 * any clawback already booked. Re-running a close books only what is still owed, so a re-close
 * or a later wind-down close does not book it twice; reopening the period voids it with the rest
 * of the close (it carries the close's source_ref). With `clawbackNetOfTaxRate` each recipient's
 * total give-back is capped at the carry it was paid less tax at that rate (the fund engine's
 * netOfTaxCap), as an LPA with a net-of-tax clawback provides.
 */
export const CLAWBACK_SOURCE = 'carry_clawback'
const CARRY_SOURCES = new Set(['carried_interest', 'carry', 'carry_distribution', CLAWBACK_SOURCE])

export interface ClawbackLine {
  lpEntityId: string
  /** Carry paid to this recipient, inception to date. */
  paid: number
  /** What its carry balance says it owes back (paid beyond what was credited). */
  owed: number
  /** The net-of-tax cap on its total give-back, when the terms set one. */
  cap?: number
  /** What this close books. */
  amount: number
}

/** Pure: what each carry recipient owes back, from their capital postings. */
export function clawbackFromPostings(
  postings: CapitalPosting[],
  recipientIds: string[],
  netOfTaxRate?: number,
): ClawbackLine[] {
  const out: ClawbackLine[] = []
  for (const id of recipientIds) {
    let balance = 0 // debit-positive: positive = paid out more than credited
    let paid = 0
    let clawed = 0
    for (const p of postings) {
      if (p.lpEntityId !== id || !CARRY_SOURCES.has(p.sourceType ?? '')) continue
      balance += p.amount
      if (p.sourceType === 'carry_distribution') paid += p.amount
      if (p.sourceType === CLAWBACK_SOURCE) clawed -= p.amount
    }
    const owed = roundCents(Math.max(0, balance))
    const cap = netOfTaxCap(roundCents(paid), netOfTaxRate)
    const room = cap === undefined ? owed : Math.max(0, roundCents(cap - clawed))
    const amount = roundCents(Math.min(owed, room))
    if (owed > 0 || amount > 0) out.push({ lpEntityId: id, paid: roundCents(paid), owed, ...(cap === undefined ? {} : { cap }), amount })
  }
  return out
}

/** Pure: the give-back entry. Null when nothing is owed. */
export function buildClawbackEntry(
  base: { fundId: string; entryDate: string; memo?: string },
  lines: ClawbackLine[],
  capMap: Map<string, string>,
  receivableAccountId: string,
): JournalEntry | null {
  const postings: Posting[] = []
  for (const l of lines) {
    if (!(l.amount > 0)) continue
    const capital = capMap.get(l.lpEntityId)
    if (!capital) throw new Error(`No capital account for carry recipient ${l.lpEntityId}`)
    postings.push({ accountId: receivableAccountId, amount: l.amount, currency: 'USD', lpEntityId: l.lpEntityId }) // Dr receivable from GP
    postings.push({ accountId: capital, amount: -l.amount, currency: 'USD', lpEntityId: l.lpEntityId })            // Cr recipient capital
  }
  if (postings.length === 0) return null
  return { fundId: base.fundId, entryDate: base.entryDate, memo: base.memo, sourceType: CLAWBACK_SOURCE, postings }
}

/**
 * The close's step: book what is still owed back, when this close reaches the fund's end. Runs
 * after the carry accrual, on the books as they then stand.
 */
export async function bookClawbackAtFundEnd(
  admin: SupabaseClient,
  fundId: string,
  group: string,
  userId: string | null,
  periodEnd: string,
  sourceRef: string,
  terms: VehicleCarryTerms,
): Promise<{ entryId?: string; lines?: ClawbackLine[] } | { error: string }> {
  if (!terms.fundEndDate || periodEnd < terms.fundEndDate) return {}
  const recipientIds = Array.from(new Set(terms.recipients.map(r => r.lpEntityId)))
  if (recipientIds.length === 0) return {}

  const { capitalPostings } = await loadPostedLedger(admin, fundId, group, periodEnd)
  const lines = clawbackFromPostings(capitalPostings, recipientIds, terms.clawbackNetOfTaxRate)
  if (!lines.some(l => l.amount > 0)) return { lines }

  let codes = await accountIdByCode(admin, fundId, group)
  if (!codes.has(CLAWBACK_RECEIVABLE_CODE)) {
    await ensureVehicleAccounts(admin, fundId, group)
    codes = await accountIdByCode(admin, fundId, group)
  }
  const receivableId = codes.get(CLAWBACK_RECEIVABLE_CODE)
  if (!receivableId) return { error: `The chart is missing account ${CLAWBACK_RECEIVABLE_CODE} Clawback receivable from GP — add it under the entity's Admin → Chart of accounts.` }
  const capMap = await ensureCapitalAccounts(admin, fundId, group, recipientIds)
  const total = roundCents(lines.reduce((s, l) => s + l.amount, 0))
  const entry = buildClawbackEntry(
    { fundId, entryDate: periodEnd, memo: `GP clawback at fund end (${terms.fundEndDate}): ${total} of carry paid beyond the entitlement, owed back` },
    lines, capMap, receivableId,
  )
  if (!entry) return { lines }
  entry.sourceRef = sourceRef // reopening the period voids it with the rest of the close
  const result = await persistEntry(admin, fundId, group, userId, entry, 'posted')
  if ('error' in result) return { error: result.error }
  return { entryId: result.entryId, lines }
}
