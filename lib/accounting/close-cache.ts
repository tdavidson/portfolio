// A request-scoped read cache for the period close.
//
// WHY. Closing one month reads the vehicle's whole ledger six or seven times (the preview, the
// note-interest and carry accruals, the associate markup, the bank reconciliation, the close
// review) and serializes it once more for the snapshot. Every one of those reads pages through
// every posting since inception, a thousand rows a round trip, so a month on a book with tens of
// thousands of postings spent most of its 30-40 seconds re-downloading history that cannot have
// changed. A multi-year re-close paid that again for every month.
//
// WHAT CANNOT CHANGE. The database refuses any insert, update or delete of a journal entry or
// posting dated inside a CLOSED fiscal period of its vehicle (the period-lock triggers in
// 20260714000004_ledger_db_enforcement.sql), and a status change is an update, so an entry there
// can be neither posted, unposted nor voided. So once rows dated inside a run of closed periods
// have been read, they stay true for as long as those periods stay closed.
//
// HOW. Inside `withCloseCache`, the first ledger read is a full read, as before. The rows dated
// inside the longest run of contiguous closed periods are kept ("frozen"). Each later read fetches
// only the entries dated OUTSIDE the frozen window (up to the read's as-of date, and their
// postings), re-reads the closed periods alongside, and adds the frozen rows back, but only if
// every period behind them is still closed and unchanged (same id, range and closed_at). If any
// changed (a reopen, a re-close, from this request or any other), the frozen rows are dropped and
// the read is a full one again. A read therefore returns the rows a full read would have returned
// at that moment, in the same order (see readThrough and postingsOf).
//
// Each month of a close then reads one month of entries instead of the whole history, and the
// snapshot export does the same.
//
// Outside `withCloseCache` nothing here does anything: every loader behaves as it always has.

import { AsyncLocalStorage } from 'node:async_hooks'
import type { SupabaseClient } from '@supabase/supabase-js'
import { ACTUAL_BOOK } from './books'

interface ClosedPeriod {
  id: string
  period_start: string
  period_end: string
  closed_at: string | null
}

interface Window {
  start: string
  end: string
  /** The closed periods whose union is the window: if any changes, the window is no longer frozen. */
  periods: ClosedPeriod[]
}

interface Frozen<E, P> {
  window: Window
  /** Every closed period as of the read that left these rows, for growing the window next time. */
  seen: ClosedPeriod[]
  entries: E[]
  postings: P[]
}

interface Scope {
  vehicleIds: Map<string, Promise<string | null>>
  vehicleKinds: Map<string, Promise<string | null>>
  posted: Map<string, Frozen<any, any>>
  exported: Map<string, Frozen<any, never>>
  stats: CloseCacheStats
}

export interface CloseCacheStats {
  fullReads: number
  tailReads: number
}

const store = new AsyncLocalStorage<WeakMap<object, Scope>>()

/**
 * Run `fn` with the close's read cache on. Nested calls share the outer scope. The cache is keyed
 * by the admin client, so it never crosses requests (each request makes its own client) and ends
 * with `fn`.
 */
export function withCloseCache<T>(fn: () => Promise<T>): Promise<T> {
  if (store.getStore()) return fn()
  return store.run(new WeakMap(), fn)
}

function scopeFor(admin: SupabaseClient): Scope | null {
  const scopes = store.getStore()
  if (!scopes) return null
  let scope = scopes.get(admin as object)
  if (!scope) {
    scope = { vehicleIds: new Map(), vehicleKinds: new Map(), posted: new Map(), exported: new Map(), stats: { fullReads: 0, tailReads: 0 } }
    scopes.set(admin as object, scope)
  }
  return scope
}

/** Whether a close cache scope is active for this client. */
export function inCloseCache(): boolean {
  return !!store.getStore()
}

/** How many full and tail ledger reads the current scope made. @internal For tests. */
export function closeCacheStats(admin: SupabaseClient): CloseCacheStats | null {
  return scopeFor(admin)?.stats ?? null
}

/**
 * Memoize a per-name lookup (vehicle id, vehicle kind) for the scope. A close resolves the same
 * vehicle name dozens of times a month, one round trip each. A failed lookup is not kept.
 */
export function memoInScope<T extends string | null>(
  admin: SupabaseClient,
  which: 'vehicleIds' | 'vehicleKinds',
  key: string,
  load: () => Promise<T>,
): Promise<T> {
  const scope = scopeFor(admin)
  if (!scope) return load()
  const map = scope[which] as Map<string, Promise<T>>
  const hit = map.get(key)
  if (hit) return hit
  const p = load()
  map.set(key, p)
  p.catch(() => { if (map.get(key) === p) map.delete(key) })
  return p
}

function nextDay(iso: string): string {
  const d = new Date(`${iso}T00:00:00Z`)
  d.setUTCDate(d.getUTCDate() + 1)
  return d.toISOString().slice(0, 10)
}

/**
 * The runs of contiguous closed periods (a period starting the day after the previous one ends,
 * or overlapping it, continues the run). With `anchor`, the run that contains that date; without,
 * the longest run. Null when there is none.
 */
export function frozenWindow(periods: ClosedPeriod[], anchor?: string): Window | null {
  const sorted = [...periods].sort((a, b) => a.period_start < b.period_start ? -1 : a.period_start > b.period_start ? 1 : 0)
  const runs: Window[] = []
  for (const p of sorted) {
    const last = runs[runs.length - 1]
    if (last && p.period_start <= nextDay(last.end)) {
      if (p.period_end > last.end) last.end = p.period_end
      last.periods.push(p)
    } else {
      runs.push({ start: p.period_start, end: p.period_end, periods: [p] })
    }
  }
  if (anchor) return runs.find(r => r.start <= anchor && anchor <= r.end) ?? null
  const days = (w: Window) => Date.parse(w.end) - Date.parse(w.start)
  return runs.reduce<Window | null>((best, r) => (!best || days(r) > days(best) ? r : best), null)
}

const samePeriod = (a: ClosedPeriod, b: ClosedPeriod) =>
  a.id === b.id && a.period_start === b.period_start && a.period_end === b.period_end && (a.closed_at ?? null) === (b.closed_at ?? null)

/** Whether every period a window was built from is still closed, unchanged. */
function stillFrozen(window: Window, current: ClosedPeriod[]): boolean {
  return window.periods.every(p => current.some(c => samePeriod(p, c)))
}

async function loadClosedPeriods(admin: SupabaseClient, fundId: string, vehicleId: string): Promise<ClosedPeriod[]> {
  const { data, error } = await admin
    .from('fiscal_periods' as any)
    .select('id, period_start, period_end, closed_at')
    .eq('fund_id', fundId)
    .eq('vehicle_id', vehicleId)
    .eq('status', 'closed')
  if (error) throw error
  return ((data as any[]) ?? []).map(p => ({ id: p.id, period_start: p.period_start, period_end: p.period_end, closed_at: p.closed_at ?? null }))
}

const inWindow = (date: string | null | undefined, w: Window) => !!date && date >= w.start && date <= w.end

/**
 * The shared read: full the first time (or after the frozen periods changed), frozen + tail after.
 * `full()` reads everything; `tail(window)` reads only the entries dated outside the window (with
 * their postings). Returns the rows and keeps the newly frozen ones.
 *
 * A tail read and the closed-period read run side by side, to save a round trip. That is safe
 * because neither the check nor the growth trusts a period seen only now: the frozen rows are
 * used only if every period behind them is still closed, unchanged; and the window grows only
 * over periods that were already closed, unchanged, when the PREVIOUS read began, so the rows this
 * tail read brings into the window were written before those periods locked.
 */
async function readThrough<E extends { entry_date?: string | null; id: string }, P>(
  scope: Scope,
  cache: Map<string, Frozen<E, P>>,
  key: string,
  loadPeriods: () => Promise<ClosedPeriod[]>,
  asOf: string | undefined,
  full: () => Promise<{ entries: E[]; postings: P[] }>,
  tail: (w: Window) => Promise<{ before: E[]; after: E[]; postings: P[] }>,
  postingEntryId: (p: P) => string,
): Promise<{ entries: E[]; postings: P[] }> {
  const cached = cache.get(key)
  if (cached) {
    const [periods, t] = await Promise.all([loadPeriods(), tail(cached.window)])
    if (stillFrozen(cached.window, periods)) {
      scope.stats.tailReads++
      // The frozen rows are kept for every date in the window; the read gets those up to `asOf`.
      const frozenUpTo = asOf ? cached.entries.filter(e => !!e.entry_date && e.entry_date <= asOf) : cached.entries
      const frozenIds = asOf ? new Set(frozenUpTo.map(e => e.id)) : null
      const rows = {
        entries: [...t.before, ...frozenUpTo, ...t.after],
        postings: [...(frozenIds ? cached.postings.filter(p => frozenIds.has(postingEntryId(p))) : cached.postings), ...t.postings],
      }
      cache.set(key, grow(cached, periods, t, asOf, postingEntryId))
      return rows
    }
  }
  // Cold, or the periods behind the frozen rows changed: read it all, after the periods, so every
  // row dated in a period seen closed here was read after that period locked.
  const periods = await loadPeriods()
  scope.stats.fullReads++
  const rows = await full()
  const found = frozenWindow(periods)
  // A full read with `asOf` saw nothing later, so the window stops there.
  const window = found && asOf && asOf < found.end ? { ...found, end: asOf } : found
  if (window && window.start <= window.end) {
    const entries = rows.entries.filter(e => inWindow(e.entry_date, window))
    const ids = new Set(entries.map(e => e.id))
    cache.set(key, { window, seen: periods, entries, postings: rows.postings.filter(p => ids.has(postingEntryId(p))) })
  } else {
    cache.delete(key)
  }
  return rows
}

/** The frozen rows after a tail read: the window grown over periods closed before the previous read. */
function grow<E extends { entry_date?: string | null; id: string }, P>(
  cached: Frozen<E, P>,
  periods: ClosedPeriod[],
  t: { before: E[]; after: E[]; postings: P[] },
  asOf: string | undefined,
  postingEntryId: (p: P) => string,
): Frozen<E, P> {
  const settled = periods.filter(c => cached.seen.some(s => samePeriod(s, c)))
  const run = frozenWindow(settled, cached.window.start) ?? cached.window
  // As far as this read saw every row: up to `asOf`, and before the window only if `asOf` reaches it.
  const end = asOf && asOf < run.end ? (asOf > cached.window.end ? asOf : cached.window.end) : run.end
  const start = !asOf || asOf >= cached.window.start ? run.start : cached.window.start
  if (start >= cached.window.start && end <= cached.window.end) return { ...cached, seen: periods }
  const window: Window = { start, end, periods: run.periods }
  const isFresh = (e: E) => inWindow(e.entry_date, window)
  const freshIds = new Set([...t.before, ...t.after].filter(isFresh).map(e => e.id))
  return {
    window,
    seen: periods,
    entries: [...t.before.filter(isFresh), ...cached.entries, ...t.after.filter(isFresh)],
    postings: [...cached.postings, ...t.postings.filter(p => freshIds.has(postingEntryId(p)))],
  }
}

/** Entry ids per `in (...)` filter, kept well inside PostgREST's URL limit. */
const CHUNK = 200
/** Most entries whose postings are read by id; past this a full read of the postings is cheaper. */
const BY_ID_LIMIT = 4000
/** Chunked reads in flight at once. */
const PARALLEL = 4

async function inBatches<T, R>(items: T[], size: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = []
  for (let i = 0; i < items.length; i += size) out.push(...await Promise.all(items.slice(i, i + size).map(fn)))
  return out
}

async function pagedAll<T>(make: (from: number, to: number) => PromiseLike<{ data: T[] | null; error: unknown }>): Promise<T[]> {
  const out: T[] = []
  for (let from = 0; ; from += 1000) {
    const { data, error } = await make(from, from + 999)
    if (error) throw error
    out.push(...(data ?? []))
    if ((data ?? []).length < 1000) break
  }
  return out
}

/**
 * The posted actual-book entry and posting rows of a vehicle, every date, as loadPostedLedger reads
 * them, served from the close cache. Null outside a close scope (the caller reads as usual).
 */
export async function cachedPostedRows(
  admin: SupabaseClient,
  fundId: string,
  vehicleId: string | null,
  asOf?: string,
): Promise<{ entryRows: any[]; postingRows: any[] } | null> {
  const scope = scopeFor(admin)
  if (!scope || !vehicleId) return null
  const periods = () => loadClosedPeriods(admin, fundId, vehicleId)
  const entryQuery = () => {
    const q = admin.from('journal_entries' as any).select('id, source_type, status, entry_date, memo')
      .in('book', [ACTUAL_BOOK]).eq('fund_id', fundId).eq('vehicle_id', vehicleId).eq('status', 'posted')
    return asOf ? q.lte('entry_date', asOf) : q
  }
  const postingQuery = () => admin.from('journal_postings' as any).select('journal_entry_id, account_id, amount, currency, lp_entity_id')
    .in('book', [ACTUAL_BOOK]).eq('fund_id', fundId).eq('vehicle_id', vehicleId)
  // The postings of these entries. A few thousand entries are read by id, a few chunks at a time,
  // and put back in entry order (each entry's own postings keep the order they came in), which is
  // the order they were written in and so the order a full read returns them in. Past that, one
  // full read of the vehicle's postings is fewer round trips than the chunks.
  const postingsOf = async (ids: string[]) => {
    if (ids.length === 0) return []
    if (ids.length > BY_ID_LIMIT) {
      const wanted = new Set(ids)
      return (await pagedAll((f, t) => postingQuery().range(f, t))).filter(p => wanted.has(p.journal_entry_id))
    }
    const chunks: string[][] = []
    for (let i = 0; i < ids.length; i += CHUNK) chunks.push(ids.slice(i, i + CHUNK))
    const fetched = (await inBatches(chunks, PARALLEL, chunk => pagedAll((f, t) => postingQuery().in('journal_entry_id', chunk).range(f, t)))).flat()
    const position = new Map(ids.map((id, i) => [id, i]))
    return fetched
      .map((p, i) => ({ p, i }))
      .sort((a, b) => (position.get(a.p.journal_entry_id)! - position.get(b.p.journal_entry_id)!) || a.i - b.i)
      .map(x => x.p)
  }
  const rows = await readThrough<any, any>(
    scope, scope.posted, `${fundId}|${vehicleId}`, periods, asOf,
    async () => {
      if (!asOf) {
        const [entries, postings] = await Promise.all([
          pagedAll((f, t) => entryQuery().range(f, t)),
          pagedAll((f, t) => postingQuery().range(f, t)),
        ])
        return { entries, postings }
      }
      // Up to a date: the entries first, then only their postings. Postings carry no date, so the
      // uncached read pages through every posting the vehicle has, later ones included.
      const entries = await pagedAll((f, t) => entryQuery().range(f, t))
      return { entries, postings: await postingsOf(entries.map(e => e.id as string)) }
    },
    async w => {
      // Unordered, like the full read: the rows come back in the table's own order, so the tail keeps
      // the relative order a full read would have given it (the order the close meets categories in).
      const [before, after] = await Promise.all([
        pagedAll((f, t) => entryQuery().lt('entry_date', w.start).range(f, t)),
        pagedAll((f, t) => entryQuery().gt('entry_date', w.end).range(f, t)),
      ])
      return { before, after, postings: await postingsOf([...before, ...after].map(e => e.id as string)) }
    },
    p => p.journal_entry_id,
  )
  return { entryRows: rows.entries, postingRows: rows.postings }
}

/**
 * The snapshot export's rows (every non-void actual entry with its postings, oldest first, by
 * entry_date then id), on or before `end`, served from the close cache. Null outside a scope.
 */
export async function cachedExportEntries(
  admin: SupabaseClient,
  fundId: string,
  vehicleId: string | null,
  end: string | undefined,
): Promise<any[] | null> {
  const scope = scopeFor(admin)
  if (!scope || !vehicleId) return null
  const periods = () => loadClosedPeriods(admin, fundId, vehicleId)
  const query = () => {
    const q = admin
      .from('journal_entries' as any)
      .select('id, entry_date, memo, source_type, source_ref, status, journal_postings(account_id, amount, currency)')
      .eq('book', ACTUAL_BOOK)
      .eq('fund_id', fundId)
      .eq('vehicle_id', vehicleId)
      .neq('status', 'void')
    return end ? q.lte('entry_date', end) : q
  }
  // The same stable, unique order loadExportEntries pages in.
  const ordered = (q: any) => q.order('entry_date', { ascending: true }).order('id', { ascending: true })
  const rows = await readThrough<any, never>(
    scope, scope.exported, `${fundId}|${vehicleId}`, periods, end,
    async () => ({ entries: await pagedAll((f, t) => ordered(query()).range(f, t)), postings: [] }),
    async w => {
      const [before, after] = await Promise.all([
        pagedAll((f, t) => ordered(query().lt('entry_date', w.start)).range(f, t)),
        pagedAll((f, t) => ordered(query().gt('entry_date', w.end)).range(f, t)),
      ])
      return { before, after, postings: [] }
    },
    () => '',
  )
  return rows.entries
}
