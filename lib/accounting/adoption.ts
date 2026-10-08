// lib/accounting/adoption.ts
//
// Adoption at posting: the I/O around the pure reader (adopt.ts). Called by the two posting choke
// points — persistEntry and postExistingEntryWithAllocation — before an actual-book entry becomes
// `posted`, so the ownership trigger (supabase/pending-deploy/investment_ownership_trigger.sql)
// always finds an owner. See plans/spec-ledger-one-writer.md §1.
//
// THE LEDGER WINS. This writes investment_transactions (portfolio domain) on behalf of an
// accounting writer. That is deliberate: books must stay complete, and the rows simply stay hidden
// wherever the fund has `investments` switched off.
//
// THE VEHICLE NAME is fund_vehicles.name for the entry's vehicle_id — never the entry's stored
// portfolio_group, which goes stale after a rename. company_vehicles derives a holding's entities
// from investment_transactions.portfolio_group, so the name must resolve.

import type { SupabaseClient } from '@supabase/supabase-js'
import { loadVehicleChart } from './investment-accounts'
import { readInvestmentLines, touchesInvestmentAccounts } from './adopt'
import { vehicleNameById } from './vehicle-id'
import { ACTUAL_BOOK } from './books'

const TXN = 'txn:'
const REVERSAL = 'reversal:'

export interface AdoptArgs {
  entryId: string
  vehicleId: string
  entryDate: string
  memo: string | null
  sourceRef: string | null
  postings: { accountId: string; amount: number }[]
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

function checked<T>(res: { data: T; error: { message: string } | null }): T {
  if (res.error) throw new Error(`Ownership could not be checked: ${res.error.message}`)
  return res.data
}

/**
 * Mirrors public.investment_entry_owned, deliberately stricter: every lookup is fund-scoped and
 * journal reads are book = actual. A malformed txn:/reversal: suffix is simply not that kind of
 * ownership (as in the SQL's uuid guard). THROWS on a failed read — a failed read must never
 * look like "not owned", or adoption would duplicate an owned entry's transactions.
 */
export async function entryIsOwned(
  admin: SupabaseClient, fundId: string, entry: { id: string; sourceRef: string | null },
): Promise<boolean> {
  const ref = entry.sourceRef ?? ''
  if (ref.startsWith(TXN) && UUID.test(ref.slice(TXN.length))) {
    const data = checked(await admin.from('investment_transactions' as any)
      .select('id').eq('fund_id', fundId).eq('id', ref.slice(TXN.length)).maybeSingle() as any)
    if (data) return true
  }
  const adopted = checked(await admin.from('investment_transactions' as any)
    .select('id').eq('fund_id', fundId).eq('adopted_entry_id', entry.id).limit(1) as any)
  if (((adopted as any[]) ?? []).length > 0) return true
  if (ref.startsWith(REVERSAL) && UUID.test(ref.slice(REVERSAL.length))) {
    const original = checked(await admin.from('journal_entries' as any)
      .select('status, reversed_by').eq('book', ACTUAL_BOOK).eq('fund_id', fundId).eq('id', ref.slice(REVERSAL.length)).maybeSingle() as any)
    const o = original as any
    if (o && o.status === 'posted') {
      if (o.reversed_by == null || o.reversed_by === entry.id) return true
      // A reversal that was discarded (void) frees the original to be reversed again.
      const prior = checked(await admin.from('journal_entries' as any)
        .select('status').eq('book', ACTUAL_BOOK).eq('fund_id', fundId).eq('id', o.reversed_by).maybeSingle() as any)
      if ((prior as any)?.status === 'void') return true
    }
  }
  return false
}

/** Never throws: its callers are the posting choke points. */
export async function adoptEntry(
  admin: SupabaseClient, fundId: string, args: AdoptArgs,
): Promise<{ adoptedIds: string[] } | { refused: string }> {
  try {
    return await adoptEntryUnguarded(admin, fundId, args)
  } catch (e) {
    return { refused: `This entry was not posted: ${e instanceof Error ? e.message : String(e)}` }
  }
}

async function adoptEntryUnguarded(
  admin: SupabaseClient, fundId: string, args: AdoptArgs,
): Promise<{ adoptedIds: string[] } | { refused: string }> {
  // Callers are the posting choke points: never throw into them.
  let chart: Awaited<ReturnType<typeof loadVehicleChart>>
  try {
    chart = await loadVehicleChart(admin, fundId, args.vehicleId)
  } catch (e) {
    return { refused: `The chart of accounts could not be read, so this entry was not posted: ${e instanceof Error ? e.message : String(e)}` }
  }
  if (!touchesInvestmentAccounts(args.postings, chart)) return { adoptedIds: [] }
  if (await entryIsOwned(admin, fundId, { id: args.entryId, sourceRef: args.sourceRef })) return { adoptedIds: [] }

  const read = readInvestmentLines(args.postings, chart)
  if ('refused' in read) return read
  if (read.transactions.length === 0) return { adoptedIds: [] }

  const vehicle = await vehicleNameById(admin, fundId, args.vehicleId)
  if (!vehicle) return { refused: 'This entry\'s entity could not be found, so its investments have nowhere to be recorded.' }

  const label = args.memo ? `"${args.memo}"` : args.entryId
  const rows = read.transactions.map(t => ({
    ...t,
    fund_id: fundId,
    transaction_date: args.entryDate,
    portfolio_group: vehicle,
    adopted_entry_id: args.entryId,
    notes: `Adopted from journal entry ${label} (${args.entryDate}).`,
  }))
  const { data, error } = await admin.from('investment_transactions' as any).insert(rows).select('id')
  if (error) return { refused: `Its investment transactions could not be recorded: ${error.message}` }
  return { adoptedIds: ((data as any[]) ?? []).map(r => r.id as string) }
}

export async function removeAdopted(admin: SupabaseClient, fundId: string, ids: string[]): Promise<{ error?: string }> {
  if (ids.length === 0) return {}
  const { error } = await admin.from('investment_transactions' as any).delete().eq('fund_id', fundId).in('id', ids)
  return error ? { error: error.message } : {}
}

/** The message when adopted transactions could not be removed: the entry stays a draft. */
export function keptAsDraft(entryId: string, error: string): string {
  return `Its investment transactions could not be undone; entry ${entryId} was kept as a draft — void it from the journal. (${error})`
}

/**
 * This request adopted, then lost the compare-and-set flip to another request. If that other
 * request adopted too, its rows own the entry and ours are duplicates; if it adopted nothing
 * (it saw ours and found the entry owned), ours are what owns the posted entry — keep them.
 */
export async function settleLostRace(admin: SupabaseClient, fundId: string, entryId: string, mine: string[]): Promise<{ error?: string }> {
  if (mine.length === 0) return {}
  const { data, error } = await admin.from('investment_transactions' as any)
    .select('id').eq('fund_id', fundId).eq('adopted_entry_id', entryId)
  if (error) return { error: error.message }
  const others = ((data as any[]) ?? []).filter(r => !mine.includes(r.id))
  return others.length > 0 ? removeAdopted(admin, fundId, mine) : {}
}

/** Of these entries, the ones some investment transaction was adopted from. */
export async function adoptedEntryIds(admin: SupabaseClient, fundId: string, entryIds: string[]): Promise<Set<string>> {
  const out = new Set<string>()
  for (let i = 0; i < entryIds.length; i += 200) {
    const { data } = await admin.from('investment_transactions' as any)
      .select('adopted_entry_id').eq('fund_id', fundId).in('adopted_entry_id', entryIds.slice(i, i + 200))
    for (const r of (data as any[]) ?? []) if (r.adopted_entry_id) out.add(r.adopted_entry_id)
  }
  return out
}
