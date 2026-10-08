// lib/accounting/ownership.ts
//
// Acting on an OWNED entry in the journal — voiding, unposting, editing or reversing it — is
// deleting the investment transactions that own it (plans/spec-ledger-one-writer.md §1, "Owned
// entries in the journal"). Otherwise the tracker keeps a transaction the books no longer carry,
// and a reversal of a purchase would be adopted as an exit at cost.

import type { SupabaseClient } from '@supabase/supabase-js'
import { ACTUAL_BOOK } from './books'
import { entryIsOwned } from './adoption'
import { isInvestmentAccount, loadVehicleChart } from './investment-accounts'

const TXN = 'txn:'
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const ownersUnread = (e: { message: string }) => new Error(`The investment transactions that own this entry could not be read, so nothing was changed. Try again. (${e.message})`)

export interface OwningTransaction { id: string; companyId: string; company: string; type: string; date: string | null }

/**
 * The transactions that own this entry. THROWS on a failed read: "owns nothing" would let a void,
 * unpost, reverse or edit go ahead and delete nothing, leaving the tracker with a transaction the
 * books no longer carry (entryIsOwned, derivedOwnedIds and ownedReversals throw the same way).
 */
export async function owningTransactions(
  admin: SupabaseClient, fundId: string, entry: { id: string; source_ref: string | null },
): Promise<OwningTransaction[]> {
  const ref = entry.source_ref ?? ''
  const derivedId = ref.startsWith(TXN) && UUID.test(ref.slice(TXN.length)) ? ref.slice(TXN.length) : null
  const [adopted, derived] = await Promise.all([
    admin.from('investment_transactions' as any).select('id, company_id, transaction_type, transaction_date')
      .eq('fund_id', fundId).eq('adopted_entry_id', entry.id),
    derivedId
      ? admin.from('investment_transactions' as any).select('id, company_id, transaction_type, transaction_date')
          .eq('fund_id', fundId).eq('id', derivedId)
      : Promise.resolve({ data: [] as any[], error: null }),
  ])
  if (adopted.error) throw ownersUnread(adopted.error)
  if (derived.error) throw ownersUnread(derived.error)
  const rows = [...((derived.data as any[]) ?? []), ...((adopted.data as any[]) ?? [])]
  if (rows.length === 0) return []
  const { data: companies, error } = await admin.from('companies' as any).select('id, name')
    .eq('fund_id', fundId).in('id', Array.from(new Set(rows.map(r => r.company_id))))
  if (error) throw ownersUnread(error)
  const name = new Map(((companies as any[]) ?? []).map(c => [c.id as string, c.name as string]))
  return rows.map(r => ({
    id: r.id, companyId: r.company_id, company: name.get(r.company_id) ?? 'Investment',
    type: r.transaction_type, date: r.transaction_date ?? null,
  }))
}

type Entry = { id: string; source_ref: string | null }
export interface OwnershipPlan { removed: OwningTransaction[]; unlinked: string[] }

/** Read-only: who owns the entry, whether deleting them is allowed, and which register rows lose a link. */
export async function planRelease(
  admin: SupabaseClient, fundId: string, entry: Entry,
): Promise<OwnershipPlan | { error: string }> {
  // Every read here fails CLOSED: refuse the void/unpost/reverse/edit rather than delete nothing.
  let removed: OwningTransaction[]
  try {
    removed = await owningTransactions(admin, fundId, entry)
  } catch (e) {
    return { error: e instanceof Error ? e.message : String(e) }
  }
  if (removed.length === 0) return { removed, unlinked: [] }
  const ids = removed.map(t => t.id)

  // A conversion's basis is its source instrument; deleting the source would orphan it.
  const { data: dependents, error: depError } = await admin.from('investment_transactions' as any)
    .select('id').eq('fund_id', fundId).in('converts_from_txn_id', ids)
  if (depError) return { error: ownersUnread(depError).message }
  if (((dependents as any[]) ?? []).length > 0) {
    return { error: 'A conversion on this company converts from a transaction this entry records. Delete or re-point the conversion first.' }
  }

  // The register keeps its rows; they only lose the link (on delete set null). Say which.
  const [events, navs] = await Promise.all([
    admin.from('fund_capital_events' as any).select('kind, event_date').eq('fund_id', fundId).in('investment_transaction_id', ids),
    admin.from('fund_nav_statements' as any).select('as_of_date').eq('fund_id', fundId).in('investment_transaction_id', ids),
  ])
  if (events.error) return { error: ownersUnread(events.error).message }
  if (navs.error) return { error: ownersUnread(navs.error).message }
  const unlinked = [
    ...((events.data as any[]) ?? []).map(e => `the ${e.kind} of ${e.event_date}`),
    ...((navs.data as any[]) ?? []).map(n => `the NAV as of ${n.as_of_date}`),
  ]
  return { removed, unlinked }
}

/**
 * A failure from deleteOwners or releaseOwnership. `removed`/`unlinked` say what was deleted
 * before it failed — empty when nothing was, the whole plan when only the source_ref clear failed.
 */
export interface ReleaseFailure { error: string; removed: OwningTransaction[]; unlinked: string[] }

/** The write step: delete the planned transactions and clear a derived entry's source_ref. */
export async function deleteOwners(
  admin: SupabaseClient, fundId: string, entry: Entry, plan: OwnershipPlan,
): Promise<ReleaseFailure | null> {
  if (plan.removed.length === 0) return null
  const { error } = await admin.from('investment_transactions' as any).delete()
    .eq('fund_id', fundId).in('id', plan.removed.map(t => t.id))
  if (error) return { error: `Its investment transactions could not be deleted: ${error.message}`, removed: [], unlinked: [] }
  if ((entry.source_ref ?? '').startsWith(TXN)) {
    const { error: refErr } = await admin.from('journal_entries' as any).update({ source_ref: null })
      .eq('book', ACTUAL_BOOK).eq('fund_id', fundId).eq('id', entry.id)
    if (refErr) return { error: `The investment transactions were deleted but the entry could not be unlinked: ${refErr.message}`, removed: plan.removed, unlinked: plan.unlinked }
  }
  return null
}

export async function releaseOwnership(
  admin: SupabaseClient, fundId: string, entry: Entry,
): Promise<OwnershipPlan | { error: string; removed?: OwningTransaction[]; unlinked?: string[] }> {
  const plan = await planRelease(admin, fundId, entry)
  if ('error' in plan) return plan
  const failed = await deleteOwners(admin, fundId, entry, plan)
  return failed ?? plan
}

// ─── Reversal pairs ──────────────────────────────────────────────────────────────────────────
//
// Reversing an owned entry deletes the original's owners only once the reversal is POSTED — a
// reversal saved as a draft changes nothing on the books, so the tracker must keep the
// transaction until the draft posts (postExistingEntryWithAllocation releases them then).

const REVERSAL = 'reversal:'
const readFailed = (e: { message: string }) => new Error(`Could not check whether this entry is half of a reversal pair: ${e.message}`)

export interface ReversedOriginal { original: Entry & { status: string; reversed_by: string | null }; plan: OwnershipPlan }

/**
 * When `entry` is a `reversal:<orig>` about to be posted and paired with a posted original, the
 * original's ownership plan (read-only). Null when the entry is not such a reversal or the
 * original owns nothing. An error when the owners could not be released (a dependent conversion).
 */
export async function planReversedOriginalRelease(
  admin: SupabaseClient, fundId: string, entry: { id: string; source_ref: string | null },
): Promise<ReversedOriginal | { error: string } | null> {
  const ref = entry.source_ref ?? ''
  if (!ref.startsWith(REVERSAL)) return null
  const originalId = ref.slice(REVERSAL.length)
  if (!UUID.test(originalId)) return null
  const { data, error } = await admin.from('journal_entries' as any).select('id, status, reversed_by, source_ref')
    .eq('book', ACTUAL_BOOK).eq('fund_id', fundId).eq('id', originalId).maybeSingle()
  if (error) return { error: `The reversed entry could not be read: ${error.message}` }
  const o = data as any
  if (!o || o.status !== 'posted' || (o.reversed_by != null && o.reversed_by !== entry.id)) return null
  const plan = await planRelease(admin, fundId, o)
  if ('error' in plan) return plan
  return plan.removed.length === 0 ? null : { original: o, plan }
}

/**
 * Is this entry one half of a LIVE reversal pair whose original carries investment value? The
 * original with a reversal that is not void, or a posted reversal whose original is posted.
 * Voiding or unposting either half would leave the other booking a position the tracker no
 * longer holds (or holding one the books no longer carry): reverse the reversal instead.
 */
export async function isLiveInvestmentReversalHalf(
  admin: SupabaseClient, fundId: string, entry: { id: string; status: string; reversed_by: string | null; source_ref: string | null },
  investmentAccountIds: Set<string>,
): Promise<boolean> {
  // THROWS on a failed read: a guard that cannot read must not read as "not a pair".
  let originalId: string | null = null
  if (entry.reversed_by) {
    const { data, error } = await admin.from('journal_entries' as any).select('status')
      .eq('book', ACTUAL_BOOK).eq('fund_id', fundId).eq('id', entry.reversed_by).maybeSingle()
    if (error) throw readFailed(error)
    if (data && (data as any).status !== 'void') originalId = entry.id
  }
  const ref = entry.source_ref ?? ''
  if (!originalId && entry.status === 'posted' && ref.startsWith(REVERSAL) && UUID.test(ref.slice(REVERSAL.length))) {
    const { data, error } = await admin.from('journal_entries' as any).select('id, status')
      .eq('book', ACTUAL_BOOK).eq('fund_id', fundId).eq('id', ref.slice(REVERSAL.length)).maybeSingle()
    if (error) throw readFailed(error)
    if (data && (data as any).status === 'posted') originalId = (data as any).id
  }
  if (!originalId) return false
  const { data: lines, error } = await admin.from('journal_postings' as any).select('account_id')
    .eq('book', ACTUAL_BOOK).eq('fund_id', fundId).eq('journal_entry_id', originalId)
  if (error) throw readFailed(error)
  return ((lines as any[]) ?? []).some(l => investmentAccountIds.has(l.account_id))
}

export const HALF_OF_A_PAIR = 'This entry is half of a reversal pair — reverse the reversal instead.'

/**
 * Does acting on this entry outside the journal touch investment value? True when investment
 * transactions own it (derived, adopted, or a paired reversal) or it is either half of a live
 * reversal pair on investment accounts. The bank page uses this to keep its Unpost / Ignore /
 * Restore off such entries: there, acting on the entry is deleting the transaction (spec §1),
 * which only the journal and the holding do. THROWS on a failed read.
 */
export async function entryCarriesInvestments(
  admin: SupabaseClient, fundId: string, vehicleId: string,
  entry: { id: string; status: string; reversed_by: string | null; source_ref: string | null },
): Promise<boolean> {
  if (await entryIsOwned(admin, fundId, { id: entry.id, sourceRef: entry.source_ref })) return true
  if (!entry.reversed_by && !(entry.source_ref ?? '').startsWith(REVERSAL)) return false
  const chart = await loadVehicleChart(admin, fundId, vehicleId)
  return isLiveInvestmentReversalHalf(admin, fundId, entry, new Set(chart.filter(isInvestmentAccount).map(a => a.id)))
}

export const BANK_ROW_IS_AN_INVESTMENT = "This row is an investment's payment. Change the transaction on the holding, or void the entry from the Journal."
