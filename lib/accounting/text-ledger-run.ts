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
import { reviewImport, type ImportReview } from './import-review'
import { ACTUAL_BOOK } from './books'
import { adoptedEntryIds } from './adoption'

/** An adopted manual entry has no source_ref; its export carries this ref instead. */
const ADOPTED = 'adopted:'
const CHUNK = 200

async function loadAccounts(admin: SupabaseClient, fundId: string, group: string): Promise<Account[]> {
  const vehicleId = await vehicleIdByName(admin, fundId, group)
  const { data } = await admin.from('chart_of_accounts' as any).select('id, code, name, type, subtype, lp_entity_id').eq('fund_id', fundId).eq('vehicle_id', vehicleId)
  return ((data as any[]) ?? []).map(a => ({ id: a.id, fundId, code: a.code, name: a.name, type: a.type as AccountType, subtype: a.subtype ?? null, lpEntityId: a.lp_entity_id ?? null }))
}

/** Serialize a vehicle's books (excluding void entries) to plain text. Pass
 *  `asOf` to snapshot only entries on or before that date. */
export async function exportLedgerText(admin: SupabaseClient, fundId: string, group: string, asOf?: string): Promise<string> {
  const accounts = await loadAccounts(admin, fundId, group)
  const vehicleId = await vehicleIdByName(admin, fundId, group)
  let q = admin
    .from('journal_entries' as any)
    .select('id, entry_date, memo, source_type, source_ref, status, journal_postings(account_id, amount, currency)')
    .eq('book', ACTUAL_BOOK)
    .eq('fund_id', fundId)
    .eq('vehicle_id', vehicleId)
    .neq('status', 'void')
  if (asOf) q = q.lte('entry_date', asOf)
  const { data } = await q.order('entry_date', { ascending: true }).limit(2000)
  const rows = (data as any[]) ?? []
  // An entry adopted by investment transactions owns them without a source_ref; re-importing it
  // would adopt it a second time. Its ref names the entry, which the import checks is live.
  const adopted = await adoptedEntryIds(admin, fundId, rows.filter(e => !e.source_ref).map(e => e.id))

  const entries: TextEntryInput[] = rows.map(e => ({
    entryDate: e.entry_date,
    memo: e.memo,
    sourceType: e.source_type,
    sourceRef: e.source_ref ?? (adopted.has(e.id) ? `${ADOPTED}${e.id}` : null),
    status: e.status,
    postings: (e.journal_postings ?? []).map((p: any) => ({ accountId: p.account_id, amount: Number(p.amount), currency: p.currency ?? 'USD' })),
  }))
  return serializeLedger(accounts, entries)
}

export interface PostTextResult {
  importReview?: ImportReview
  reviewRequired?: boolean
  posted: number
  errors: string[]
  unknownAccounts: string[]
}

/**
 * Parse authored text and persist each balanced entry. Default status is 'posted'
 * unless the entry's flag is '!' (draft) or `defaultStatus` overrides.
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
    const entry: JournalEntry = { fundId, entryDate: e.date, memo: e.narration, sourceType: e.sourceType ?? 'manual', postings }
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
    const sourceRefs = refs.filter(r => !r.startsWith(ADOPTED))
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
  for (const { entry, status } of prepared) {
    const result = await persistEntry(admin, fundId, group, userId, entry, status)
    if ('error' in result) errors.push(`Entry ${entry.entryDate}: ${result.error}`)
    else posted++
  }

  return { importReview, posted, errors, unknownAccounts: Array.from(unknownAccounts) }
}
