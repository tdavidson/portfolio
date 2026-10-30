/**
 * Loads what the Activity tab is built from, for a handful of an investor's entities, without
 * reading any vehicle's whole ledger.
 *
 * The overview builds the fund's full live report and every vehicle's ledger, which is far more
 * than one investor's history needs. Here everything starts from the investor's own capital
 * accounts: their postings, the entries those postings sit on, and their position statements.
 * The one exception is an imported (QuickBooks, Carta) entry, whose kind is read from all of its
 * lines (cashCapitalSource), so those entries' other lines are loaded too. The same
 * `assembleLoadedLedger` then turns the rows into capital postings, so a line here reads exactly as
 * it does in the capital accounts.
 *
 * Calls and distributions made in the app record the entry they posted, so a line from that entry
 * is linked to its notice. Anything booked or imported outside the app has no notice to link to.
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import { assembleLoadedLedger, fetchAllRows } from '@/lib/accounting/load'
import { toLpPosition } from '@/lib/accounting/lp-positions'
import { isExternalBookSource } from '@/lib/accounting/quickbooks/sources'
import { ACTUAL_BOOK } from '@/lib/accounting/books'
import { buildActivity, type ActivityLine, type NoticeLink, type VehicleActivityInput } from './activity'

const CHUNK = 200
const chunks = <T>(xs: T[]): T[][] => Array.from({ length: Math.ceil(xs.length / CHUNK) }, (_, i) => xs.slice(i * CHUNK, (i + 1) * CHUNK))

/** Every row of a paged query, run once per chunk of `ids` (long `in` lists overflow the URL). */
async function inChunks<T>(ids: string[], make: (ids: string[], from: number, to: number) => PromiseLike<{ data: T[] | null; error: unknown }>): Promise<T[]> {
  const out: T[] = []
  for (const part of chunks(ids)) out.push(...await fetchAllRows<T>((f, t) => make(part, f, t)))
  return out
}

export async function loadActivity(
  admin: SupabaseClient,
  fundIds: string[],
  entityNames: Map<string, string>,
): Promise<ActivityLine[]> {
  const db = admin as any
  const entityIds = Array.from(entityNames.keys())
  if (fundIds.length === 0 || entityIds.length === 0) return []

  // The investor's own capital accounts and statements say which vehicles they are in.
  const [capitalAccounts, positionRows] = await Promise.all([
    inChunks<any>(entityIds, (ids, f, t) => db.from('chart_of_accounts').select('id, fund_id, vehicle_id')
      .in('fund_id', fundIds).in('lp_entity_id', ids).order('id').range(f, t)),
    inChunks<any>(entityIds, (ids, f, t) => db.from('lp_positions')
      .select('id, lp_entity_id, as_of_date, commitment, called_capital, distributions, nav, irr, fund_id, vehicle_id')
      .in('fund_id', fundIds).in('lp_entity_id', ids).order('id').range(f, t)),
  ])
  const vehicleIds = Array.from(new Set([...capitalAccounts, ...positionRows].map(r => r.vehicle_id as string).filter(Boolean)))
  if (vehicleIds.length === 0) return []

  const accountIds = capitalAccounts.map(a => a.id as string)
  const [vehicles, ownPostings, notices] = await Promise.all([
    inChunks<any>(vehicleIds, (ids, f, t) => db.from('fund_vehicles').select('id, fund_id, name').in('id', ids).order('id').range(f, t)),
    inChunks<any>(accountIds, (ids, f, t) => db.from('journal_postings')
      .select('id, journal_entry_id, account_id, amount, currency, lp_entity_id, vehicle_id')
      .in('book', [ACTUAL_BOOK]).in('account_id', ids).order('id').range(f, t)),
    loadNoticeLinks(db, fundIds, entityIds),
  ])

  const entryIds = Array.from(new Set(ownPostings.map(p => p.journal_entry_id as string)))
  const entries = await inChunks<any>(entryIds, (ids, f, t) => db.from('journal_entries')
    .select('id, source_type, status, entry_date, memo, vehicle_id')
    .in('id', ids).eq('status', 'posted').in('book', [ACTUAL_BOOK]).order('id').range(f, t))

  // An imported entry is classified from all its lines, so load them. The chart is small next to a
  // ledger, and assembleLoadedLedger needs it to tell capital accounts from the rest.
  const imported = entries.filter(e => isExternalBookSource(e.source_type)).map(e => e.id as string)
  const [importedPostings, chart] = await Promise.all([
    inChunks<any>(imported, (ids, f, t) => db.from('journal_postings')
      .select('id, journal_entry_id, account_id, amount, currency, lp_entity_id, vehicle_id')
      .in('book', [ACTUAL_BOOK]).in('journal_entry_id', ids).order('id').range(f, t)),
    inChunks<any>(vehicleIds, (ids, f, t) => db.from('chart_of_accounts')
      .select('id, code, name, type, subtype, lp_entity_id, company_id, vehicle_id').in('vehicle_id', ids).order('id').range(f, t)),
  ])

  const seen = new Set<string>()
  const postingRows = [...ownPostings, ...importedPostings].filter(p => !seen.has(p.id) && seen.add(p.id))

  const inputs: VehicleActivityInput[] = []
  for (const v of vehicles) {
    const ledger = assembleLoadedLedger(v.fund_id, {
      acctRows: chart.filter(a => a.vehicle_id === v.id),
      entryRows: entries.filter(e => e.vehicle_id === v.id),
      postingRows: postingRows.filter(p => p.vehicle_id === v.id),
    })
    inputs.push({
      vehicle: v.name,
      postings: ledger.capitalPostings.filter(p => entityNames.has(p.lpEntityId)),
      positions: positionRows.filter(p => p.vehicle_id === v.id).map(toLpPosition),
    })
  }
  return buildActivity(inputs, entityNames, notices)
}

/** Each in-app call or distribution line of these entities, keyed by the entry it posted. */
async function loadNoticeLinks(db: any, fundIds: string[], entityIds: string[]): Promise<Map<string, NoticeLink>> {
  const [calls, dists] = await Promise.all([
    inChunks<any>(entityIds, (ids, f, t) => db.from('capital_call_lines')
      .select('id, lp_entity_id, capital_calls!inner(journal_entry_id, status)')
      .in('fund_id', fundIds).in('lp_entity_id', ids).order('id').range(f, t)),
    inChunks<any>(entityIds, (ids, f, t) => db.from('distribution_lines')
      .select('id, lp_entity_id, distributions!inner(journal_entry_id, status)')
      .in('fund_id', fundIds).in('lp_entity_id', ids).order('id').range(f, t)),
  ])
  const out = new Map<string, NoticeLink>()
  for (const l of calls) {
    const entry = l.capital_calls?.journal_entry_id
    if (entry && l.capital_calls.status !== 'draft') out.set(`${entry}|${l.lp_entity_id}`, { lineId: l.id, kind: 'capital_call' })
  }
  for (const l of dists) {
    const entry = l.distributions?.journal_entry_id
    if (entry && l.distributions.status !== 'draft') out.set(`${entry}|${l.lp_entity_id}`, { lineId: l.id, kind: 'distribution' })
  }
  return out
}
