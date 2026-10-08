// Backfill: put a vehicle's whole investment history on the ledger, once, idempotently.
//
//   1. ADOPT what's posted. A QuickBooks import or a hand entry put investment value on the books
//      that no transaction owns; adoption reads it as the transactions it records (adoption.ts).
//      Reversal pairs net to zero and are left alone.
//   2. DERIVE what's missing. A transaction recorded before derivation existed has no entry;
//      it gets one, posted on its own date, exactly as a live save does.
//   3. POST what waits. The previous release drafted purchases and exits until a bank match; they
//      post now, and the open bank row that paid each is linked (investment-bank-match.ts).
//
// Running it twice books nothing twice: an owned entry is never adopted again, a transaction with
// a live derived or adopted entry is never derived again. In date order, because an exit's entry
// reads the carrying value earlier entries put there. See plans/spec-ledger-one-writer.md §1.

import type { SupabaseClient } from '@supabase/supabase-js'
import { draftEntryForTransaction, txnRef } from './from-portfolio'
import { postExistingEntryWithAllocation } from './continuous-allocation'
import { vehicleIdByName } from './vehicle-id'
import { readAll } from './bank-quickbooks-match'
import { ACTUAL_BOOK } from './books'
import { isInvestmentAccount, loadVehicleChart } from './investment-accounts'
import { adoptEntry, adoptedEntryIds } from './adoption'
import { derivedOwnedIds, linkOpenBankRow } from './investment-bank-match'
import { listVehiclesWithId } from './load'

const TXN_REF_PREFIX = txnRef('')
const REVERSAL_PREFIX = 'reversal:'
const CHUNK = 200

export interface BackfillResult {
  /** Posted entries on investment accounts that no transaction owns — what a run would adopt. */
  toAdopt: number
  /** Transactions with no entry — what a run would derive. */
  toDerive: number
  /** Already derived earlier, left alone. */
  alreadyDerived: number
  /** Derived entries still drafts (waiting for a bank match under the previous release). */
  toPost: number
  /** Transactions adopted by this run. */
  adopted: number
  /** Entries posted by this run, derived or waiting. */
  posted: number
  /** Bank rows linked to the waiting drafts this run posted. */
  linked: number
  /** Everything the ledger refused — an unreadable entry, a closed period — by name. */
  refused: string[]
  /**
   * Companies carried by BOTH sides: unowned posted entries on their investment accounts AND
   * tracker rows with no entry. A legacy replay, bootstrap, mark or QuickBooks import built those
   * entries from (or alongside) the tracker rows, so adopting one side and deriving the other
   * would book the position twice. Neither happens for these; they are reconciled by hand.
   */
  conflicted: string[]
}

export const emptyBackfillResult = (): BackfillResult =>
  ({ toAdopt: 0, toDerive: 0, alreadyDerived: 0, toPost: 0, adopted: 0, posted: 0, linked: 0, refused: [], conflicted: [] })

const n = (v: unknown) => { const x = Number(v); return Number.isFinite(x) ? x : 0 }
const chunks = <T,>(xs: T[]) => Array.from({ length: Math.ceil(xs.length / CHUNK) }, (_, i) => xs.slice(i * CHUNK, (i + 1) * CHUNK))

/**
 * Rows that can never derive an entry, so are never "waiting for the ledger". Mirrors the skips at
 * the top of buildEntryForTransaction; anything subtler is still derived and its reason reported.
 */
export function impliesNoEntry(t: any): boolean {
  if (t.transaction_type === 'round_info' || t.transaction_type === 'split') return true
  if (t.transaction_type === 'unrealized_gain_change') return n(t.unrealized_value_change) === 0 && n(t.fx_value_change) === 0
  if (t.transaction_type === 'investment' && !t.converts_from_txn_id) return n(t.investment_cost) + n(t.fee_amount) === 0
  if (t.transaction_type === 'income') return n(t.income_amount) === 0
  return false
}

export async function vehicleNames(admin: SupabaseClient, fundId: string, vehicleId: string, group: string): Promise<string[]> {
  // THROWS on a failed read: falling back to the bare name would hide alias transactions from the
  // conflict check, so their entries would be adopted and the alias rows derived too — twice.
  const { data, error } = await admin.from('fund_vehicles' as any).select('name, aliases').eq('fund_id', fundId).eq('id', vehicleId).maybeSingle()
  if (error) throw new Error(`The entity's names could not be read: ${error.message}`)
  const v = data as any
  return Array.from(new Set([v?.name ?? group, ...((v?.aliases as string[] | null) ?? [])].filter(Boolean)))
}

async function loadPending(admin: SupabaseClient, fundId: string, vehicleId: string, names: string[]) {
  const [txns, derived] = await Promise.all([
    readAll<any>((from, to) => admin.from('investment_transactions' as any).select('*')
      .eq('fund_id', fundId).in('portfolio_group', names).order('transaction_date').order('id').range(from, to)),
    readAll<any>((from, to) => admin.from('journal_entries' as any).select('id, status, source_ref, entry_date')
      .eq('book', ACTUAL_BOOK).eq('fund_id', fundId).eq('vehicle_id', vehicleId)
      .neq('status', 'void').like('source_ref', `${TXN_REF_PREFIX}%`).order('id').range(from, to)),
  ])
  const done = new Set(derived.map(e => e.source_ref as string))
  let alreadyDerived = 0
  const pending = txns.filter(t => {
    if (impliesNoEntry(t) || t.adopted_entry_id) return false
    if (done.has(txnRef(t.id))) { alreadyDerived++; return false }
    return true
  })
  return { txns, pending, alreadyDerived, drafts: derived.filter(e => e.status === 'draft') }
}

/** For the firm index: how many of this vehicle's transactions are not on the ledger. */
export async function countUnderived(admin: SupabaseClient, fundId: string, vehicleId: string, names: string[]): Promise<number> {
  return (await loadPending(admin, fundId, vehicleId, names)).pending.length
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** Reversal entries whose original is posted and paired with them (entryIsOwned's rule, in batch). */
async function ownedReversals(admin: SupabaseClient, fundId: string, entries: any[]): Promise<Set<string>> {
  const refs = entries.filter(e => String(e.source_ref ?? '').startsWith(REVERSAL_PREFIX) && UUID.test(String(e.source_ref).slice(REVERSAL_PREFIX.length)))
  const out = new Set<string>()
  if (refs.length === 0) return out
  const originals = new Map<string, any>()
  const originalIds = Array.from(new Set(refs.map(e => String(e.source_ref).slice(REVERSAL_PREFIX.length))))
  for (const ids of chunks(originalIds)) {
    const { data, error } = await admin.from('journal_entries' as any).select('id, status, reversed_by')
      .eq('book', ACTUAL_BOOK).eq('fund_id', fundId).in('id', ids)
    if (error) throw new Error(`Ownership could not be checked: ${error.message}`)
    for (const o of (data as any[]) ?? []) originals.set(o.id, o)
  }
  const priorIds = Array.from(new Set(Array.from(originals.values()).map(o => o.reversed_by).filter(Boolean) as string[]))
  const voided = new Set<string>()
  for (const ids of chunks(priorIds)) {
    const { data, error } = await admin.from('journal_entries' as any).select('id, status')
      .eq('book', ACTUAL_BOOK).eq('fund_id', fundId).in('id', ids)
    if (error) throw new Error(`Ownership could not be checked: ${error.message}`)
    for (const r of (data as any[]) ?? []) if (r.status === 'void') voided.add(r.id)
  }
  for (const e of refs) {
    const o = originals.get(String(e.source_ref).slice(REVERSAL_PREFIX.length))
    if (o && o.status === 'posted' && (o.reversed_by == null || o.reversed_by === e.id || voided.has(o.reversed_by))) out.add(e.id)
  }
  return out
}

/** Posted, unowned entries with a line on an investment account; reversal pairs excluded. */
async function unownedInvestmentEntries(admin: SupabaseClient, fundId: string, vehicleId: string, chart: Awaited<ReturnType<typeof loadVehicleChart>>) {
  const accountIds = chart.filter(isInvestmentAccount).map(a => a.id)
  const entryIds = new Set<string>()
  for (const ids of chunks(accountIds)) {
    const lines = await readAll<any>((from, to) => admin.from('journal_postings' as any).select('journal_entry_id')
      .eq('book', ACTUAL_BOOK).eq('fund_id', fundId).in('account_id', ids).order('id').range(from, to))
    for (const l of lines) entryIds.add(l.journal_entry_id)
  }
  const entries: any[] = []
  for (const ids of chunks(Array.from(entryIds))) {
    entries.push(...await readAll<any>((from, to) => admin.from('journal_entries' as any)
      .select('id, entry_date, memo, source_ref, reversed_by, journal_postings(account_id, amount)')
      .eq('book', ACTUAL_BOOK).eq('fund_id', fundId).eq('vehicle_id', vehicleId).eq('status', 'posted')
      .in('id', ids).order('id').range(from, to)))
  }
  const adopted = await adoptedEntryIds(admin, fundId, entries.map(e => e.id))
  // A reversed entry is half of a pair that nets to zero — unless its reversal was discarded.
  const reversalIds = entries.map(e => e.reversed_by).filter(Boolean) as string[]
  const liveReversals = new Set<string>()
  for (const ids of chunks(reversalIds)) {
    const { data, error } = await admin.from('journal_entries' as any).select('id').eq('book', ACTUAL_BOOK).eq('fund_id', fundId).in('id', ids).neq('status', 'void')
    // A failed read would make the original of a reversal pair look unowned → adopted as a purchase.
    if (error) throw new Error(`Ownership could not be checked: ${error.message}`)
    for (const r of (data as any[]) ?? []) liveReversals.add(r.id)
  }
  // Ownership by source_ref decides as entryIsOwned does: a txn: ref owns only while its
  // transaction exists (one batch implementation, shared with the bank match); a reversal: ref
  // owns while its original is posted and paired with it.
  const derivedOwned = await derivedOwnedIds(admin, fundId, entries)
  const reversalOwned = await ownedReversals(admin, fundId, entries)
  return entries
    .filter(e => {
      if (adopted.has(e.id) || derivedOwned.has(e.id) || reversalOwned.has(e.id)) return false
      if (e.reversed_by && liveReversals.has(e.reversed_by)) return false
      return true
    })
    .sort((a, b) => `${a.entry_date}${a.id}`.localeCompare(`${b.entry_date}${b.id}`))
}

export async function backfillDerivedEntries(
  admin: SupabaseClient, fundId: string, group: string, userId: string | null,
  opts: { dryRun?: boolean } = {},
): Promise<BackfillResult> {
  const out = emptyBackfillResult()
  const vehicleId = await vehicleIdByName(admin, fundId, group)
  if (!vehicleId) return out

  // 0. Which companies are carried by both sides? Read before anything is written.
  const chart = await loadVehicleChart(admin, fundId, vehicleId)
  const companyOfAccount = new Map(chart.filter(a => isInvestmentAccount(a) && a.companyId).map(a => [a.id, a.companyId as string]))
  const entryCompanies = (e: any) => new Set(((e.journal_postings ?? []) as any[])
    .filter(p => n(p.amount) !== 0 && companyOfAccount.has(p.account_id)).map(p => companyOfAccount.get(p.account_id) as string))
  const unowned = await unownedInvestmentEntries(admin, fundId, vehicleId, chart)
  const names = await vehicleNames(admin, fundId, vehicleId, group)
  const before = await loadPending(admin, fundId, vehicleId, names)
  const onLedger = new Map<string, number>()
  for (const e of unowned) for (const c of entryCompanies(e)) onLedger.set(c, (onLedger.get(c) ?? 0) + 1)
  const conflicted = new Set(before.pending.map(t => t.company_id as string).filter(c => onLedger.has(c)))
  const { data: companies, error: companiesError } = await admin.from('companies' as any).select('id, name').eq('fund_id', fundId)
  if (companiesError) throw new Error(`The holdings could not be read: ${companiesError.message}`)
  const nameOf = new Map(((companies as any[]) ?? []).map(c => [c.id as string, c.name as string]))
  out.conflicted = Array.from(conflicted).map(c => {
    const k = onLedger.get(c)!
    return `${nameOf.get(c) ?? 'Investment'}: carried by both the tracker and ${k} journal ${k === 1 ? 'entry' : 'entries'} — reconcile by hand`
  }).sort()

  // 1. Adopt — an entry touching any conflicted company is skipped whole. When it also carries a
  //    clean company, that company's value stays unowned with no tracker row behind it, and nothing
  //    else would ever flag it (it has no pending transactions): name every company it touches.
  const toAdopt: any[] = []
  for (const e of unowned) {
    const touched = Array.from(entryCompanies(e))
    const blocked = touched.filter(c => conflicted.has(c))
    if (blocked.length === 0) { toAdopt.push(e); continue }
    const clean = touched.filter(c => !conflicted.has(c))
    if (clean.length === 0) continue
    const names = (ids: string[]) => ids.map(c => nameOf.get(c) ?? 'Investment').sort().join(', ')
    out.refused.push(
      `Journal entry of ${e.entry_date}${e.memo ? ` "${e.memo}"` : ''} also carries ${names(clean)}; not adopted because `
      + `${names(blocked)} ${blocked.length === 1 ? 'is' : 'are'} carried by both — reconcile ${names(blocked)} by hand, then run this again.`,
    )
  }
  out.toAdopt = toAdopt.length
  if (!opts.dryRun) {
    for (const e of toAdopt) {
      const r = await adoptEntry(admin, fundId, {
        entryId: e.id, vehicleId, entryDate: e.entry_date, memo: e.memo ?? null, sourceRef: e.source_ref ?? null,
        postings: (e.journal_postings ?? []).map((p: any) => ({ accountId: p.account_id, amount: Number(p.amount) })),
      })
      if ('refused' in r) out.refused.push(`Journal entry of ${e.entry_date}${e.memo ? ` "${e.memo}"` : ''}: ${r.refused}`)
      else out.adopted += r.adoptedIds.length
    }
  }

  // 2. Derive — read AFTER adopting, so adopted transactions are not derived a second time.
  //    A conflicted company's rows are not derived either.
  const { txns, pending: allPending, alreadyDerived, drafts } = opts.dryRun ? before : await loadPending(admin, fundId, vehicleId, names)
  const pending = allPending.filter(t => !conflicted.has(t.company_id))
  out.toDerive = pending.length
  out.alreadyDerived = alreadyDerived
  out.toPost = drafts.length
  if (opts.dryRun) return out

  for (const t of pending) {
    const name = nameOf.get(t.company_id) ?? 'Investment'
    const r = await draftEntryForTransaction(admin, fundId, userId, { ...t, portfolio_group: group }, name)
    if (r.drafted && r.posted) out.posted++
    else if (r.reason) out.refused.push(`${name}, ${t.transaction_date}: ${r.reason}`)
  }

  // 3. Post what waits, and link the bank row that paid it.
  const txnById = new Map(txns.map(t => [t.id as string, t]))
  for (const e of drafts) {
    const t = txnById.get(String(e.source_ref).slice(TXN_REF_PREFIX.length))
    if (!t) { out.refused.push(`Draft entry of ${e.entry_date} belongs to a transaction that no longer exists — void it from the journal.`); continue }
    const r = await postExistingEntryWithAllocation(admin, fundId, group, userId, e.id)
    if ('error' in r) { out.refused.push(`${nameOf.get(t.company_id) ?? 'Investment'}, ${e.entry_date}: ${r.error}`); continue }
    out.posted++
    if (await linkOpenBankRow(admin, fundId, e.id)) out.linked++
  }
  return out
}

/** Every vehicle the caller can see (management companies excluded by listVehiclesWithId; GP entities hold no investments). */
export async function backfillAllVehicles(
  admin: SupabaseClient, fundId: string, userId: string | null, visible: string[] | null, opts: { dryRun?: boolean } = {},
): Promise<{ vehicle: string; result: BackfillResult }[]> {
  const vehicles = (await listVehiclesWithId(admin, fundId))
    .filter(v => v.kind !== 'associate' && (!visible || visible.includes(v.name)))
  const out: { vehicle: string; result: BackfillResult }[] = []
  for (const v of vehicles) {
    try {
      out.push({ vehicle: v.name, result: await backfillDerivedEntries(admin, fundId, v.name, userId, opts) })
    } catch (e) {
      out.push({ vehicle: v.name, result: { ...emptyBackfillResult(), refused: [`Could not be processed: ${e instanceof Error ? e.message : String(e)}`] } })
    }
  }
  return out
}
