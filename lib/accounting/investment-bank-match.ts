// Investment entry ↔ bank row: the second half of "the books follow the investments".
//
// An entry derived from a tracker transaction that moves cash — a purchase, an exit, cash income —
// is drafted, not posted (see postsOnRecord in from-portfolio.ts). The bank import books the same
// wire from the bank feed, so posting both would give one payment two representations in the
// ledger. The draft waits here until someone says which bank row is the same payment; then the
// derived entry posts, the bank row reconciles to it, and the bank's own auto-draft is retired.
//
// SUGGESTED, NEVER APPLIED. Candidates are ranked, but a match is always a person's decision. And
// an amount that differs is refused rather than inferred: a partial match is an explicit decision
// with the remainder confirmed separate (the settlement-review precedent), never a guess from a
// close amount and a nearby date.
//
// A vehicle with no bank feed can never match, so `postWithoutBankMatch` posts the draft on an
// explicit decision and records who made it (journal_entries.bank_match_waived_*).

import type { SupabaseClient } from '@supabase/supabase-js'
import { accountIdByCode } from './persist'
import { vehicleIdByName } from './vehicle-id'
import { closedPeriodRanges, dateInAnyClosedPeriod } from './periods'
import { postExistingEntryWithAllocation } from './continuous-allocation'
import { ACTUAL_BOOK } from './books'
import { roundCents } from './ledger'
import { txnRef } from './from-portfolio'
import { readAll, CLEARING_DAYS } from './bank-quickbooks-match'
import { adoptedEntryIds } from './adoption'
import { underReview } from './bank-review'

const CASH = '1000'
const TXN_REF_PREFIX = txnRef('')

interface EntryRow { id: string; status: string; entry_date: string; source_ref: string | null }
interface BankRow { id: string; amount: number | string; txn_date: string; status: string; journal_entry_id: string | null; raw: any }

const money = (n: number) => n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
const sameAmount = (a: number, b: number) => Math.abs(a - b) < 0.005
const OPEN_BANK_STATUSES = ['unmatched', 'drafted']

/**
 * Why this entry cannot be matched to this bank row — or null when it can.
 *
 * `cash` is the entry's cash leg (signed like the bank: money out is negative). `claimedBy` is the
 * entry the bank row currently points at, if any: a bank-import auto-draft is fine to replace,
 * anything else means the payment is already accounted for.
 */
export function checkInvestmentMatch(args: {
  entry: Pick<EntryRow, 'status'>
  bank: Pick<BankRow, 'amount' | 'status' | 'raw'>
  cash: number
  claimedBy: { status: string; source_ref: string | null } | null
}): string | null {
  const { entry, bank, cash, claimedBy } = args
  if (entry.status !== 'draft') {
    return entry.status === 'posted' ? 'That entry is already posted.' : 'That entry was voided — re-save the transaction to derive it again.'
  }
  if (underReview(bank.raw)) return 'Review the QuickBooks match on the bank page before matching this transaction.'
  const claimedElsewhere = claimedBy && (claimedBy.status !== 'draft' || (claimedBy.source_ref ?? '').startsWith(TXN_REF_PREFIX))
  if (!OPEN_BANK_STATUSES.includes(bank.status) || claimedElsewhere) {
    return 'That bank transaction is already matched to another entry.'
  }
  const amount = roundCents(Number(bank.amount))
  if (!sameAmount(amount, cash)) {
    return `The bank transaction is ${money(amount)} and the entry's cash is ${money(cash)}. ` +
      'Only the same payment can be matched — record a partial payment as its own transaction.'
  }
  return null
}

/** Open bank rows of exactly this amount, nearest date first. */
export function rankBankCandidates<T extends Pick<BankRow, 'amount' | 'txn_date' | 'status' | 'raw'>>(
  cash: number, entryDate: string, rows: T[],
): T[] {
  const days = (d: string) => Math.abs(Date.parse(d) - Date.parse(entryDate)) / 86_400_000
  return rows
    .filter(r => OPEN_BANK_STATUSES.includes(r.status) && !underReview(r.raw) && sameAmount(roundCents(Number(r.amount)), cash))
    .sort((a, b) => days(a.txn_date) - days(b.txn_date))
}

export interface OwnedCashEntry { id: string; date: string; amount: number; memo: string; status: 'draft' | 'posted' }

const DAY = 86_400_000
const shift = (date: string, days: number) => new Date(Date.parse(date) + days * DAY).toISOString().slice(0, 10)

/**
 * Owned investment entries in this vehicle whose cash leg could be one of these bank rows: posted
 * ones, and derived drafts kept back when their partner allocation failed — those are linked, not
 * posted, so the wire is not booked twice when the draft posts later.
 */
export async function loadOwnedCashEntries(
  admin: SupabaseClient, fundId: string, vehicleId: string, cashId: string, dates: string[],
): Promise<OwnedCashEntry[]> {
  if (dates.length === 0) return []
  const sorted = [...dates].sort()
  const rows = await readAll<any>((from, to) => admin.from('journal_entries' as any)
    .select('id, entry_date, memo, status, source_ref, journal_postings(account_id, amount)')
    .eq('fund_id', fundId).eq('vehicle_id', vehicleId).eq('book', ACTUAL_BOOK).in('status', ['posted', 'draft'])
    .gte('entry_date', shift(sorted[0], -CLEARING_DAYS)).lte('entry_date', shift(sorted[sorted.length - 1], CLEARING_DAYS))
    .order('id').range(from, to))
  const adopted = await adoptedEntryIds(admin, fundId, rows.filter(e => e.status === 'posted').map(e => e.id))
  return rows.flatMap(e => {
    const derived = String(e.source_ref ?? '').startsWith(TXN_REF_PREFIX)
    if (!(derived || (e.status === 'posted' && adopted.has(e.id)))) return []
    const amount = roundCents((e.journal_postings ?? []).filter((p: any) => p.account_id === cashId).reduce((s: number, p: any) => s + Number(p.amount), 0))
    return amount === 0 ? [] : [{ id: e.id, date: e.entry_date, amount, memo: e.memo ?? '', status: e.status }]
  })
}

/** Same amount to the cent, within the clearing window, and not already linked to a bank row. */
export function ownedCandidates(row: { date: string; amount: number }, entries: OwnedCashEntry[], linked: Set<string>): OwnedCashEntry[] {
  return entries.filter(e => !linked.has(e.id) && sameAmount(e.amount, roundCents(row.amount)) && roundCents(row.amount) !== 0
    && Math.abs(Date.parse(e.date) - Date.parse(row.date)) <= CLEARING_DAYS * DAY)
}

/** The draft-or-posted entry this transaction derived, in this vehicle. Voided history is skipped. */
async function derivedEntry(admin: SupabaseClient, fundId: string, vehicleId: string, txnId: string): Promise<EntryRow | null> {
  const { data } = await admin.from('journal_entries' as any)
    .select('id, status, entry_date, source_ref')
    .eq('book', ACTUAL_BOOK).eq('fund_id', fundId).eq('vehicle_id', vehicleId)
    .eq('source_ref', txnRef(txnId)).neq('status', 'void')
  return ((data as any[]) ?? [])[0] ?? null
}

async function cashLeg(admin: SupabaseClient, fundId: string, cashId: string, entryId: string): Promise<number> {
  const { data } = await admin.from('journal_postings' as any)
    .select('account_id, amount')
    .eq('book', ACTUAL_BOOK).eq('fund_id', fundId).eq('journal_entry_id', entryId)
  return roundCents(((data as any[]) ?? []).filter(p => p.account_id === cashId).reduce((s, p) => s + Number(p.amount), 0))
}

/** Resolve the transaction, its vehicle and its derived entry — everything both actions need. */
async function resolve(admin: SupabaseClient, fundId: string, group: string, txnId: string) {
  const { data: txn } = await admin.from('investment_transactions' as any)
    .select('id, portfolio_group').eq('id', txnId).eq('fund_id', fundId).maybeSingle()
  if (!txn || (txn as any).portfolio_group !== group) return { error: 'Transaction not found' } as const
  const vehicleId = await vehicleIdByName(admin, fundId, group)
  if (!vehicleId) return { error: 'Unknown vehicle' } as const
  const entry = await derivedEntry(admin, fundId, vehicleId, txnId)
  if (!entry) return { error: 'This transaction has no journal entry to match — re-save it to derive one.' } as const
  const closed = await closedPeriodRanges(admin, fundId, group)
  if (dateInAnyClosedPeriod(closed, entry.entry_date)) {
    return { error: `That entry is dated ${entry.entry_date}, inside a closed period — reopen it first.` } as const
  }
  return { vehicleId, entry }
}

/**
 * Match a transaction's derived entry to the bank row that is the same payment, and post it.
 *
 * Order matters, because posting runs LP allocation in application code and cannot share one
 * database transaction with the bank update. So: claim the bank row with a compare-and-set (and
 * the unique index on journal_entry_id refuses a second claim of the entry), THEN post, and on a
 * failed post put the bank row back exactly as it was. Only after the post succeeds is the
 * bank's auto-draft deleted — a failed match therefore loses nothing.
 */
export async function matchInvestmentToBank(
  admin: SupabaseClient, fundId: string, group: string, userId: string | null, txnId: string, bankTxnId: string,
): Promise<{ ok: true; entryId: string; warning?: string } | { error: string }> {
  const r = await resolve(admin, fundId, group, txnId)
  if ('error' in r) return { error: r.error as string }
  const { vehicleId, entry } = r

  const { data: bank } = await admin.from('bank_transactions' as any)
    .select('id, amount, txn_date, status, journal_entry_id, raw')
    .eq('id', bankTxnId).eq('fund_id', fundId).eq('vehicle_id', vehicleId).maybeSingle() as { data: BankRow | null }
  if (!bank) return { error: 'Bank transaction not found' }

  let claimedBy: { status: string; source_ref: string | null } | null = null
  if (bank.journal_entry_id) {
    const { data } = await admin.from('journal_entries' as any)
      .select('status, source_ref').eq('book', ACTUAL_BOOK).eq('id', bank.journal_entry_id).eq('fund_id', fundId).maybeSingle()
    claimedBy = (data as any) ?? null
  }

  const codes = await accountIdByCode(admin, fundId, group)
  const cashId = codes.get(CASH)
  if (!cashId) return { error: `${group} is missing account 1000 (Cash).` }
  const cash = await cashLeg(admin, fundId, cashId, entry.id)

  const refused = checkInvestmentMatch({ entry, bank, cash, claimedBy })
  if (refused) return { error: refused }

  // Claim: only if the row is still exactly as we read it.
  const prior = { journal_entry_id: bank.journal_entry_id, status: bank.status }
  let claim = admin.from('bank_transactions' as any)
    .update({ journal_entry_id: entry.id, status: 'reconciled' })
    .eq('id', bank.id).eq('fund_id', fundId).eq('status', prior.status)
  claim = prior.journal_entry_id ? claim.eq('journal_entry_id', prior.journal_entry_id) : claim.is('journal_entry_id', null)
  const { data: claimed, error: claimError } = await claim.select('id')
  if (claimError) return { error: /duplicate|unique/i.test(claimError.message) ? 'That entry is already matched to another bank transaction.' : claimError.message }
  if (!((claimed as any[]) ?? []).length) return { error: 'That bank transaction changed while you were matching it — reload and try again.' }

  const posted = await postExistingEntryWithAllocation(admin, fundId, group, userId, entry.id)
  if ('error' in posted) {
    await admin.from('bank_transactions' as any).update(prior).eq('id', bank.id).eq('fund_id', fundId)
    return { error: posted.error }
  }

  // The bank import's own draft for this wire is now redundant: the derived entry is its booking.
  // If it cannot be deleted, the match still stands — but the orphan could be posted later and
  // book the wire twice, so say which entry to delete by hand.
  if (prior.journal_entry_id) {
    const { error } = await admin.from('journal_entries' as any).delete()
      .eq('id', prior.journal_entry_id).eq('fund_id', fundId).eq('status', 'draft')
    if (error) {
      return { ok: true, entryId: entry.id, warning: `Matched and posted, but the bank's own draft for this wire (${prior.journal_entry_id}) could not be deleted: ${error.message}. Delete it from the journal — posting it would book the payment twice.` }
    }
  }
  return { ok: true, entryId: entry.id }
}

/**
 * Post a derived entry with no bank match, on an explicit decision — for a vehicle that has no
 * bank feed. Recorded on the entry, never inferred from whether a bank account exists, so
 * connecting a feed later shows exactly which payments were booked without one.
 */
export async function postWithoutBankMatch(
  admin: SupabaseClient, fundId: string, group: string, userId: string | null, txnId: string,
): Promise<{ ok: true; entryId: string } | { error: string }> {
  const r = await resolve(admin, fundId, group, txnId)
  if ('error' in r) return { error: r.error as string }
  const { vehicleId, entry } = r
  if (entry.status !== 'draft') return { error: 'That entry is already posted.' }

  // The waiver is for a payment with NO bank row — a vehicle without a feed. When a row of exactly
  // this amount is open, it is the match: posting past it leaves that row's auto-draft to be
  // posted later, and the payment booked twice.
  const codes = await accountIdByCode(admin, fundId, group)
  const cashId = codes.get(CASH)
  if (cashId) {
    const cash = await cashLeg(admin, fundId, cashId, entry.id)
    const { data: open } = await admin.from('bank_transactions' as any)
      .select('id, amount, txn_date, status, raw')
      .eq('fund_id', fundId).eq('vehicle_id', vehicleId).in('status', OPEN_BANK_STATUSES)
    if (rankBankCandidates(cash, entry.entry_date, (open as any[]) ?? []).length > 0) {
      return { error: 'A bank transaction of the same amount is waiting to be matched — match it instead.' }
    }
  }

  const posted = await postExistingEntryWithAllocation(admin, fundId, group, userId, entry.id)
  if ('error' in posted) return { error: posted.error }
  await admin.from('journal_entries' as any)
    .update({ bank_match_waived_at: new Date().toISOString(), bank_match_waived_by: userId })
    .eq('id', entry.id).eq('fund_id', fundId)
  return { ok: true, entryId: entry.id }
}

export interface AwaitingMatch {
  txnId: string
  entryId: string
  entryDate: string
  memo: string | null
  /** Signed like the bank: money out is negative. */
  cash: number
  candidates: { id: string; amount: number; txnDate: string; description: string | null }[]
}

/**
 * Derived entries still waiting for their bank match, each with its suggested bank rows. This is
 * the exception report the schedule of investments' tie-out collapses to.
 */
export async function awaitingBankMatch(admin: SupabaseClient, fundId: string, group: string): Promise<AwaitingMatch[]> {
  const vehicleId = await vehicleIdByName(admin, fundId, group)
  if (!vehicleId) return []
  const codes = await accountIdByCode(admin, fundId, group)
  const cashId = codes.get(CASH)
  if (!cashId) return []

  const [{ data: entries }, { data: bankRows }] = await Promise.all([
    admin.from('journal_entries' as any)
      .select('id, entry_date, memo, source_ref, journal_postings(account_id, amount)')
      .eq('book', ACTUAL_BOOK).eq('fund_id', fundId).eq('vehicle_id', vehicleId)
      .eq('status', 'draft').like('source_ref', `${TXN_REF_PREFIX}%`)
      .order('entry_date', { ascending: true }).limit(500),
    admin.from('bank_transactions' as any)
      .select('id, amount, txn_date, description, status, journal_entry_id, raw')
      .eq('fund_id', fundId).eq('vehicle_id', vehicleId).in('status', OPEN_BANK_STATUSES).limit(2000),
  ])

  // A bank row an auto-draft holds is a candidate; one held by another derived draft is not.
  const derivedIds = new Set(((entries as any[]) ?? []).map(e => e.id))
  const open = ((bankRows as any[]) ?? []).filter(b => !b.journal_entry_id || !derivedIds.has(b.journal_entry_id))

  return ((entries as any[]) ?? []).flatMap(e => {
    const cash = roundCents((e.journal_postings ?? []).filter((p: any) => p.account_id === cashId).reduce((s: number, p: any) => s + Number(p.amount), 0))
    if (cash === 0) return []
    return [{
      txnId: String(e.source_ref).slice(TXN_REF_PREFIX.length),
      entryId: e.id,
      entryDate: e.entry_date,
      memo: e.memo,
      cash,
      candidates: rankBankCandidates(cash, e.entry_date, open).slice(0, 5)
        .map(b => ({ id: b.id, amount: Number(b.amount), txnDate: b.txn_date, description: b.description ?? null })),
    }]
  })
}

/** What the journal says when it refuses to post one of these. */
export const AWAITING_BANK_MATCH_REASON =
  'This entry waits for its bank match — match it on the bank page, or post it there without a bank match.'

/**
 * Of these entries, the ones the journal must NOT post directly: derived from a tracker row, moving
 * cash, and matched to no bank row. Posting one from the journal would skip the match, and the bank
 * import's own draft for the same wire could then be posted too — the payment booked twice. A
 * derived entry that a bank row already points at (matched, then unposted) is free to post again.
 */
export async function entriesAwaitingBankMatch(
  admin: SupabaseClient, fundId: string, group: string, entryIds: string[],
): Promise<Set<string>> {
  const held = new Set<string>()
  if (entryIds.length === 0) return held
  const cashId = (await accountIdByCode(admin, fundId, group)).get(CASH)
  if (!cashId) return held

  const { data: entries } = await admin.from('journal_entries' as any)
    .select('id, source_ref').eq('book', ACTUAL_BOOK).eq('fund_id', fundId).in('id', entryIds)
  const derived = ((entries as any[]) ?? []).filter(e => String(e.source_ref ?? '').startsWith(TXN_REF_PREFIX)).map(e => e.id as string)
  if (derived.length === 0) return held

  const [{ data: postings }, { data: linked }] = await Promise.all([
    admin.from('journal_postings' as any).select('journal_entry_id, account_id, amount')
      .eq('book', ACTUAL_BOOK).eq('fund_id', fundId).in('journal_entry_id', derived),
    admin.from('bank_transactions' as any).select('journal_entry_id').eq('fund_id', fundId).in('journal_entry_id', derived),
  ])
  const matched = new Set(((linked as any[]) ?? []).map(b => b.journal_entry_id))
  for (const id of derived) {
    if (matched.has(id)) continue
    const lines = ((postings as any[]) ?? []).filter(p => p.journal_entry_id === id)
    if (lines.some(p => p.account_id === cashId && roundCents(Number(p.amount)) !== 0)) held.add(id)
  }
  return held
}

/**
 * THE REVERSE OF THE IMPORT MATCH. An entry derived after its bank row arrived finds that row: one
 * open row (drafted or unmatched, not under review) in the same vehicle, same amount, within seven
 * days → claim it with a compare-and-set, reconcile it, and retire its auto-draft. Several or none
 * → nothing; the bank page lists the entry with its candidates.
 *
 * Runs from portfolio-domain routes, so a member with no accounting grant can link a bank row and
 * retire an auto-draft — in a vehicle they can already write, which is the point.
 */
export async function linkOpenBankRow(admin: SupabaseClient, fundId: string, entryId: string): Promise<string | null> {
  try {
    const { data: e } = await admin.from('journal_entries' as any)
      .select('id, vehicle_id, entry_date, status, journal_postings(account_id, amount)')
      .eq('book', ACTUAL_BOOK).eq('fund_id', fundId).eq('id', entryId).maybeSingle()
    const entry = e as any
    if (!entry || entry.status !== 'posted') return null
    const { data: cashAccount } = await admin.from('chart_of_accounts' as any)
      .select('id').eq('fund_id', fundId).eq('vehicle_id', entry.vehicle_id).eq('code', CASH).maybeSingle()
    if (!cashAccount) return null
    const cash = roundCents((entry.journal_postings ?? []).filter((p: any) => p.account_id === (cashAccount as any).id)
      .reduce((s: number, p: any) => s + Number(p.amount), 0))
    if (cash === 0) return null

    const { data: open } = await admin.from('bank_transactions' as any)
      .select('id, amount, txn_date, status, journal_entry_id, raw')
      .eq('fund_id', fundId).eq('vehicle_id', entry.vehicle_id).in('status', OPEN_BANK_STATUSES)
      .gte('txn_date', shift(entry.entry_date, -CLEARING_DAYS)).lte('txn_date', shift(entry.entry_date, CLEARING_DAYS))
    const sameCash = ((open as any[]) ?? []).filter(b => !underReview(b.raw) && sameAmount(roundCents(Number(b.amount)), cash))
    // A row an auto-draft holds is free to take; one another derived entry (or anything posted) holds is not.
    const holderIds = sameCash.map(b => b.journal_entry_id).filter(Boolean)
    const { data: holders } = holderIds.length
      ? await admin.from('journal_entries' as any).select('id, status, source_ref').eq('book', ACTUAL_BOOK).eq('fund_id', fundId).in('id', holderIds)
      : { data: [] }
    const holder = new Map(((holders as any[]) ?? []).map(h => [h.id as string, h]))
    const free = sameCash.filter(b => {
      if (!b.journal_entry_id) return true
      const h = holder.get(b.journal_entry_id)
      return !!h && h.status === 'draft' && !String(h.source_ref ?? '').startsWith(TXN_REF_PREFIX)
    })
    if (free.length !== 1) return null

    const bank = free[0]
    let claim = admin.from('bank_transactions' as any).update({ journal_entry_id: entryId, status: 'reconciled' })
      .eq('id', bank.id).eq('fund_id', fundId).eq('status', bank.status)
    claim = bank.journal_entry_id ? claim.eq('journal_entry_id', bank.journal_entry_id) : claim.is('journal_entry_id', null)
    const { data: claimed, error } = await claim.select('id')
    if (error || !((claimed as any[]) ?? []).length) return null
    if (bank.journal_entry_id) {
      await admin.from('journal_entries' as any).delete().eq('id', bank.journal_entry_id).eq('fund_id', fundId).eq('status', 'draft')
    }
    return bank.id
  } catch {
    return null
  }
}
