// Investment entry ↔ bank row: reconciliation, after the fact.
//
// Every derived entry posts when recorded (plans/spec-ledger-one-writer.md §2). The bank is where
// the books are checked against the money: the import reconciles a row to the posted entry that
// is the same payment (bank-import.ts), deriving an entry links the open row that paid it
// (linkOpenBankRow), and what neither could decide is listed here — posted investments with no
// bank row, each with the rows of exactly its amount. Linking changes no posting.
//
// SUGGESTED, NEVER APPLIED when there is a choice. An amount that differs is refused, not inferred.

import type { SupabaseClient } from '@supabase/supabase-js'
import { accountIdByCode } from './persist'
import { vehicleIdByName } from './vehicle-id'
import { ACTUAL_BOOK } from './books'
import { roundCents } from './ledger'
import { txnRef } from './from-portfolio'
import { readAll, CLEARING_DAYS } from './bank-quickbooks-match'
import { adoptedEntryIds, entryIsOwned } from './adoption'
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
  if (entry.status !== 'posted') {
    return entry.status === 'void' ? 'That entry was voided.' : 'That entry is not posted yet — post it from the journal first.'
  }
  if (underReview(bank.raw)) return 'Review this bank transaction\'s suggested match on the bank page first.'
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

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/**
 * Entries whose `txn:<id>` ref names a transaction that exists in this fund — the same rule as
 * entryIsOwned, in one query. An orphaned ref (malformed suffix, transaction deleted) is not
 * ownership, so it is neither listed nor linkable. THROWS on a failed read.
 */
async function derivedOwnedIds(admin: SupabaseClient, fundId: string, entries: { id: string; source_ref: string | null }[]): Promise<Set<string>> {
  const byTxn = new Map<string, string[]>()
  for (const e of entries) {
    const ref = String(e.source_ref ?? '')
    if (!ref.startsWith(TXN_REF_PREFIX)) continue
    const txnId = ref.slice(TXN_REF_PREFIX.length)
    if (UUID.test(txnId)) byTxn.set(txnId, [...(byTxn.get(txnId) ?? []), e.id])
  }
  if (byTxn.size === 0) return new Set()
  const ids = Array.from(byTxn.keys())
  const found = new Set<string>()
  for (let i = 0; i < ids.length; i += 200) {
    const { data, error } = await admin.from('investment_transactions' as any).select('id')
      .eq('fund_id', fundId).in('id', ids.slice(i, i + 200))
    if (error) throw new Error(`Ownership could not be checked: ${error.message}`)
    for (const r of (data as any[]) ?? []) found.add(r.id as string)
  }
  return new Set(Array.from(byTxn.entries()).filter(([t]) => found.has(t)).flatMap(([, v]) => v))
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
  const derivedOwned = await derivedOwnedIds(admin, fundId, rows)
  return rows.flatMap(e => {
    if (!(derivedOwned.has(e.id) || (e.status === 'posted' && adopted.has(e.id)))) return []
    const amount = roundCents((e.journal_postings ?? []).filter((p: any) => p.account_id === cashId).reduce((s: number, p: any) => s + Number(p.amount), 0))
    return amount === 0 ? [] : [{ id: e.id, date: e.entry_date, amount, memo: e.memo ?? '', status: e.status }]
  })
}

/** Same amount to the cent, within the clearing window, and not already linked to a bank row. */
export function ownedCandidates(row: { date: string; amount: number }, entries: OwnedCashEntry[], linked: Set<string>): OwnedCashEntry[] {
  return entries.filter(e => !linked.has(e.id) && sameAmount(e.amount, roundCents(row.amount)) && roundCents(row.amount) !== 0
    && Math.abs(Date.parse(e.date) - Date.parse(row.date)) <= CLEARING_DAYS * DAY)
}

async function cashLeg(admin: SupabaseClient, fundId: string, cashId: string, entryId: string): Promise<number> {
  const { data } = await admin.from('journal_postings' as any)
    .select('account_id, amount')
    .eq('book', ACTUAL_BOOK).eq('fund_id', fundId).eq('journal_entry_id', entryId)
  return roundCents(((data as any[]) ?? []).filter(p => p.account_id === cashId).reduce((s, p) => s + Number(p.amount), 0))
}

/**
 * Link a posted investment entry to the bank row that is the same payment. A compare-and-set
 * claims the row (and the unique index on journal_entry_id refuses a second claim of the entry);
 * the bank's own auto-draft for the wire is then retired. Nothing is posted.
 */
export async function matchInvestmentToBank(
  admin: SupabaseClient, fundId: string, group: string, entryId: string, bankTxnId: string,
): Promise<{ ok: true; entryId: string; warning?: string } | { error: string }> {
  const vehicleId = await vehicleIdByName(admin, fundId, group)
  if (!vehicleId) return { error: 'Unknown vehicle' }
  const { data: e } = await admin.from('journal_entries' as any).select('id, status, source_ref')
    .eq('book', ACTUAL_BOOK).eq('fund_id', fundId).eq('vehicle_id', vehicleId).eq('id', entryId).maybeSingle()
  const entry = e as any
  if (!entry) return { error: 'Entry not found' }
  if (!(await entryIsOwned(admin, fundId, { id: entry.id, sourceRef: entry.source_ref ?? null }))) {
    return { error: 'Only an investment entry can be matched here. Use the bank row\'s own actions for anything else.' }
  }

  const { data: b } = await admin.from('bank_transactions' as any)
    .select('id, amount, txn_date, status, journal_entry_id, raw')
    .eq('id', bankTxnId).eq('fund_id', fundId).eq('vehicle_id', vehicleId).maybeSingle()
  const bank = b as BankRow | null
  if (!bank) return { error: 'Bank transaction not found' }

  let claimedBy: { status: string; source_ref: string | null } | null = null
  if (bank.journal_entry_id) {
    const { data } = await admin.from('journal_entries' as any)
      .select('status, source_ref').eq('book', ACTUAL_BOOK).eq('id', bank.journal_entry_id).eq('fund_id', fundId).maybeSingle()
    claimedBy = (data as any) ?? null
  }
  const cashId = (await accountIdByCode(admin, fundId, group)).get(CASH)
  if (!cashId) return { error: `${group} is missing account 1000 (Cash).` }
  const cash = await cashLeg(admin, fundId, cashId, entry.id)

  const refused = checkInvestmentMatch({ entry, bank, cash, claimedBy })
  if (refused) return { error: refused }

  const prior = { journal_entry_id: bank.journal_entry_id, status: bank.status }
  let claim = admin.from('bank_transactions' as any)
    .update({ journal_entry_id: entry.id, status: 'reconciled' })
    .eq('id', bank.id).eq('fund_id', fundId).eq('status', prior.status)
  claim = prior.journal_entry_id ? claim.eq('journal_entry_id', prior.journal_entry_id) : claim.is('journal_entry_id', null)
  const { data: claimed, error: claimError } = await claim.select('id')
  if (claimError) return { error: /duplicate|unique/i.test(claimError.message) ? 'That entry is already matched to another bank transaction.' : claimError.message }
  if (!((claimed as any[]) ?? []).length) return { error: 'That bank transaction changed while you were matching it — reload and try again.' }

  if (prior.journal_entry_id) {
    const { error } = await admin.from('journal_entries' as any).delete()
      .eq('id', prior.journal_entry_id).eq('fund_id', fundId).eq('status', 'draft')
    if (error) {
      return { ok: true, entryId: entry.id, warning: `Matched, but the bank's own draft for this wire (${prior.journal_entry_id}) could not be deleted: ${error.message}. Delete it from the journal — posting it would book the payment twice.` }
    }
  }
  return { ok: true, entryId: entry.id }
}

export interface UnbankedInvestment {
  entryId: string
  entryDate: string
  memo: string | null
  /** Signed like the bank: money out is negative. */
  cash: number
  candidates: { id: string; amount: number; txnDate: string; description: string | null }[]
}

/**
 * Posted investment entries with no bank row, each with its candidate rows — what reconciliation
 * has left. A vehicle with no bank feed lists nothing (there is nothing to reconcile against), and
 * entries dated before its first bank row are not listed (the feed never covered them).
 */
export async function unbankedInvestments(admin: SupabaseClient, fundId: string, group: string): Promise<UnbankedInvestment[]> {
  const vehicleId = await vehicleIdByName(admin, fundId, group)
  if (!vehicleId) return []
  const cashId = (await accountIdByCode(admin, fundId, group)).get(CASH)
  if (!cashId) return []
  const { data: first } = await admin.from('bank_transactions' as any).select('txn_date')
    .eq('fund_id', fundId).eq('vehicle_id', vehicleId).order('txn_date', { ascending: true }).limit(1)
  const since = ((first as any[]) ?? [])[0]?.txn_date as string | undefined
  if (!since) return []

  const [entries, linkedRows, { data: openRows }] = await Promise.all([
    readAll<any>((from, to) => admin.from('journal_entries' as any)
      .select('id, entry_date, memo, source_ref, journal_postings(account_id, amount)')
      .eq('book', ACTUAL_BOOK).eq('fund_id', fundId).eq('vehicle_id', vehicleId).eq('status', 'posted')
      .gte('entry_date', since).order('id').range(from, to)),
    readAll<any>((from, to) => admin.from('bank_transactions' as any).select('journal_entry_id')
      .eq('fund_id', fundId).eq('vehicle_id', vehicleId).not('journal_entry_id', 'is', null).order('id').range(from, to)),
    admin.from('bank_transactions' as any).select('id, amount, txn_date, description, status, journal_entry_id, raw')
      .eq('fund_id', fundId).eq('vehicle_id', vehicleId).in('status', OPEN_BANK_STATUSES).limit(2000),
  ])
  const linked = new Set(linkedRows.map(r => r.journal_entry_id as string))
  const adopted = await adoptedEntryIds(admin, fundId, entries.map(e => e.id))
  const derivedOwned = await derivedOwnedIds(admin, fundId, entries)
  const open = await freeOpenRows(admin, fundId, (openRows as any[]) ?? [])

  return entries
    .filter(e => !linked.has(e.id) && (derivedOwned.has(e.id) || adopted.has(e.id)))
    .flatMap(e => {
      const cash = roundCents((e.journal_postings ?? []).filter((p: any) => p.account_id === cashId).reduce((s: number, p: any) => s + Number(p.amount), 0))
      if (cash === 0) return []
      return [{
        entryId: e.id, entryDate: e.entry_date, memo: e.memo ?? null, cash,
        candidates: rankBankCandidates(cash, e.entry_date, open).slice(0, 5)
          .map(b => ({ id: b.id, amount: Number(b.amount), txnDate: b.txn_date, description: b.description ?? null })),
      }]
    })
    .sort((a, b) => a.entryDate.localeCompare(b.entryDate))
}

/** Open rows a match may take: no entry yet, or only a bank auto-draft (a non-derived draft). */
export async function freeOpenRows<T extends { journal_entry_id: string | null }>(admin: SupabaseClient, fundId: string, rows: T[]): Promise<T[]> {
  const holderIds = rows.map(b => b.journal_entry_id).filter(Boolean) as string[]
  if (holderIds.length === 0) return rows
  const { data } = await admin.from('journal_entries' as any).select('id, status, source_ref')
    .eq('book', ACTUAL_BOOK).eq('fund_id', fundId).in('id', holderIds)
  const holder = new Map(((data as any[]) ?? []).map(h => [h.id as string, h]))
  return rows.filter(b => {
    if (!b.journal_entry_id) return true
    const h = holder.get(b.journal_entry_id)
    return !!h && h.status === 'draft' && !String(h.source_ref ?? '').startsWith(TXN_REF_PREFIX)
  })
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
    const free = await freeOpenRows(admin, fundId, sameCash)
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
