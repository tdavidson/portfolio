import type { SupabaseClient } from '@supabase/supabase-js'
import { ACTUAL_BOOK } from './books'
import { persistEntry } from './persist'
import type { JournalEntry, Posting } from './types'
import { vehicleIdByName } from './vehicle-id'

export interface CloseEntrySuggestion {
  id: string
  sourceRef: string
  basis: 'schedule' | 'recurring_pattern'
  title: string
  detail: string
  entryDate: string
  memo: string
  sourceType: string
  required: boolean
  postings: Posting[]
  evidence: { priorEntryIds?: string[]; scheduleId?: string }
}

const iso = (date: Date) => date.toISOString().slice(0, 10)
const monthKey = (value: string) => value.slice(0, 7)
export function scheduledMonth(value: string, count: number, day: number): string {
  const source = new Date(`${value.slice(0, 7)}-01T00:00:00Z`)
  source.setUTCMonth(source.getUTCMonth() + count)
  const last = new Date(Date.UTC(source.getUTCFullYear(), source.getUTCMonth() + 1, 0)).getUTCDate()
  source.setUTCDate(Math.min(day, last))
  return iso(source)
}
/**
 * Move a copied memo's dates to the month it is now for. A recurring entry's memo usually names its
 * own period — "amortization — 2026-08", "(Period 08/01-08/31)" — and copying it verbatim files
 * September's entry under August.
 */
export function shiftMemoMonth(memo: string, from: string, to: string): string {
  const [fy, fm] = from.slice(0, 7).split('-')
  const [ty, tm] = to.slice(0, 7).split('-')
  const lastOf = (y: string, m: string) => String(new Date(Date.UTC(Number(y), Number(m), 0)).getUTCDate()).padStart(2, '0')
  const monthNames = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December']
  return memo
    // 2026-08 → 2026-09 (and 2026-08-31 → 2026-09-30 when it is the month end)
    .replace(new RegExp(`${fy}-${fm}-${lastOf(fy, fm)}`, 'g'), `${ty}-${tm}-${lastOf(ty, tm)}`)
    .replace(new RegExp(`${fy}-${fm}`, 'g'), `${ty}-${tm}`)
    // 08/01-08/31 → 09/01-09/30, and a bare 08/31
    .replace(new RegExp(`\\b${fm}/01\\s*-\\s*${fm}/${lastOf(fy, fm)}\\b`, 'g'), `${tm}/01-${tm}/${lastOf(ty, tm)}`)
    .replace(new RegExp(`\\b${fm}/${lastOf(fy, fm)}\\b`, 'g'), `${tm}/${lastOf(ty, tm)}`)
    // August 2026 → September 2026
    .replace(new RegExp(`\\b${monthNames[Number(fm) - 1]} ${fy}\\b`, 'g'), `${monthNames[Number(tm) - 1]} ${ty}`)
}

function monthDistance(left: string, right: string): number {
  const a = new Date(`${left.slice(0, 7)}-01T00:00:00Z`)
  const b = new Date(`${right.slice(0, 7)}-01T00:00:00Z`)
  return (b.getUTCFullYear() - a.getUTCFullYear()) * 12 + b.getUTCMonth() - a.getUTCMonth()
}
function signature(lines: { account_id: string; amount: unknown; lp_entity_id?: string | null }[]): string {
  return lines.map(line => `${line.account_id}:${Number(line.amount).toFixed(2)}:${line.lp_entity_id ?? ''}`).sort().join('|')
}
/** Which accounts an entry touches, ignoring amounts — monthly interest is the same entry at 0.49 or 0.51. */
function accountSet(lines: { account_id: string }[]): string {
  return [...new Set(lines.map(line => line.account_id))].sort().join('|')
}

export async function loadCloseEntrySuggestions(
  admin: SupabaseClient, fundId: string, group: string, start: string, end: string,
): Promise<CloseEntrySuggestion[]> {
  const vehicleId = await vehicleIdByName(admin, fundId, group)
  if (!vehicleId) return []
  // Every non-void entry in the span, draft or posted, with or without a system reference: a bank
  // import or a hand-keyed entry is as much "this month's occurrence" as a draft the close made.
  const { data: existingRows } = await admin.from('journal_entries' as any)
    .select('source_ref, entry_date, journal_postings(account_id, amount, lp_entity_id)')
    .eq('book', ACTUAL_BOOK).eq('fund_id', fundId).eq('vehicle_id', vehicleId).neq('status', 'void')
    .gte('entry_date', start).lte('entry_date', end)
  const existingRefs = new Set(((existingRows as any[]) ?? []).map(row => row.source_ref as string | null).filter((r): r is string => !!r))
  const existingSignatures = new Set(((existingRows as any[]) ?? []).map(row => `${row.entry_date}:${signature(row.journal_postings ?? [])}`))

  const { data: schedules } = await admin.from('accounting_schedules' as any)
    .select('id, name, memo, source_type, start_date, end_date, day_of_month, required_for_close, accounting_schedule_lines(account_id, amount, lp_entity_id, sort_order)')
    .eq('fund_id', fundId).eq('vehicle_id', vehicleId).eq('active', true).lte('start_date', end)
  const out: CloseEntrySuggestion[] = []
  for (const schedule of ((schedules as any[]) ?? [])) {
    let due = scheduledMonth(schedule.start_date, 0, schedule.day_of_month)
    while (due < start) due = scheduledMonth(due, 1, schedule.day_of_month)
    while (due <= end && (!schedule.end_date || due <= schedule.end_date)) {
      const sourceRef = `schedule:${schedule.id}:${due}`
      const lines = [...(schedule.accounting_schedule_lines ?? [])].sort((a, b) => a.sort_order - b.sort_order)
      if (!existingRefs.has(sourceRef) && !existingSignatures.has(`${due}:${signature(lines)}`)) {
        out.push({
          id: sourceRef, sourceRef, basis: 'schedule', title: schedule.name,
          detail: `Expected from the monthly accounting schedule on ${due}.`, entryDate: due,
          memo: schedule.memo || schedule.name, sourceType: schedule.source_type,
          required: schedule.required_for_close !== false,
          postings: lines.map((line: any) => ({ accountId: line.account_id, amount: Number(line.amount), currency: 'USD', lpEntityId: line.lp_entity_id })),
          evidence: { scheduleId: schedule.id },
        })
      }
      due = scheduledMonth(due, 1, schedule.day_of_month)
    }
  }

  // Conservative fallback: two identical posted entries in consecutive prior months propose
  // the next occurrence. It remains optional until a reviewer turns it into an explicit schedule.
  const lookback = scheduledMonth(start, -6, 1)
  const { data: prior } = await admin.from('journal_entries' as any)
    .select('id, entry_date, memo, source_type, source_ref, journal_postings(account_id, amount, currency, lp_entity_id)')
    .eq('book', ACTUAL_BOOK).eq('fund_id', fundId).eq('vehicle_id', vehicleId).eq('status', 'posted')
    .gte('entry_date', lookback).lt('entry_date', start)
    .order('entry_date', { ascending: true })
  const groups = new Map<string, any[]>()
  for (const entry of ((prior as any[]) ?? [])) {
    if (entry.source_ref?.startsWith('allocation:')) continue
    const lines = entry.journal_postings ?? []
    if (lines.length < 2) continue
    const key = `${entry.source_type ?? 'manual'}|${signature(lines)}`
    groups.set(key, [...(groups.get(key) ?? []), entry])
  }
  for (const entries of Array.from(groups.values())) {
    if (entries.length < 2) continue
    const previous = entries[entries.length - 2], latest = entries[entries.length - 1]
    if (monthDistance(previous.entry_date, latest.entry_date) !== 1) continue
    const due = scheduledMonth(latest.entry_date, 1, Number(latest.entry_date.slice(8, 10)))
    if (due < start || due > end) continue
    const sourceRef = `recurring:${latest.id}:${due}`
    if (existingRefs.has(sourceRef)) continue
    // Already there if any entry that month moves the same accounts — at any amount. Recurring
    // patterns are found by exact repeats, but the next occurrence (interest, a fee) can differ.
    const duplicate = ((existingRows as any[]) ?? []).some(entry => monthKey(entry.entry_date) === monthKey(due)
      && accountSet(entry.journal_postings ?? []) === accountSet(latest.journal_postings ?? []))
    if (duplicate) continue
    out.push({
      id: sourceRef, sourceRef, basis: 'recurring_pattern', title: shiftMemoMonth(latest.memo || 'Recurring journal entry', latest.entry_date, due),
      detail: `Suggested because matching entries were posted in ${monthKey(previous.entry_date)} and ${monthKey(latest.entry_date)}.`,
      entryDate: due, memo: shiftMemoMonth(latest.memo || 'Recurring journal entry', latest.entry_date, due), sourceType: latest.source_type || 'adjusting', required: false,
      postings: (latest.journal_postings ?? []).map((line: any) => ({ accountId: line.account_id, amount: Number(line.amount), currency: line.currency || 'USD', lpEntityId: line.lp_entity_id })),
      evidence: { priorEntryIds: [previous.id, latest.id] },
    })
  }
  return out.sort((a, b) => a.entryDate.localeCompare(b.entryDate) || a.title.localeCompare(b.title))
}

export async function createSuggestedDrafts(
  admin: SupabaseClient, fundId: string, group: string, userId: string | null,
  start: string, end: string, ids: string[],
): Promise<{ created: string[] } | { error: string }> {
  const available = await loadCloseEntrySuggestions(admin, fundId, group, start, end)
  const selected = available.filter(item => ids.includes(item.id))
  if (selected.length !== ids.length) return { error: 'One or more suggestions changed; preview the close again.' }
  const created: string[] = []
  for (const suggestion of selected) {
    const entry: JournalEntry = {
      fundId, entryDate: suggestion.entryDate, memo: suggestion.memo, sourceType: suggestion.sourceType,
      sourceRef: suggestion.sourceRef, adjusting: true, postings: suggestion.postings,
    }
    const result = await persistEntry(admin, fundId, group, userId, entry, 'draft')
    if ('error' in result) return { error: `${suggestion.title}: ${result.error}` }
    created.push(result.entryId)
  }
  return { created }
}
