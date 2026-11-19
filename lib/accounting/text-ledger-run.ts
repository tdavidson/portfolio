// Server glue for the text authoring surface: export the vehicle's ledger to
// text, and post authored text back as entries. Shared by the REST route and the
// agent tools. Account names are resolved by exact name or by the
// chart code embedded as the last component; unknown accounts are reported.

import type { SupabaseClient } from '@supabase/supabase-js'
import type { Account, AccountType, JournalEntry } from './types'
import { serializeLedger, parseLedgerText, resolvePostingAccounts, type TextEntryInput } from './text-ledger'
import { persistEntry } from './persist'
import { vehicleIdByName } from './vehicle-id'
import { isBalanced } from './ledger'
import { closedPeriodRanges, dateInAnyClosedPeriod } from './periods'
import { reviewImport, type ImportReview } from './import-review'
import { ACTUAL_BOOK } from './books'
import { adoptedEntryIds } from './adoption'
import { fetchAllRows } from './load'
import { cachedExportEntries, scopedChart } from './close-cache'

/** An adopted manual entry has no source_ref; its export carries this ref instead. */
const ADOPTED = 'adopted:'
const CHUNK = 200

async function loadAccounts(admin: SupabaseClient, fundId: string, group: string): Promise<Account[]> {
  const vehicleId = await vehicleIdByName(admin, fundId, group)
  const { data } = await scopedChart(admin, fundId, vehicleId).then(async rows => rows
    ? { data: rows }
    : await admin.from('chart_of_accounts' as any).select('id, code, name, type, subtype, lp_entity_id').eq('fund_id', fundId).eq('vehicle_id', vehicleId))
  return ((data as any[]) ?? []).map(a => ({ id: a.id, fundId, code: a.code, name: a.name, type: a.type as AccountType, subtype: a.subtype ?? null, lpEntityId: a.lp_entity_id ?? null }))
}

export interface LedgerTextRange {
  /** ISO date: only entries on or after it. */
  start?: string
  /** ISO date: only entries on or before it (the snapshot date). */
  end?: string
}

/** Every non-void entry in the range, oldest first, read in pages. A single select is capped at
 *  PostgREST's max_rows (1000), and a `.limit(2000)` here used to return only the OLDEST 1000 with
 *  no sign anything was missing — the newest entries simply were not in the export. */
async function loadExportEntries(admin: SupabaseClient, fundId: string, vehicleId: string | null, range: LedgerTextRange): Promise<any[]> {
  // Inside a period close, the rows dated in closed periods come from the close's cache (close-cache.ts).
  if (!range.start) {
    const cached = await cachedExportEntries(admin, fundId, vehicleId, range.end)
    if (cached) return cached
  }
  return fetchAllRows<any>((f, t) => {
    let q = admin
      .from('journal_entries' as any)
      .select('id, entry_date, memo, source_type, source_ref, status, journal_postings(account_id, amount, currency)')
      .eq('book', ACTUAL_BOOK)
      .eq('fund_id', fundId)
      .eq('vehicle_id', vehicleId)
      .neq('status', 'void')
    if (range.start) q = q.gte('entry_date', range.start)
    if (range.end) q = q.lte('entry_date', range.end)
    // A stable, unique order, so pages neither skip nor repeat an entry.
    return q.order('entry_date', { ascending: true }).order('id', { ascending: true }).range(f, t)
  })
}

async function toTextEntries(admin: SupabaseClient, fundId: string, rows: any[]): Promise<TextEntryInput[]> {
  // An entry adopted by investment transactions owns them without a source_ref; re-importing it
  // would adopt it a second time. Its ref names the entry, which the import checks is live.
  const adopted = await adoptedEntryIds(admin, fundId, rows.filter(e => !e.source_ref).map(e => e.id))
  return rows.map(e => ({
    entryDate: e.entry_date,
    memo: e.memo,
    sourceType: e.source_type,
    sourceRef: e.source_ref ?? (adopted.has(e.id) ? `${ADOPTED}${e.id}` : null),
    status: e.status,
    postings: (e.journal_postings ?? []).map((p: any) => ({ accountId: p.account_id, amount: Number(p.amount), currency: p.currency ?? 'USD' })),
  }))
}

/** Serialize a vehicle's books (excluding void entries) to plain text — ALL of them. Pass
 *  `asOf` to snapshot only entries on or before that date (the period-close snapshot). */
export async function exportLedgerText(admin: SupabaseClient, fundId: string, group: string, asOf?: string): Promise<string> {
  const accounts = await loadAccounts(admin, fundId, group)
  const vehicleId = await vehicleIdByName(admin, fundId, group)
  const rows = await loadExportEntries(admin, fundId, vehicleId, { end: asOf })
  return serializeLedger(accounts, await toTextEntries(admin, fundId, rows))
}

/** Characters of text one agent page carries before it is split (roughly 25k tokens). */
export const LEDGER_TEXT_PAGE_CHARS = 100_000

export interface LedgerTextPage {
  text: string
  /** Entries in this page. */
  entries: number
  /** Entries in the whole range. */
  total: number
  /** True when entries remain after this page; continue with `cursor`. */
  truncated: boolean
  cursor?: string
  note?: string
}

/**
 * The agent's export: the same text as exportLedgerText, but split into pages of at most
 * `maxChars` (always at least one entry) so a large ledger never arrives cut off. `cursor` is the
 * number of entries already returned, in the stable (entry_date, id) order. A page that stops
 * early says so — `truncated`, the counts, the cursor and a note — rather than dropping rows.
 */
export async function exportLedgerTextPage(
  admin: SupabaseClient,
  fundId: string,
  group: string,
  opts: LedgerTextRange & { cursor?: string | number; maxChars?: number } = {},
): Promise<LedgerTextPage> {
  const offset = Math.max(0, Math.floor(Number(opts.cursor ?? 0)) || 0)
  const maxChars = opts.maxChars ?? LEDGER_TEXT_PAGE_CHARS
  const accounts = await loadAccounts(admin, fundId, group)
  const vehicleId = await vehicleIdByName(admin, fundId, group)
  const rows = await loadExportEntries(admin, fundId, vehicleId, opts)
  const total = rows.length
  const rest = await toTextEntries(admin, fundId, rows.slice(offset))

  // Grow the page entry by entry; the account `open` header depends on the page, so measure the
  // serialized page itself rather than summing entries.
  let n = rest.length
  let text = serializeLedger(accounts, rest)
  if (text.length > maxChars) {
    let lo = 1, hi = rest.length
    while (lo < hi) {
      const mid = Math.ceil((lo + hi) / 2)
      if (serializeLedger(accounts, rest.slice(0, mid)).length <= maxChars) lo = mid
      else hi = mid - 1
    }
    n = lo
    text = serializeLedger(accounts, rest.slice(0, n))
  }
  const next = offset + n
  if (next >= total) return { text, entries: n, total, truncated: false }
  return {
    text,
    entries: n,
    total,
    truncated: true,
    cursor: String(next),
    note: `Showing entries ${offset + 1}-${next} of ${total}. Call export_ledger_text again with cursor "${next}" (and the same start/end) for the rest.`,
  }
}

export interface PostTextResult {
  importReview?: ImportReview
  reviewRequired?: boolean
  posted: number
  /** The entries this call wrote, in text order. On a failure part-way, the ones already in. */
  entryIds?: string[]
  errors: string[]
  unknownAccounts: string[]
}

/**
 * Parse authored text and persist each balanced entry. Default status is 'posted'
 * unless the entry's flag is '!' (draft) or `defaultStatus` overrides.
 *
 * An entry's `ref:` is checked against the books AND written as its source_ref, so sending the
 * same text twice refuses the second time instead of booking it again. (It used to be checked and
 * then dropped, so a re-send — or a second chat with the same text — posted every entry twice.)
 *
 * Nearly all-or-nothing: every refusal that can be known up front (parse, accounts, balance, refs
 * already in the books, the import review, a closed period) refuses the whole text before anything
 * is written. Entries are still persisted one at a time — there is no multi-entry transaction to
 * put them in — so a failure while writing (adoption refused, a partner allocation failing, the
 * database) stops there and reports which entries are already in and which were not attempted.
 */
export async function postLedgerText(
  admin: SupabaseClient,
  fundId: string,
  group: string,
  userId: string | null,
  text: string,
  defaultStatus?: 'draft' | 'posted',
  reviewToken?: string,
  includeLp = false,
): Promise<PostTextResult> {
  const { entries, errors } = parseLedgerText(text)
  const accounts = await loadAccounts(admin, fundId, group)

  const unknownAccounts = new Set<string>()
  let posted = 0

  const prepared: { entry: JournalEntry; status: 'draft' | 'posted' }[] = []
  for (const e of entries) {
    const { postings, unknown } = resolvePostingAccounts(accounts, e.postings)
    if (unknown.length) { unknown.forEach(u => unknownAccounts.add(u)); continue }
    const entry: JournalEntry = { fundId, entryDate: e.date, memo: e.narration, sourceType: e.sourceType ?? 'manual', sourceRef: e.ref ?? null, postings }
    if (!isBalanced(entry)) { errors.push(`Entry ${e.date} does not balance after resolving accounts`); continue }
    prepared.push({ entry, status: defaultStatus ?? (e.flag === '!' ? 'draft' : 'posted') })
  }
  if (errors.length || unknownAccounts.size) return { posted: 0, errors, unknownAccounts: Array.from(unknownAccounts) }
  // An exported ledger re-imported must not book its entries twice — least of all derived and
  // adopted ones, which posting would otherwise adopt as new transactions.
  // A failed read refuses the whole import: it must never look like "not in the books".
  const refs = Array.from(new Set(entries.map(e => e.ref).filter((r): r is string => !!r)))
  if (refs.length > 0) {
    const vehicleId = await vehicleIdByName(admin, fundId, group)
    const already = new Set<string>()
    const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
    const adoptedIds = refs.filter(r => r.startsWith(ADOPTED)).map(r => r.slice(ADOPTED.length)).filter(id => UUID.test(id))
    // Every ref, `adopted:` ones included: a re-import now writes the ref it came with, so a
    // second send of the same text finds the first one's entries by their source_ref.
    const sourceRefs = refs
    try {
      for (let i = 0; i < sourceRefs.length; i += CHUNK) {
        const { data, error } = await admin.from('journal_entries' as any).select('source_ref')
          .eq('book', ACTUAL_BOOK).eq('fund_id', fundId).eq('vehicle_id', vehicleId).neq('status', 'void').in('source_ref', sourceRefs.slice(i, i + CHUNK))
        if (error) throw error
        for (const r of (data as any[]) ?? []) already.add(r.source_ref as string)
      }
      for (let i = 0; i < adoptedIds.length; i += CHUNK) {
        const { data, error } = await admin.from('journal_entries' as any).select('id')
          .eq('book', ACTUAL_BOOK).eq('fund_id', fundId).eq('vehicle_id', vehicleId).neq('status', 'void').in('id', adoptedIds.slice(i, i + CHUNK))
        if (error) throw error
        for (const r of (data as any[]) ?? []) already.add(`${ADOPTED}${r.id}`)
      }
    } catch (e) {
      errors.push(`Could not check for entries already in the books: ${(e as { message?: string })?.message ?? String(e)}`)
      return { posted: 0, errors, unknownAccounts: [] }
    }
    for (const e of entries) if (e.ref && already.has(e.ref)) errors.push(`Entry ${e.date} "${e.narration}" is already in the books (${e.ref}). Remove it from the text, or void the original first.`)
    if (errors.length) return { posted: 0, errors, unknownAccounts: [] }
  }
  const importReview = await reviewImport(admin, fundId, group, { entries: prepared.map(p => p.entry), includeLp })
  if (importReview.differences.length && reviewToken !== importReview.token) return { posted: 0, errors: [], unknownAccounts: [], importReview, reviewRequired: true }
  // A closed period would refuse its entry mid-way through; find it before anything is written.
  const closed = await closedPeriodRanges(admin, fundId, group)
  for (const { entry } of prepared) {
    if (dateInAnyClosedPeriod(closed, entry.entryDate)) errors.push(`Entry ${entry.entryDate} "${entry.memo ?? ''}" falls in a closed period — reopen it to post there.`)
  }
  if (errors.length) return { importReview, posted: 0, errors, unknownAccounts: [] }

  const entryIds: string[] = []
  for (let i = 0; i < prepared.length; i++) {
    const { entry, status } = prepared[i]
    const result = await persistEntry(admin, fundId, group, userId, entry, status)
    if ('error' in result) {
      // Stop: the rest were not attempted, so what is in the books is exactly the entries before
      // this one. Say so, so nobody re-sends the whole text and doubles them.
      const left = prepared.length - i - 1
      errors.push(`Entry ${entry.entryDate} "${entry.memo ?? ''}": ${result.error}`)
      if (posted > 0 || left > 0) {
        errors.push(`Stopped: ${posted} earlier ${posted === 1 ? 'entry was' : 'entries were'} written${posted ? ` (${entryIds.join(', ')})` : ''} and stay in the books; ` +
          `this one and the ${left} after it were not. Send only the entries from this one on — not the whole text again.`)
      }
      break
    }
    entryIds.push(result.entryId)
    posted++
  }

  return { importReview, posted, entryIds, errors, unknownAccounts: Array.from(unknownAccounts) }
}
