import type { SupabaseClient } from '@supabase/supabase-js'
import { listVehiclesWithId, listMancoVehicles, loadPostedLedger } from './load'
import { trialBalance, scheduleOfInvestments } from './statements'
import { ACTUAL_BOOK } from './books'
import { MANCO_KIND } from '@/lib/vehicle-kinds'

// The firm overview: one row per entity — fund, SPV, GP entity, individual, management company —
// with the state of its books. Where a preparer's "are we ready?" is answered for the whole firm
// at once instead of vehicle by vehicle.

export interface FirmVehicleRow {
  id: string | null
  name: string
  kind: string | null
  /** Latest closed period end, or null when nothing has been closed. */
  closedThrough: string | null
  /** The most recent posted entry, or null on an empty ledger. */
  lastEntryDate: string | null
  postedEntries: number
  draftEntries: number
  /** Bank rows nobody has categorised or reconciled yet. */
  openBankRows: number
  trialBalanced: boolean
  /** Total debits on the trial balance — the size of the books, as a sanity check. */
  totalDebits: number
  /** Whether the vehicle has any postings at all. */
  empty: boolean
  /** Cash on hand: the balance of every `cash`-subtype account (operating, reserve, …). */
  cash: number
  /** Investments at cost, from the ledger's investment control accounts. */
  investmentsAtCost: number
  /** Investments at carrying value — cost plus the mark plus FX. What the schedule of
   *  investments reports and what portfolio construction plans against. */
  investmentsAtValue: number
}

export interface FirmOverview {
  vehicles: FirmVehicleRow[]
  /** True when the caller may not see management companies, so their rows are omitted. */
  mancoOmitted: boolean
}

export async function loadFirmOverview(
  admin: SupabaseClient,
  fundId: string,
  opts: {
    includeManco: boolean
    /** Which entities the caller may see (entity access). Omitted = all — a server-side caller. */
    visible?: (vehicleId: string | null) => boolean
  },
): Promise<FirmOverview> {
  const vehicles = await listVehiclesWithId(admin, fundId)
  const mancos = opts.includeManco ? await listMancoVehicles(admin, fundId) : []
  const all: { id: string | null; name: string; kind: string | null }[] = [
    ...vehicles,
    ...mancos.map(m => ({ id: m.id, name: m.name, kind: MANCO_KIND as string })),
  ].filter(v => !opts.visible || opts.visible(v.id))

  const rows = await Promise.all(all.map(async v => {
    const ledger = await loadPostedLedger(admin, fundId, v.name)
    const tb = trialBalance(ledger.accounts, ledger.postings)
    // Net assets are only used for the percent-of-net-assets column, which no consumer of this
    // row reads, so 0 is passed rather than computing a balance sheet for every vehicle.
    const soi = scheduleOfInvestments(ledger.accounts, ledger.postings, 0)
    const cashIds = new Set(ledger.accounts.filter(a => a.subtype === 'cash').map(a => a.id))
    const cash = tb.rows.filter(row => cashIds.has(row.accountId)).reduce((sum, row) => sum + row.balance, 0)
    // Per-vehicle counts read by id where the vehicle is registered; a legacy name-only vehicle
    // has nothing to count against, so its counts read zero and its ledger still loads by name.
    const counts = v.id ? await vehicleCounts(admin, fundId, v.id) : { closedThrough: null, lastEntryDate: null, posted: 0, drafts: 0, openBank: 0 }
    return {
      id: v.id, name: v.name, kind: v.kind,
      closedThrough: counts.closedThrough,
      lastEntryDate: counts.lastEntryDate,
      postedEntries: counts.posted,
      draftEntries: counts.drafts,
      openBankRows: counts.openBank,
      trialBalanced: tb.balanced,
      totalDebits: tb.totalDebits,
      empty: ledger.postings.length === 0,
      cash,
      investmentsAtCost: soi.totalCost,
      investmentsAtValue: soi.totalFairValue,
    }
  }))

  return { vehicles: rows, mancoOmitted: !opts.includeManco }
}

async function vehicleCounts(admin: SupabaseClient, fundId: string, vehicleId: string) {
  const [{ data: periods }, { count: posted }, { count: drafts }, { data: last }, { count: openBank }] = await Promise.all([
    admin.from('fiscal_periods' as any).select('period_end').eq('fund_id', fundId).eq('vehicle_id', vehicleId).eq('status', 'closed'),
    admin.from('journal_entries' as any).select('id', { count: 'exact', head: true })
      .eq('book', ACTUAL_BOOK).eq('fund_id', fundId).eq('vehicle_id', vehicleId).eq('status', 'posted'),
    admin.from('journal_entries' as any).select('id', { count: 'exact', head: true })
      .eq('book', ACTUAL_BOOK).eq('fund_id', fundId).eq('vehicle_id', vehicleId).eq('status', 'draft'),
    admin.from('journal_entries' as any).select('entry_date')
      .eq('book', ACTUAL_BOOK).eq('fund_id', fundId).eq('vehicle_id', vehicleId).eq('status', 'posted')
      .order('entry_date', { ascending: false }).limit(1),
    admin.from('bank_transactions' as any).select('id', { count: 'exact', head: true })
      .eq('fund_id', fundId).eq('vehicle_id', vehicleId).in('status', ['unmatched', 'drafted']),
  ])
  const closedThrough = ((periods as any[]) ?? []).reduce<string | null>((max, p) => (max && max > p.period_end ? max : p.period_end), null)
  return {
    closedThrough,
    lastEntryDate: ((last as any[]) ?? [])[0]?.entry_date ?? null,
    posted: posted ?? 0,
    drafts: drafts ?? 0,
    openBank: openBank ?? 0,
  }
}
