// Re-split a vehicle's posted entries across its partners again, from a date, under the partner
// terms and commitment history as they stand NOW.
//
// Why it exists: a partner allocation is worked out once, when its source entry posts, from the
// terms and commitments on that day. Fixing either afterwards (a partner made fee-exempt, a
// secondary transfer recorded with its real date) changes nothing already split. The only way to
// apply it used to be to unpost and repost every source entry one by one, which for a fund with a
// few years of history is hundreds of approvals, and people patched the capital accounts by hand
// instead.
//
// How: every source entry in the window that carries a generated allocation is re-split in date
// order through allocatePostedEntry, the same path posting uses. Before the first one, all of
// their allocations are set back to draft, so the rounding residuals each re-split carries come
// only from the entries re-split before it, exactly as if the history had been posted in order
// with today's terms. allocatePostedEntry already treats an all-draft allocation as stale: it
// deletes it and allocates afresh.
//
// The window must be open. A closed period is refused whole, before anything changes: reopen
// from the start date first and close again afterwards.
//
// Resumable: a run stops when its time budget is spent and returns a cursor. Until it is resumed
// with that cursor, the entries after it carry no posted allocation, so the partners' capital
// accounts are incomplete. Resume before reading them.

import type { SupabaseClient } from '@supabase/supabase-js'
import { ACTUAL_BOOK } from './books'
import { allocatePostedEntry } from './continuous-allocation'
import { fetchAllRows } from './load'
import { closedPeriodRanges, type PeriodRange } from './periods'
import type { JournalEntry } from './types'
import { vehicleIdByName } from './vehicle-id'

export const REALLOCATE_TIME_BUDGET_MS = 240_000

/** A source entry to re-split, in the order the re-split runs. */
export interface ReallocationSource {
  id: string
  entryDate: string
  createdAt: string
}

export interface ReallocateResult {
  vehicle: string
  from: string
  through: string | null
  /** Source entries re-split by this call. */
  reallocated: number
  /** Source entries still to re-split; 0 when the run is done. */
  remaining: number
  /** Pass back as `cursor` to carry on, while `remaining` > 0. */
  cursor: string | null
  done: boolean
}

/** Date order, then the order the entries were made, then id, so a run is repeatable. @internal Exported for tests. */
export function orderSources(sources: ReallocationSource[]): ReallocationSource[] {
  return sources.slice().sort((a, b) =>
    a.entryDate.localeCompare(b.entryDate) || a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id))
}

/** The cursor names the last entry re-split. @internal Exported for tests. */
export function cursorFor(source: ReallocationSource): string {
  return `${source.entryDate}|${source.createdAt}|${source.id}`
}

/** The sources still to re-split after a cursor (all of them without one). @internal Exported for tests. */
export function afterCursor(ordered: ReallocationSource[], cursor: string | null | undefined): ReallocationSource[] {
  if (!cursor) return ordered
  const index = ordered.findIndex(source => cursorFor(source) === cursor)
  if (index < 0) throw new Error('That cursor does not match this re-split. Start again without a cursor.')
  return ordered.slice(index + 1)
}

/** The closed periods a window touches. @internal Exported for tests. */
export function closedInWindow(closed: PeriodRange[], from: string, through: string | null): PeriodRange[] {
  return closed.filter(p => p.period_end >= from && (!through || p.period_start <= through))
}

const CHUNK = 200

function chunks<T>(items: T[]): T[][] {
  const out: T[][] = []
  for (let i = 0; i < items.length; i += CHUNK) out.push(items.slice(i, i + CHUNK))
  return out
}

export async function reallocateVehicle(
  admin: SupabaseClient,
  fundId: string,
  group: string,
  userId: string | null,
  input: { from: string; through?: string | null; cursor?: string | null; budgetMs?: number },
): Promise<ReallocateResult | { error: string; cursor?: string }> {
  const { from } = input
  const through = input.through || null
  if (!/^\d{4}-\d{2}-\d{2}$/.test(from ?? '')) return { error: 'from must be a date (YYYY-MM-DD)' }
  if (through && !/^\d{4}-\d{2}-\d{2}$/.test(through)) return { error: 'through must be a date (YYYY-MM-DD)' }
  if (through && through < from) return { error: 'through is before from' }
  const vehicleId = await vehicleIdByName(admin, fundId, group)
  if (!vehicleId) return { error: `Unknown vehicle "${group}"` }

  const locked = closedInWindow(await closedPeriodRanges(admin, fundId, group), from, through)
  if (locked.length > 0) {
    const first = locked.reduce((a, b) => (a.period_start < b.period_start ? a : b))
    return { error: `The window includes closed periods (the first starts ${first.period_start}). Reopen from ${from} first, then close again after the re-split.` }
  }

  // Every source entry with a generated allocation, then its header, kept when it is a posted
  // actual-book entry inside the window.
  let links: { source_entry_id: string; allocation_entry_id: string }[]
  try {
    links = await fetchAllRows<any>((f, t) => admin.from('journal_entry_allocations' as any)
      .select('id, source_entry_id, allocation_entry_id').eq('fund_id', fundId).eq('vehicle_id', vehicleId)
      .order('id', { ascending: true }).range(f, t))
  } catch (error) {
    return { error: `Could not read the allocations: ${(error as any)?.message ?? String(error)}` }
  }
  const allocationsBySource = new Map<string, Set<string>>()
  for (const link of links) {
    const set = allocationsBySource.get(link.source_entry_id) ?? new Set<string>()
    set.add(link.allocation_entry_id)
    allocationsBySource.set(link.source_entry_id, set)
  }
  const sources: ReallocationSource[] = []
  for (const ids of chunks(Array.from(allocationsBySource.keys()))) {
    let query = admin.from('journal_entries' as any).select('id, entry_date, created_at')
      .eq('book', ACTUAL_BOOK).eq('fund_id', fundId).eq('vehicle_id', vehicleId).eq('status', 'posted')
      .gte('entry_date', from).in('id', ids)
    if (through) query = query.lte('entry_date', through)
    const { data, error } = await query
    if (error) return { error: `Could not read the source entries: ${error.message}` }
    for (const row of (data as any[]) ?? []) sources.push({ id: row.id, entryDate: row.entry_date, createdAt: row.created_at })
  }
  const ordered = orderSources(sources)
  let pending: ReallocationSource[]
  try {
    pending = afterCursor(ordered, input.cursor)
  } catch (error) {
    return { error: (error as Error).message }
  }

  // A fresh run sets every allocation in the window back to draft first, so no re-split reads a
  // residual from an allocation that is about to be replaced.
  if (!input.cursor) {
    const allocationIds = ordered.flatMap(source => Array.from(allocationsBySource.get(source.id) ?? []))
    for (const ids of chunks(allocationIds)) {
      const { error } = await admin.from('journal_entries' as any).update({ status: 'draft', posted_at: null })
        .eq('book', ACTUAL_BOOK).eq('fund_id', fundId).in('id', ids)
      if (error) return { error: `Could not set the earlier allocations aside: ${error.message}` }
    }
  }

  const budget = input.budgetMs ?? REALLOCATE_TIME_BUDGET_MS
  const started = Date.now()
  let slowest = 0
  let done = 0
  let cursor: string | null = input.cursor ?? null
  for (const source of pending) {
    const elapsed = Date.now() - started
    if (done > 0 && elapsed + slowest * 2 > budget) break
    const t0 = Date.now()
    const { data: header, error: headerError } = await admin.from('journal_entries' as any)
      .select('entry_date, memo, source_type, source_ref').eq('book', ACTUAL_BOOK).eq('fund_id', fundId).eq('id', source.id).maybeSingle()
    const { data: rows, error: rowsError } = await admin.from('journal_postings' as any)
      .select('account_id, amount, currency, lp_entity_id').eq('book', ACTUAL_BOOK).eq('fund_id', fundId).eq('journal_entry_id', source.id)
    if (headerError || rowsError || !header) {
      return { error: `Stopped at the entry dated ${source.entryDate}: it could not be read. Resume with the cursor to carry on.`, ...resumeHint(cursor) }
    }
    const entry: JournalEntry = {
      fundId, entryDate: (header as any).entry_date, memo: (header as any).memo,
      sourceType: (header as any).source_type, sourceRef: (header as any).source_ref,
      postings: ((rows as any[]) ?? []).map(row => ({
        accountId: row.account_id as string, amount: Number(row.amount), currency: row.currency, lpEntityId: row.lp_entity_id,
      })),
    }
    const result = await allocatePostedEntry(admin, fundId, group, userId, source.id, entry)
    if ('error' in result) {
      return { error: `Stopped at the entry dated ${source.entryDate}: ${result.error}. Resume with the cursor to carry on.`, ...resumeHint(cursor) }
    }
    done += 1
    cursor = cursorFor(source)
    slowest = Math.max(slowest, Date.now() - t0)
  }

  const remaining = pending.length - done
  return { vehicle: group, from, through, reallocated: done, remaining, cursor: remaining > 0 ? cursor : null, done: remaining === 0 }
}

function resumeHint(cursor: string | null): { cursor?: string } {
  return cursor ? { cursor } : {}
}
