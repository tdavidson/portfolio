// Server-side persistence helpers shared across the accounting routes. Scoped to
// one vehicle (fund_id + portfolio_group): resolve accounts, create per-LP
// capital accounts on demand, and write a balanced entry with its postings
// (rolling back the header if postings fail).

import type { SupabaseClient } from '@supabase/supabase-js'
import { lpCapitalCode } from './chart'
import { assertBalanced } from './ledger'
import { closedPeriodRanges, dateInAnyClosedPeriod } from './periods'
import { fundCurrency } from './currency'
import { vehicleIdByName } from './vehicle-id'
import type { JournalEntry, Posting } from './types'
import { ACTUAL_BOOK, type LedgerBook } from './books'
import { adoptEntry, keptAsDraft, removeAdopted, settleLostRace, type AdoptOptions } from './adoption'
import { chartKey, forgetRows, memoRows, scopedChart } from './close-cache'

/** code → account_id for the vehicle's chart. */
export async function accountIdByCode(admin: SupabaseClient, fundId: string, group: string): Promise<Map<string, string>> {
  const vehicleId = await vehicleIdByName(admin, fundId, group)
  const scoped = await scopedChart(admin, fundId, vehicleId)
  if (scoped) return new Map(scoped.map(a => [a.code as string, a.id as string]))
  const { data } = await admin.from('chart_of_accounts' as any).select('id, code').eq('fund_id', fundId).eq('vehicle_id', vehicleId)
  return new Map(((data as any[]) ?? []).map(a => [a.code as string, a.id as string]))
}

/** Ensure a per-LP capital account exists for each entity in this vehicle. */
export async function ensureCapitalAccounts(
  admin: SupabaseClient,
  fundId: string,
  group: string,
  entityIds: string[]
): Promise<Map<string, string>> {
  const vehicleId = await vehicleIdByName(admin, fundId, group)
  const scoped = await scopedChart(admin, fundId, vehicleId)
  const { data: existing } = scoped
    ? { data: scoped.filter(a => a.lp_entity_id != null) }
    : await admin
      .from('chart_of_accounts' as any)
      .select('id, lp_entity_id')
      .eq('fund_id', fundId)
      .eq('vehicle_id', vehicleId)
      .not('lp_entity_id', 'is', null)
  const map = new Map<string, string>(((existing as any[]) ?? []).map(a => [a.lp_entity_id as string, a.id as string]))

  const missing = Array.from(new Set(entityIds)).filter(id => !map.has(id))
  if (missing.length > 0) {
    // SCOPED TO THE FUND. `lp_entities` is a cross-fund table, and these ids arrive from
    // request bodies (opening balances, capital-call lines, journal posting lpEntityId, the
    // external agent's post_entry). Without the fund filter, an id belonging to another fund
    // would resolve, and we would create a chart account here literally named
    // "Partners' capital — <the other fund's LP>" — a cross-tenant name disclosure, plus a
    // foreign id planted in this fund's postings.
    const { data: ents } = await admin
      .from('lp_entities' as any)
      .select('id, entity_name')
      .eq('fund_id', fundId)
      .in('id', missing)
    const name = new Map<string, string>(((ents as any[]) ?? []).map(e => [e.id as string, e.entity_name as string]))

    // An id that didn't resolve belongs to another fund, or to nothing. Refuse rather than
    // inventing an account named after a UUID.
    const foreign = missing.filter(id => !name.has(id))
    if (foreign.length > 0) {
      throw new Error(`Unknown LP for this fund: ${foreign.join(', ')}`)
    }

    const rows = missing.map(id => ({
      fund_id: fundId,
      portfolio_group: group,
      vehicle_id: vehicleId,
      code: lpCapitalCode(id),
      name: `Partners' capital — ${name.get(id) ?? id}`,
      type: 'equity',
      subtype: 'lp_capital',
      lp_entity_id: id,
    }))
    const { error } = await admin.from('chart_of_accounts' as any).upsert(rows, { onConflict: 'fund_id,portfolio_group,code', ignoreDuplicates: true })
    if (vehicleId) forgetRows(admin, chartKey(fundId, vehicleId))
    if (error) throw error
    const { data: created, error: readError } = await admin.from('chart_of_accounts' as any).select('id, lp_entity_id').eq('fund_id', fundId).eq('vehicle_id', vehicleId).in('lp_entity_id', missing)
    if (readError) throw readError
    for (const a of ((created as any[]) ?? [])) map.set(a.lp_entity_id, a.id)
  }
  return map
}

export interface LiveEntryRef { id: string; status: string; entryDate: string }

/**
 * The non-void entry in this vehicle's book that carries `sourceRef`, or null. THROWS on a failed
 * read: a caller using this to refuse a duplicate must not read "unknown" as "not in the books".
 */
export async function liveEntryByRef(
  admin: SupabaseClient, fundId: string, vehicleId: string, sourceRef: string, book: LedgerBook = ACTUAL_BOOK,
): Promise<LiveEntryRef | null> {
  const { data, error } = await admin.from('journal_entries' as any)
    .select('id, status, entry_date')
    .eq('fund_id', fundId).eq('vehicle_id', vehicleId).eq('book', book)
    .eq('source_ref', sourceRef).neq('status', 'void')
    .order('entry_date', { ascending: true }).limit(1)
  if (error) throw new Error(`Could not check for an entry already in the books: ${error.message}`)
  const row = ((data as any[]) ?? [])[0]
  return row ? { id: row.id, status: row.status, entryDate: row.entry_date } : null
}

/** The refusal for a second copy of an entry, naming the first. */
export function duplicateRefMessage(sourceRef: string, existing: LiveEntryRef | null): string {
  const which = existing ? `entry ${existing.id} (${existing.status}, dated ${existing.entryDate})` : 'another entry'
  return `This entry is already in the books as ${which}, booked from the same source (${sourceRef}). ` +
    'Nothing was posted. Void that entry first if it is wrong; do not post it again.'
}

/** Write a balanced entry and its postings for a vehicle. Returns id or error. */
export async function persistEntry(
  admin: SupabaseClient,
  fundId: string,
  group: string,
  userId: string | null,
  entry: JournalEntry,
  status: 'draft' | 'posted' = 'posted',
  /**
   * Which set of books. Defaults to the real ledger, so every existing caller is unchanged.
   *
   * A non-actual book is exempt from the closed-period check below, matching the database
   * trigger (20260827000000_ledger_books.sql). Book-to-tax adjustments are dated INSIDE the
   * periods they adjust — that is what they are for — and those periods are closed by
   * definition. If this check and that trigger ever disagree, this one is the bug: the database
   * is the boundary and this is the friendlier error.
   */
  book: LedgerBook = ACTUAL_BOOK,
  /** Generated allocation entries pass false to prevent recursive allocation. */
  allocate: boolean = true,
  /** What the caller may do to the tracker when this entry is adopted (adoption.ts). */
  adoptOpts: AdoptOptions = {},
): Promise<{ entryId: string } | { error: string; allocationFailed?: true; adoptionRefused?: true; duplicateOf?: string }> {
  // DENOMINATE THE ENTRY IN THE FUND'S CURRENCY, here, at the one place everything is written.
  //
  // Every entry builder takes a `currency` and defaults it to 'USD', and no caller ever passed
  // one — so a fund reporting in EUR had EUR statements and a EUR portfolio, and a ledger whose
  // postings all claimed to be dollars. Stamping it at the choke point means a caller cannot get
  // it wrong, and a new builder cannot reintroduce the bug.
  //
  // The ledger is single-currency by design: a foreign position is translated on the way in, and
  // the rate movement lives in 1250/4300. See currency.ts.
  let currency: string
  try {
    currency = await fundCurrency(admin, fundId)
  } catch (e) {
    return { error: `${e instanceof Error ? e.message : String(e)}. Nothing was saved — try again.` }
  }
  entry = { ...entry, postings: entry.postings.map(p => ({ ...p, currency })) }

  try {
    assertBalanced(entry)
  } catch (e) {
    return { error: (e as Error).message }
  }

  // Locking: refuse to post into a closed period (reopen it to amend). Actual book only — see
  // the `book` parameter.
  if (book === ACTUAL_BOOK) {
    const closed = await closedPeriodRanges(admin, fundId, group)
    if (dateInAnyClosedPeriod(closed, entry.entryDate)) {
      return { error: `The period covering ${entry.entryDate} is closed — reopen it to post here` }
    }
  }

  // A vehicle name that isn't in the registry resolves to null, and `vehicle_id` is
  // nullable — so this used to write entries and postings with vehicle_id = null. Every read
  // filters `.eq('vehicle_id', ...)`, which matches nothing when null, so those rows became
  // invisible orphans: money on the books that no statement, no capital account and no
  // report would ever show again. Refuse instead.
  const vehicleId = await vehicleIdByName(admin, fundId, group)
  if (!vehicleId) {
    return { error: `Unknown vehicle "${group}" — add it in Settings before booking to it.` }
  }

  const postingProblem = await validatePostings(admin, fundId, vehicleId, group, entry.postings)
  if (postingProblem) return { error: postingProblem }

  // ADOPT BEFORE POSTING (plans/spec-ledger-one-writer.md §1). A posted actual-book entry is
  // written as a DRAFT first, its postings next, then any investment lines nobody owns are adopted
  // into transactions, and only then does it flip to posted. That order is what the ownership
  // trigger needs: it checks at the flip, and adopted_entry_id can only reference a header that
  // exists. Allocation entries carry no investment lines and skip the read entirely.
  const adoptHere = status === 'posted' && book === ACTUAL_BOOK && !(entry.sourceRef ?? '').startsWith('allocation:')
  const { data: created, error: entryErr } = await admin
    .from('journal_entries' as any)
    .insert({
      fund_id: fundId,
      portfolio_group: group,
      vehicle_id: vehicleId,
      entry_date: entry.entryDate,
      memo: entry.memo ?? null,
      source_type: entry.sourceType ?? 'manual',
      // Ties an entry back to what produced it — the period close tags its allocation
      // entries `close:<periodId>` so reopening can find and void exactly those.
      source_ref: entry.sourceRef ?? null,
      reference: entry.reference ?? null,
      adjusting: entry.adjusting === true,
      vendor_id: entry.vendorId ?? null,
      status: adoptHere ? 'draft' : status,
      book,
      created_by: userId,
      posted_at: status === 'posted' && !adoptHere ? new Date().toISOString() : null,
    })
    .select('id')
    .single()
  if (entryErr) {
    // A unique index on source_ref (the partner opening, an agent allocation) refused a second
    // copy — another request or another chat booked it first. Name the entry already there.
    if ((entryErr as { code?: string }).code === '23505' && entry.sourceRef) {
      const existing = await liveEntryByRef(admin, fundId, vehicleId, entry.sourceRef, book).catch(() => null)
      return { error: duplicateRefMessage(entry.sourceRef, existing), duplicateOf: existing?.id }
    }
    return { error: entryErr.message }
  }

  const entryId = (created as any).id
  const discard = () => admin.from('journal_entries' as any).delete().eq('id', entryId).eq('fund_id', fundId)
  const { error: postErr } = await admin.from('journal_postings' as any).insert(
    entry.postings.map(p => ({
      fund_id: fundId,
      portfolio_group: group,
      vehicle_id: vehicleId,
      journal_entry_id: entryId,
      account_id: p.accountId,
      amount: p.amount,
      currency: p.currency,
      lp_entity_id: p.lpEntityId ?? null,
    }))
  )
  if (postErr) {
    await discard()
    return { error: postErr.message }
  }

  let adopted: string[] = []
  if (adoptHere) {
    const adoption = await adoptEntry(admin, fundId, {
      entryId, vehicleId, entryDate: entry.entryDate, memo: entry.memo ?? null,
      sourceRef: entry.sourceRef ?? null, postings: entry.postings,
    }, adoptOpts)
    if ('refused' in adoption) {
      await discard()
      return { error: adoption.refused, adoptionRefused: true }
    }
    adopted = adoption.adoptedIds
    const { data: flipped, error: flipErr } = await admin.from('journal_entries' as any)
      .update({ status: 'posted', posted_at: new Date().toISOString() })
      .eq('id', entryId).eq('fund_id', fundId).eq('book', ACTUAL_BOOK).eq('status', 'draft').select('id')
    if (flipErr) {
      const removed = await removeAdopted(admin, fundId, adopted)
      if (removed.error) return { error: keptAsDraft(entryId, removed.error) }
      await discard()
      return { error: flipErr.message }
    }
    if (!((flipped as any[]) ?? []).length) {
      // Another request posted this draft first (it is visible as a draft for a few round trips).
      // The winner owns the posted entry and its allocation; do not allocate or discard.
      const settled = await settleLostRace(admin, fundId, entryId, adopted)
      if (settled.error) return { error: keptAsDraft(entryId, settled.error) }
      return { error: 'This entry was posted by another request at the same time.' }
    }
  }

  if (status === 'posted' && book === ACTUAL_BOOK && allocate) {
    // Dynamic import avoids a module-initialization cycle: continuous-allocation uses this
    // function to persist the generated balance-sheet entry with `allocate=false`.
    const { allocatePostedEntry, rollbackGeneratedAllocations } = await import('./continuous-allocation')
    const allocated = await allocatePostedEntry(admin, fundId, group, userId, entryId, entry)
    if ('error' in allocated) {
      // Compensating rollback. persistEntry predates a transactional RPC; never leave the source
      // posted without the capital allocation that posting promised — nor its adopted transactions.
      await rollbackGeneratedAllocations(admin, fundId, entryId)
      const removed = await removeAdopted(admin, fundId, adopted)
      if (removed.error) {
        await admin.from('journal_entries' as any).update({ status: 'draft', posted_at: null }).eq('id', entryId).eq('fund_id', fundId)
        return { error: keptAsDraft(entryId, removed.error) }
      }
      await discard()
      return { error: `Entry was not posted because its partner allocation failed: ${allocated.error}`, allocationFailed: true }
    }
  }

  return { entryId }
}

/**
 * Post several balanced entries for one vehicle in three writes instead of three or four each:
 * every header (as a draft) in one insert, every line in one insert, then one update that posts
 * them all. For the entries a period close generates (its allocation and owner entries), which
 * post together, into the same open period, and are undone together.
 *
 * The same checks as persistEntry run on every entry first (currency, balance, the period lock,
 * the vehicle, the lines), so nothing is written unless all of them may be; the database's own
 * triggers still check each row. If a write fails, the drafts are removed and nothing is posted.
 * If the partner allocation of a posted entry fails, the error is returned with every entry
 * already posted left for the caller to void: the close does that (reopenPeriodWithReversal),
 * which is what it did when the entries were written one at a time.
 *
 * Not for entries that can carry investment lines: those adopt transactions one by one in
 * persistEntry. One that does is refused here before anything is written.
 */
export async function persistEntriesTogether(
  admin: SupabaseClient,
  fundId: string,
  group: string,
  userId: string | null,
  entries: JournalEntry[],
): Promise<{ entryIds: string[] } | { error: string; entryIndex?: number }> {
  if (entries.length === 0) return { entryIds: [] }
  let currency: string
  try {
    currency = await fundCurrency(admin, fundId)
  } catch (e) {
    return { error: `${e instanceof Error ? e.message : String(e)}. Nothing was saved — try again.` }
  }
  entries = entries.map(entry => ({ ...entry, postings: entry.postings.map(p => ({ ...p, currency })) }))
  for (const [i, entry] of entries.entries()) {
    try {
      assertBalanced(entry)
    } catch (e) {
      return { error: (e as Error).message, entryIndex: i }
    }
  }
  const closed = await closedPeriodRanges(admin, fundId, group)
  for (const [i, entry] of entries.entries()) {
    if (dateInAnyClosedPeriod(closed, entry.entryDate)) {
      return { error: `The period covering ${entry.entryDate} is closed — reopen it to post here`, entryIndex: i }
    }
  }
  const vehicleId = await vehicleIdByName(admin, fundId, group)
  if (!vehicleId) return { error: `Unknown vehicle "${group}" — add it in Settings before booking to it.` }
  const problems = await Promise.all(entries.map(entry => validatePostings(admin, fundId, vehicleId, group, entry.postings)))
  const bad = problems.findIndex(Boolean)
  if (bad >= 0) return { error: problems[bad]!, entryIndex: bad }

  // Ids chosen here, so each line can name its header without waiting for the insert to answer.
  const ids = entries.map(() => crypto.randomUUID())
  const { error: entryErr } = await admin.from('journal_entries' as any).insert(entries.map((entry, i) => ({
    id: ids[i],
    fund_id: fundId,
    portfolio_group: group,
    vehicle_id: vehicleId,
    entry_date: entry.entryDate,
    memo: entry.memo ?? null,
    source_type: entry.sourceType ?? 'manual',
    source_ref: entry.sourceRef ?? null,
    reference: entry.reference ?? null,
    adjusting: entry.adjusting === true,
    vendor_id: entry.vendorId ?? null,
    status: 'draft',
    book: ACTUAL_BOOK,
    created_by: userId,
    posted_at: null,
  })))
  if (entryErr) return { error: entryErr.message }
  const discard = () => admin.from('journal_entries' as any).delete().in('id', ids).eq('fund_id', fundId)

  const { error: postErr } = await admin.from('journal_postings' as any).insert(entries.flatMap((entry, i) =>
    entry.postings.map(p => ({
      fund_id: fundId,
      portfolio_group: group,
      vehicle_id: vehicleId,
      journal_entry_id: ids[i],
      account_id: p.accountId,
      amount: p.amount,
      currency: p.currency,
      lp_entity_id: p.lpEntityId ?? null,
    }))))
  if (postErr) {
    await discard()
    return { error: postErr.message }
  }

  // The same adoption step persistEntry runs before the flip. These entries carry no investment
  // lines, so it adopts nothing; one that would is refused rather than adopted in bulk.
  const adoptions = await Promise.all(entries.map((entry, i) => adoptEntry(admin, fundId, {
    entryId: ids[i], vehicleId, entryDate: entry.entryDate, memo: entry.memo ?? null,
    sourceRef: entry.sourceRef ?? null, postings: entry.postings,
  })))
  const adopted = adoptions.flatMap(a => 'adoptedIds' in a ? a.adoptedIds : [])
  const refused = adoptions.findIndex(a => 'refused' in a || a.adoptedIds.length > 0)
  if (refused >= 0) {
    const removed = await removeAdopted(admin, fundId, adopted)
    if (removed.error) return { error: keptAsDraft(ids[refused], removed.error), entryIndex: refused }
    await discard()
    const a = adoptions[refused]
    return { error: 'refused' in a ? a.refused : 'This entry carries investment lines; post it on its own.', entryIndex: refused }
  }

  const { data: flipped, error: flipErr } = await admin.from('journal_entries' as any)
    .update({ status: 'posted', posted_at: new Date().toISOString() })
    .in('id', ids).eq('fund_id', fundId).eq('book', ACTUAL_BOOK).eq('status', 'draft').select('id')
  if (flipErr || ((flipped as any[]) ?? []).length !== ids.length) {
    // Fresh ids nobody else knows, so a short count means the update failed part-way: undo it all.
    await admin.from('journal_entries' as any).update({ status: 'draft', posted_at: null }).in('id', ids).eq('fund_id', fundId)
    await discard()
    return { error: flipErr?.message ?? 'Not every entry could be posted, so none were.' }
  }

  const { allocatePostedEntry, rollbackGeneratedAllocations } = await import('./continuous-allocation')
  for (const [i, entry] of entries.entries()) {
    const allocated = await allocatePostedEntry(admin, fundId, group, userId, ids[i], entry, { fresh: true })
    if ('error' in allocated) {
      await rollbackGeneratedAllocations(admin, fundId, ids[i])
      return { error: `Entry was not posted because its partner allocation failed: ${allocated.error}`, entryIndex: i }
    }
  }
  return { entryIds: ids }
}

/**
 * Re-post entries a re-close would otherwise write again, by putting back the voided copies the
 * reopen left: the same header and lines, flipped from void to posted. Null when that is not
 * possible for every entry, and the caller then writes them afresh (persistEntriesTogether).
 *
 * WHY. Reopening a period voids its close entries and re-closing it posts a new set. When nothing
 * underneath changed, the new set is line for line the set just voided, so a long re-close wrote
 * every partner's allocation line again, month after month: most of what it wrote to disk. A
 * revived entry is one row updated instead of a header and dozens of lines inserted.
 *
 * Only an exact match is revived: same source ref, date, memo, source type, currency, and the same
 * lines (account, amount to the cent, partner), every entry of the set matched to a different
 * voided entry, or none is. Only balance-sheet entries qualify: an entry with income or expense
 * lines carries a partner allocation of its own, which is worked out afresh, so it is written
 * afresh. The checks persistEntry runs (the period lock, the lines) run here too.
 */
export async function reviveVoidedEntries(
  admin: SupabaseClient,
  fundId: string,
  group: string,
  sourceRef: string,
  entries: JournalEntry[],
): Promise<{ entryIds: string[] } | null> {
  if (entries.length === 0 || !sourceRef) return null
  const vehicleId = await vehicleIdByName(admin, fundId, group)
  if (!vehicleId) return null
  if (entries.some(e => (e.sourceRef ?? null) !== sourceRef)) return null

  let currency: string
  try {
    currency = await fundCurrency(admin, fundId)
  } catch {
    return null
  }
  const accountIds = Array.from(new Set(entries.flatMap(e => e.postings.map(p => p.accountId))))
  const { data: accounts, error: accountsErr } = await admin.from('chart_of_accounts' as any)
    .select('id, type').eq('fund_id', fundId).eq('vehicle_id', vehicleId).in('id', accountIds)
  if (accountsErr) return null
  const typeOf = new Map(((accounts as any[]) ?? []).map(a => [a.id as string, a.type as string]))
  if (accountIds.some(id => !typeOf.has(id) || typeOf.get(id) === 'income' || typeOf.get(id) === 'expense')) return null

  const { data: voided, error: voidedErr } = await admin.from('journal_entries' as any)
    .select('id, entry_date, memo, source_type, created_at, journal_postings(account_id, amount, currency, lp_entity_id)')
    .eq('book', ACTUAL_BOOK).eq('fund_id', fundId).eq('vehicle_id', vehicleId)
    .eq('source_ref', sourceRef).eq('status', 'void')
    .order('created_at', { ascending: false }).limit(500)
  if (voidedErr || !voided) return null

  const cents = (n: unknown) => Number(n).toFixed(2)
  const lineKey = (accountId: string, amount: unknown, cur: string | null, lp: string | null) => `${accountId}|${cents(amount)}|${cur ?? ''}|${lp ?? ''}`
  const keyOf = (date: string, memo: string | null, sourceType: string | null, lines: string[]) =>
    [date, memo ?? '', sourceType ?? 'manual', ...lines.sort()].join('\n')
  const wanted = entries.map(e => keyOf(e.entryDate, e.memo ?? null, e.sourceType ?? 'manual',
    e.postings.map(p => lineKey(p.accountId, p.amount, currency, p.lpEntityId ?? null))))
  const pool = new Map<string, string[]>()
  for (const v of voided as any[]) {
    const k = keyOf(v.entry_date, v.memo ?? null, v.source_type ?? 'manual',
      ((v.journal_postings as any[]) ?? []).map(p => lineKey(p.account_id, p.amount, p.currency ?? null, p.lp_entity_id ?? null)))
    const list = pool.get(k) ?? []
    list.push(v.id as string)
    pool.set(k, list)
  }
  const ids: string[] = []
  for (const k of wanted) {
    const id = pool.get(k)?.shift()
    if (!id) return null
    ids.push(id)
  }

  for (const entry of entries) {
    try {
      assertBalanced({ ...entry, postings: entry.postings.map(p => ({ ...p, currency })) })
    } catch {
      return null
    }
  }
  const closed = await closedPeriodRanges(admin, fundId, group)
  if (entries.some(e => dateInAnyClosedPeriod(closed, e.entryDate))) return null
  const problems = await Promise.all(entries.map(e => validatePostings(admin, fundId, vehicleId, group, e.postings)))
  if (problems.some(Boolean)) return null

  const { data: flipped, error: flipErr } = await admin.from('journal_entries' as any)
    .update({ status: 'posted', posted_at: new Date().toISOString() })
    .in('id', ids).eq('fund_id', fundId).eq('book', ACTUAL_BOOK).eq('status', 'void').select('id')
  const back = ((flipped as any[]) ?? []).map(r => r.id as string)
  if (flipErr || back.length !== ids.length) {
    // Someone else touched one of them: put back what this flipped and write the set afresh.
    if (back.length > 0) await admin.from('journal_entries' as any).update({ status: 'void', posted_at: null }).in('id', back).eq('fund_id', fundId)
    return null
  }
  return { entryIds: ids }
}

/**
 * Why these postings may not be written to this fund's `group` (vehicle `vehicleId`), or null when
 * they may. Shared by every path that writes postings: persistEntry, and editing a draft in place
 * (PUT /api/accounting/journal), which used to insert the body's account and partner ids as given.
 */
export async function validatePostings(
  admin: SupabaseClient,
  fundId: string,
  vehicleId: string,
  group: string,
  postings: { accountId: string; lpEntityId?: string | null }[],
): Promise<string | null> {
  // EVERY ACCOUNT MUST BELONG TO THIS FUND *AND* THIS VEHICLE.
  //
  // `accountId` arrives from request bodies (the journal route, the external agent's
  // post_entry) and was written verbatim. The balance trigger doesn't catch a foreign account —
  // it sums amounts and never looks at which account they're on. But every statement builds
  // from THIS vehicle's chart and joins postings to it, so a leg pointed at another vehicle's
  // account is silently DROPPED from the trial balance, the balance sheet, everything. Cash
  // goes up and nothing offsets it: the books stop balancing, and the missing leg appears in no
  // report at all.
  //
  // One check here covers the journal route, the agent, and anything written later.
  const scoped = await scopedChart(admin, fundId, vehicleId)
  const { data: ownAccounts } = scoped ? { data: scoped } : await admin
    .from('chart_of_accounts' as any)
    .select('id')
    .eq('fund_id', fundId)
    .eq('vehicle_id', vehicleId)
  const valid = new Set(((ownAccounts as any[]) ?? []).map(a => a.id as string))

  const foreign = postings.map(p => p.accountId).filter(id => !valid.has(id))
  if (foreign.length > 0) {
    return `Posting to an account that doesn't belong to ${group}: ${foreign.join(', ')}`
  }

  // Same for the partner on a posting. `ensureCapitalAccounts` already refuses a foreign
  // lp_entity_id, but the journal and agent paths don't go through it.
  const lpIds = Array.from(new Set(postings.map(p => p.lpEntityId).filter(Boolean) as string[]))
  if (lpIds.length > 0) {
    // Inside a close every allocation entry names the same partners: asked once. A failed read
    // is not kept, and falls through to the read below, as before.
    const ents = await memoRows<any>(admin, `lp-entity-ids|${fundId}|${[...lpIds].sort().join(',')}`, async () => {
      const { data, error } = await admin.from('lp_entities' as any).select('id').eq('fund_id', fundId).in('id', lpIds)
      if (error) throw error
      return (data as any[]) ?? []
    }).catch(async () => (await admin.from('lp_entities' as any).select('id').eq('fund_id', fundId).in('id', lpIds)).data)
    const known = new Set(((ents as any[]) ?? []).map(e => e.id as string))
    const strangers = lpIds.filter(id => !known.has(id))
    if (strangers.length > 0) {
      return `Posting to a partner who isn't in this fund: ${strangers.join(', ')}`
    }
  }
  return null
}
