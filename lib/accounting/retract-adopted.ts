// lib/accounting/retract-adopted.ts
//
// Editing or deleting a transaction that was ADOPTED from a journal entry (spec §1). One adopted
// entry can own several transactions — a QuickBooks entry buying three companies — so the entry
// cannot simply be voided and re-derived for the one that changed. Instead:
//
//   1. build (write nothing) the entry each OTHER transaction would derive, and the entry THIS one
//      would have derived as it was BEFORE the edit, against the books without the adopted entry;
//   2. the remainder = the adopted entry − all of those. If it still holds investment value the
//      reader and the builder disagree about this entry: refuse before touching anything;
//   3. void the adopted entry (its allocation and bank link too), clear adopted_entry_id, post the
//      others' entries as their own txn: entries, and post a non-zero remainder;
//   4. the caller derives the edited transaction, as for any transaction.
//
// Subtracting the PRE-edit transaction is what leaves the books equal except for the edit.

import type { SupabaseClient } from '@supabase/supabase-js'
import { buildEntryForTransaction, type LedgerRetractResult } from './from-portfolio'
import { persistEntry } from './persist'
import { closedPeriodRanges, dateInAnyClosedPeriod } from './periods'
import { vehicleNameById } from './vehicle-id'
import { isInvestmentAccount, loadVehicleChart } from './investment-accounts'
import { setGeneratedAllocationStatus } from './continuous-allocation'
import { roundCents } from './ledger'
import { ACTUAL_BOOK } from './books'

const CANT_SPLIT = "This journal entry records several investments in a way that can't be split automatically. Reverse it from the journal and record its transactions again."

/**
 * Never throws into its caller: a throw before the entry is voided (a read error, a builder that
 * refuses an unknown entity) leaves the books untouched and is reported as a refusal; a throw
 * after it means the split happened but not everything was re-posted, reported as a warning.
 */
export async function retractAdoptedEntry(
  admin: SupabaseClient,
  fundId: string,
  args: { txnId: string; entryId: string; original: any; userId: string | null },
): Promise<LedgerRetractResult> {
  const state = { voided: false }
  try {
    return await split(admin, fundId, args, state)
  } catch (e) {
    const message = (e as Error)?.message ?? String(e)
    return state.voided
      ? { retracted: 1, warning: `The entry was split, but not everything could be re-posted: ${message}. Re-save the other transactions to put them back on the ledger.` }
      : { retracted: 0, reason: message }
  }
}

async function split(
  admin: SupabaseClient,
  fundId: string,
  args: { txnId: string; entryId: string; original: any; userId: string | null },
  state: { voided: boolean },
): Promise<LedgerRetractResult> {
  const clear = (ids: string[]) => admin.from('investment_transactions' as any)
    .update({ adopted_entry_id: null }).eq('fund_id', fundId).in('id', ids)

  const { data: row } = await admin.from('journal_entries' as any)
    .select('id, status, entry_date, memo, vehicle_id, portfolio_group, journal_postings(account_id, amount, lp_entity_id)')
    .eq('book', ACTUAL_BOOK).eq('fund_id', fundId).eq('id', args.entryId).maybeSingle()
  const entry = row as any
  if (!entry || entry.status !== 'posted') {
    await clear([args.txnId])
    return { retracted: 0 }
  }

  const group: string = (await vehicleNameById(admin, fundId, entry.vehicle_id)) ?? entry.portfolio_group
  const closed = await closedPeriodRanges(admin, fundId, group)
  if (dateInAnyClosedPeriod(closed, entry.entry_date)) {
    return { retracted: 0, reason: `Its journal entry is dated ${entry.entry_date}, inside a closed period. Reopen the period to change it — the tracker and the ledger would otherwise disagree.` }
  }

  const { data: owned } = await admin.from('investment_transactions' as any)
    .select('*').eq('fund_id', fundId).eq('adopted_entry_id', args.entryId)
  const siblings = ((owned as any[]) ?? []).filter(t => t.id !== args.txnId)
    .sort((a, b) => `${a.transaction_date}${a.id}`.localeCompare(`${b.transaction_date}${b.id}`))
  const companyIds = Array.from(new Set([...siblings.map(t => t.company_id), args.original.company_id]))
  const { data: companies } = await admin.from('companies' as any).select('id, name, holding_type').eq('fund_id', fundId).in('id', companyIds)
  const nameOf = (id: string) => ((companies as any[]) ?? []).find(c => c.id === id)?.name ?? 'Investment'

  // 1. Build, writing nothing.
  const without = { excludeEntryIds: [args.entryId] }
  const rebuilt: { txn: any; entry: any }[] = []
  for (const t of siblings) {
    const b = await buildEntryForTransaction(admin, fundId, { ...t, portfolio_group: group }, nameOf(t.company_id), without)
    if ('skip' in b) return { retracted: 0, reason: `${nameOf(t.company_id)}: ${b.skip.reason ?? CANT_SPLIT}` }
    rebuilt.push({ txn: t, entry: b.entry })
  }
  const own = await buildEntryForTransaction(admin, fundId, { ...args.original, portfolio_group: group }, nameOf(args.original.company_id), without)
  if ('skip' in own) return { retracted: 0, reason: CANT_SPLIT }

  // 2. The remainder, per account and partner.
  const net = new Map<string, number>()
  const add = (accountId: string, lp: string | null, amount: number) => {
    const key = `${accountId}|${lp ?? ''}`
    net.set(key, roundCents((net.get(key) ?? 0) + amount))
  }
  for (const p of entry.journal_postings ?? []) add(p.account_id, p.lp_entity_id ?? null, Number(p.amount))
  for (const e of [...rebuilt.map(r => r.entry), own.entry]) for (const p of e.postings) add(p.accountId, p.lpEntityId ?? null, -p.amount)
  const remainder = Array.from(net).filter(([, amount]) => amount !== 0).map(([key, amount]) => {
    const [accountId, lp] = key.split('|')
    return { accountId, lpEntityId: lp || null, amount, currency: 'USD' }
  })
  const chart = new Map((await loadVehicleChart(admin, fundId, entry.vehicle_id)).map(a => [a.id, a]))
  if (remainder.some(p => { const a = chart.get(p.accountId); return !!a && isInvestmentAccount(a) })) {
    return { retracted: 0, reason: CANT_SPLIT }
  }

  // 3. Void, clear, re-post.
  const allocation = await setGeneratedAllocationStatus(admin, fundId, args.entryId, 'void')
  if (allocation.error) return { retracted: 0, reason: `Its partner allocation could not be voided: ${allocation.error}` }
  await admin.from('bank_transactions' as any).update({ journal_entry_id: null, status: 'unmatched' })
    .eq('fund_id', fundId).eq('journal_entry_id', args.entryId)
  await admin.from('journal_entries' as any).update({ status: 'void', posted_at: null }).eq('id', args.entryId).eq('fund_id', fundId)
  state.voided = true
  await clear([args.txnId, ...siblings.map(t => t.id)])

  const failures: string[] = []
  for (const { txn, entry: e } of rebuilt) {
    const r = await persistEntry(admin, fundId, group, args.userId, e, 'posted')
    if ('error' in r) failures.push(`${nameOf(txn.company_id)}: ${r.error}`)
  }
  if (remainder.length > 0) {
    const r = await persistEntry(admin, fundId, group, args.userId, {
      fundId, entryDate: entry.entry_date, sourceType: 'manual', sourceRef: `adopted-remainder:${args.entryId}`,
      memo: `Remainder of ${entry.memo ? `"${entry.memo}"` : 'an adopted entry'} after its investments were split out`,
      postings: remainder,
    }, 'posted')
    if ('error' in r) failures.push(`the rest of the entry: ${r.error}`)
  }
  return failures.length
    ? { retracted: 1, warning: `The entry was split, but ${failures.join('; ')}. Re-save those transactions to put them back on the ledger.` }
    : { retracted: 1 }
}
