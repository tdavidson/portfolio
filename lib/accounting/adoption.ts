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

/** Mirrors public.investment_entry_owned. Keep the two in step. */
export async function entryIsOwned(
  admin: SupabaseClient, fundId: string, entry: { id: string; sourceRef: string | null },
): Promise<boolean> {
  const ref = entry.sourceRef ?? ''
  if (ref.startsWith(TXN)) {
    const { data } = await admin.from('investment_transactions' as any)
      .select('id').eq('fund_id', fundId).eq('id', ref.slice(TXN.length)).maybeSingle()
    if (data) return true
  }
  const { data: adopted } = await admin.from('investment_transactions' as any)
    .select('id').eq('fund_id', fundId).eq('adopted_entry_id', entry.id).limit(1)
  if (((adopted as any[]) ?? []).length > 0) return true
  if (ref.startsWith(REVERSAL)) {
    const { data: original } = await admin.from('journal_entries' as any)
      .select('status, reversed_by').eq('book', ACTUAL_BOOK).eq('fund_id', fundId).eq('id', ref.slice(REVERSAL.length)).maybeSingle()
    const o = original as any
    if (o && o.status === 'posted') {
      if (o.reversed_by == null || o.reversed_by === entry.id) return true
      // A reversal that was discarded (void) frees the original to be reversed again.
      const { data: prior } = await admin.from('journal_entries' as any)
        .select('status').eq('book', ACTUAL_BOOK).eq('fund_id', fundId).eq('id', o.reversed_by).maybeSingle()
      if ((prior as any)?.status === 'void') return true
    }
  }
  return false
}

export async function adoptEntry(
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

export async function removeAdopted(admin: SupabaseClient, fundId: string, ids: string[]): Promise<void> {
  if (ids.length === 0) return
  await admin.from('investment_transactions' as any).delete().eq('fund_id', fundId).in('id', ids)
}

/**
 * This request adopted, then lost the compare-and-set flip to another request. If that other
 * request adopted too, its rows own the entry and ours are duplicates; if it adopted nothing
 * (it saw ours and found the entry owned), ours are what owns the posted entry — keep them.
 */
export async function settleLostRace(admin: SupabaseClient, fundId: string, entryId: string, mine: string[]): Promise<void> {
  if (mine.length === 0) return
  const { data } = await admin.from('investment_transactions' as any)
    .select('id').eq('fund_id', fundId).eq('adopted_entry_id', entryId)
  const others = ((data as any[]) ?? []).filter(r => !mine.includes(r.id))
  if (others.length > 0) await removeAdopted(admin, fundId, mine)
}
