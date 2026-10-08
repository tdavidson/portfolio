import type { SupabaseClient } from '@supabase/supabase-js'
import type { ParsedTxn } from './bank'
import { ACTUAL_BOOK } from './books'
import { adoptedEntryIds } from './adoption'

export interface QuickBooksCashEntry {
  id: string
  date: string
  amount: number
  memo: string
  status: 'draft' | 'posted'
}

const DAY = 86_400_000
export const CLEARING_DAYS = 7
const cents = (n: number) => Math.round(n * 100)
const normalize = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()

/** Amount and clearing window identify POSSIBLE duplicates, not proof of identity. */
export function quickBooksCandidates(row: ParsedTxn, entries: QuickBooksCashEntry[]): QuickBooksCashEntry[] {
  return entries.filter(e => cents(e.amount) === cents(row.amount) && cents(row.amount) !== 0 &&
    Math.abs(Date.parse(e.date) - Date.parse(row.date)) <= CLEARING_DAYS * DAY)
}

export function clearQuickBooksMatch(row: ParsedTxn, candidates: QuickBooksCashEntry[]): QuickBooksCashEntry | null {
  if (candidates.length !== 1 || candidates[0].status !== 'posted') return null
  const description = normalize(row.description)
  // Avoid auto-matching generic descriptions such as "wire transfer" or bare reference numbers.
  if (description.length < 8 || !/[a-z]/.test(description) || /^(wire|ach|bank|transfer|payment|deposit|withdrawal|fee|debit|credit|check|transaction|\s|\d)+$/.test(description)) return null
  const memo = normalize(candidates[0].memo)
  return memo === description || memo.endsWith(` ${description}`) ? candidates[0] : null
}

/** Fail closed on read errors: a partial dedupe index must never authorize new drafts. */
export async function readAll<T>(query: (from: number, to: number) => PromiseLike<{ data: T[] | null; error: { message: string } | null }>): Promise<T[]> {
  const out: T[] = []
  for (let start = 0; ; start += 1000) {
    const { data, error } = await query(start, start + 999)
    if (error) throw new Error(error.message)
    out.push(...(data ?? []))
    if (!data || data.length < 1000) return out
  }
}

export async function loadQuickBooksCashEntries(
  admin: SupabaseClient, fundId: string, vehicleId: string, cashId: string, dates: string[],
): Promise<QuickBooksCashEntry[]> {
  if (!dates.length) return []
  const sorted = [...dates].sort()
  const offset = (date: string, days: number) => new Date(Date.parse(date) + days * DAY).toISOString().slice(0, 10)
  const rows = await readAll<any>((from, to) => admin.from('journal_entries' as any)
    .select('id, entry_date, memo, status, journal_postings(account_id, amount)')
    .eq('fund_id', fundId).eq('vehicle_id', vehicleId).eq('book', ACTUAL_BOOK)
    .eq('source_type', 'quickbooks').in('status', ['posted', 'draft'])
    .gte('entry_date', offset(sorted[0], -CLEARING_DAYS))
    .lte('entry_date', offset(sorted[sorted.length - 1], CLEARING_DAYS))
    .order('id').range(from, to))
  // An ADOPTED QuickBooks entry is an owned investment entry: it is matched by the investment path
  // (investment-bank-match.ts), never held as a possible QuickBooks duplicate as well.
  const adopted = await adoptedEntryIds(admin, fundId, rows.map(e => e.id))
  return rows.flatMap(e => {
    if (adopted.has(e.id)) return []
    const cash = (e.journal_postings ?? []).filter((p: any) => p.account_id === cashId)
    if (!cash.length) return []
    // Preserve both sides of a transfer between bank accounts mapped to pooled cash.
    // Netting them to zero would make both statement rows look like new transactions.
    return [1, -1].flatMap(sign => {
      const amount = cash.filter((p: any) => Math.sign(Number(p.amount)) === sign)
        .reduce((sum: number, p: any) => sum + Number(p.amount), 0)
      return amount ? [{ id: e.id, date: e.entry_date, memo: e.memo ?? '', status: e.status, amount }] : []
    })
  })
}

/** One claim per cash direction; a transfer legitimately appears on two bank statements. */
export const quickBooksClaimHash = (entryId: string, amount: number) => `qb-bank:${entryId}:${amount > 0 ? 'in' : 'out'}`

export function quickBooksAlreadyClaimed(entry: QuickBooksCashEntry, bankRows: { journal_entry_id?: string | null; raw?: any }[]): boolean {
  return bankRows.some(row => row.journal_entry_id === entry.id &&
    (row.raw?.quickbooksCashAmount == null || Math.sign(Number(row.raw.quickbooksCashAmount)) === Math.sign(entry.amount)))
}
