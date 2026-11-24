// Recurring journal entries: an entry that repeats on a cadence, reminded, drafted or posted on each
// due date.
//
// Stored in accounting_schedules (with accounting_schedule_lines), one row per recurring entry:
//
//   frequency + day_of_month   monthly, quarterly, semiannual or annual, on that day of the month
//                              (31 = the month's last day), counted from start_date's month, until
//                              end_date when there is one;
//   mode                       remind: the reminder digest lists each due date until it is booked,
//                              and the close suggests it (close-suggestions.ts);
//                              draft: the daily run saves a draft for a person to post;
//                              post: the daily run posts it;
//   kind                       fixed: the stored lines, the same every time;
//                              management_fee_spread: the 1st of each month recognizes that month's
//                              share of the vehicle's management fee billed in advance (month ends
//                              when billed in arrears). fee-periods.ts books it; its lines come from
//                              the fee schedule, not from here.
//
// Each occurrence's entry carries source_ref `schedule:<id>:<date>` (a fee spread's keep their
// `fee-period:<id>:<kind>:<date>`), which is how an occurrence is known to be booked, whatever
// happened to it since (a voided one counts as not booked).
//
// THE DAILY RUN NEVER BACK-BOOKS. It books only dates on or after `auto_from`, the day the mode was
// last set to draft or post. Earlier unbooked dates are listed as missed, for a person to pick and
// book after reviewing exactly what will be posted (preview, then book).
//
// The route (app/api/accounting/recurring-entries), the MCP tools (recurring_entries,
// update_recurring_entries) and the daily tick (app/api/cron/recurring-entries) all go through
// runRecurringAction / runDueRecurringEntries here, so the doors behave the same.

import type { SupabaseClient } from '@supabase/supabase-js'
import { roundCents } from '@portfolio/fund-engine'
import { ACTUAL_BOOK } from './books'
import { persistEntry } from './persist'
import { vehicleIdByName, vehicleNameById } from './vehicle-id'
import { ENTRY_SOURCE_TYPES } from './source-types'
import { renderMemo, scheduledMonth } from './close-suggestions'

export { renderMemo }
import { FEE_SPREAD_KIND, FEE_SPREAD_NAME, setFeeSpread } from './fee-spread-switch'
import type { JournalEntry, Posting } from './types'

export const RECURRING_FREQUENCIES = ['monthly', 'quarterly', 'semiannual', 'annual'] as const
export type RecurringFrequency = (typeof RECURRING_FREQUENCIES)[number]
export const RECURRING_MODES = ['remind', 'draft', 'post'] as const
export type RecurringMode = (typeof RECURRING_MODES)[number]
export type RecurringKind = 'fixed' | typeof FEE_SPREAD_KIND

const STEP: Record<RecurringFrequency, number> = { monthly: 1, quarterly: 3, semiannual: 6, annual: 12 }
const FREQ_LABEL: Record<RecurringFrequency, string> = { monthly: 'Monthly', quarterly: 'Quarterly', semiannual: 'Every six months', annual: 'Yearly' }
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December']
const DATE = /^\d{4}-\d{2}-\d{2}$/
/** How far back the list looks for missed dates, so a schedule started years ago stays readable. */
const MAX_OCCURRENCES = 120

export interface RecurringLine {
  accountId: string
  /** Signed: debits positive, credits negative. */
  amount: number
  lpEntityId: string | null
}

export interface RecurringSchedule {
  id: string
  vehicleId: string
  name: string
  memo: string | null
  kind: RecurringKind
  templateKey: string | null
  sourceType: string
  frequency: RecurringFrequency
  dayOfMonth: number
  startDate: string
  endDate: string | null
  mode: RecurringMode
  reminderDays: number
  requiredForClose: boolean
  active: boolean
  autoFrom: string | null
  lastRunAt: string | null
  lastError: string | null
  lines: RecurringLine[]
}

// ─── Pure ──────────────────────────────────────────────────────────────────────────────────────

/** "Monthly on the last day", "Quarterly on day 15, from March". */
export function cadenceLabel(s: Pick<RecurringSchedule, 'frequency' | 'dayOfMonth' | 'startDate'>): string {
  const day = s.dayOfMonth >= 31 ? 'the last day' : `day ${s.dayOfMonth}`
  const from = s.frequency === 'monthly' ? '' : `, from ${MONTHS[Number(s.startDate.slice(5, 7)) - 1]}`
  return `${FREQ_LABEL[s.frequency]} on ${day}${from}`
}

/**
 * Every due date from `from` through `through` (inclusive), oldest first: the start month and every
 * `step` months after it, on the day (clamped to the month's last), never before the start date or
 * after the end date.
 */
export function occurrenceDates(
  s: Pick<RecurringSchedule, 'frequency' | 'dayOfMonth' | 'startDate' | 'endDate'>,
  from: string,
  through: string,
): string[] {
  const step = STEP[s.frequency] ?? 1
  const out: string[] = []
  // Jump close to `from` instead of walking from a start years back.
  const monthsBetween = (Number(from.slice(0, 4)) - Number(s.startDate.slice(0, 4))) * 12 + Number(from.slice(5, 7)) - Number(s.startDate.slice(5, 7))
  let k = Math.max(0, Math.floor(monthsBetween / step) - 1)
  for (let guard = 0; guard < 2000; guard++, k++) {
    const due = scheduledMonth(s.startDate, k * step, s.dayOfMonth)
    if (due > through || (s.endDate && due > s.endDate)) break
    if (due >= from && due >= s.startDate) out.push(due)
  }
  return out
}

/** The next due date after `after`, or null when the schedule has ended. */
export function nextOccurrence(s: Pick<RecurringSchedule, 'frequency' | 'dayOfMonth' | 'startDate' | 'endDate'>, after: string): string | null {
  const horizon = scheduledMonth(after, 13, 31)
  return occurrenceDates(s, nextDay(after), horizon)[0] ?? null
}

function nextDay(date: string): string {
  const d = new Date(`${date}T00:00:00Z`)
  d.setUTCDate(d.getUTCDate() + 1)
  return d.toISOString().slice(0, 10)
}

function addDaysIso(date: string, days: number): string {
  const d = new Date(`${date}T00:00:00Z`)
  d.setUTCDate(d.getUTCDate() + days)
  return d.toISOString().slice(0, 10)
}

export const scheduleRef = (id: string, date: string) => `schedule:${id}:${date}`

/** The entry one occurrence of a fixed schedule books. */
export function buildRecurringEntry(fundId: string, s: Pick<RecurringSchedule, 'id' | 'name' | 'memo' | 'sourceType' | 'lines'>, date: string): JournalEntry {
  const postings: Posting[] = s.lines.map(l => ({ accountId: l.accountId, amount: roundCents(l.amount), currency: 'USD', lpEntityId: l.lpEntityId }))
  return {
    fundId, entryDate: date, memo: renderMemo(s.memo || s.name, date), sourceType: s.sourceType,
    sourceRef: scheduleRef(s.id, date), adjusting: s.sourceType === 'adjusting', postings,
  }
}

export interface RecurringInput {
  name: string
  memo: string | null
  sourceType: string
  frequency: RecurringFrequency
  dayOfMonth: number
  startDate: string
  endDate: string | null
  mode: RecurringMode
  reminderDays: number
  requiredForClose: boolean
  lines: RecurringLine[]
}

/**
 * Check a recurring entry without touching the database. `partial` checks only the fields given (an
 * update); lines, when given, must be at least two and balance to the cent.
 */
export function parseRecurringInput(raw: any, partial = false): { ok: true; value: Partial<RecurringInput> } | { error: string } {
  if (!raw || typeof raw !== 'object') return { error: 'The recurring entry must be an object.' }
  const v: Partial<RecurringInput> = {}
  const has = (k: string) => raw[k] !== undefined
  if (!partial || has('name')) {
    const name = String(raw.name ?? '').trim()
    if (!name) return { error: 'Give the recurring entry a name.' }
    if (name.length > 120) return { error: 'Keep the name under 120 characters.' }
    v.name = name
  }
  if (has('memo')) v.memo = raw.memo == null || String(raw.memo).trim() === '' ? null : String(raw.memo).trim().slice(0, 500)
  if (has('sourceType')) {
    const t = String(raw.sourceType)
    if (!(ENTRY_SOURCE_TYPES as readonly string[]).includes(t) && t !== 'adjusting') return { error: `sourceType is one of ${ENTRY_SOURCE_TYPES.join(', ')}.` }
    v.sourceType = t
  }
  if (!partial || has('frequency')) {
    if (!RECURRING_FREQUENCIES.includes(raw.frequency)) return { error: 'frequency is monthly, quarterly, semiannual or annual.' }
    v.frequency = raw.frequency
  }
  if (!partial || has('dayOfMonth')) {
    const day = raw.dayOfMonth === 'last' ? 31 : Number(raw.dayOfMonth ?? 31)
    if (!(Number.isInteger(day) && day >= 1 && day <= 31)) return { error: 'dayOfMonth is 1 to 31 (31, or "last", is the month\'s last day).' }
    v.dayOfMonth = day
  }
  if (!partial || has('startDate')) {
    if (typeof raw.startDate !== 'string' || !DATE.test(raw.startDate)) return { error: 'startDate is a date (YYYY-MM-DD).' }
    v.startDate = raw.startDate
  }
  if (has('endDate')) {
    if (raw.endDate == null || raw.endDate === '') v.endDate = null
    else if (typeof raw.endDate !== 'string' || !DATE.test(raw.endDate)) return { error: 'endDate is a date (YYYY-MM-DD) or empty.' }
    else v.endDate = raw.endDate
  }
  if (v.startDate && v.endDate && v.endDate < v.startDate) return { error: 'The end date is before the start date.' }
  if (has('mode')) {
    if (!RECURRING_MODES.includes(raw.mode)) return { error: 'mode is remind, draft or post.' }
    v.mode = raw.mode
  }
  if (has('reminderDays')) {
    const d = Number(raw.reminderDays)
    if (!(Number.isInteger(d) && d >= 0 && d <= 60)) return { error: 'reminderDays is a whole number of days from 0 to 60.' }
    v.reminderDays = d
  }
  if (has('requiredForClose')) v.requiredForClose = raw.requiredForClose !== false
  if (has('lines')) {
    if (!Array.isArray(raw.lines)) return { error: 'lines is a list of { accountId, amount } (debits positive, credits negative).' }
    const lines: RecurringLine[] = []
    for (const l of raw.lines) {
      const amount = roundCents(Number(l?.amount))
      if (!l?.accountId || typeof l.accountId !== 'string') return { error: 'Each line needs an account.' }
      if (!Number.isFinite(amount) || amount === 0) return { error: 'Each line needs a non-zero amount (debits positive, credits negative).' }
      lines.push({ accountId: l.accountId, amount, lpEntityId: l.lpEntityId ? String(l.lpEntityId) : null })
    }
    if (lines.length < 2) return { error: 'A recurring entry needs at least two lines.' }
    const sum = roundCents(lines.reduce((s, l) => s + l.amount, 0))
    if (sum !== 0) return { error: `The lines must balance: debits and credits are ${sum > 0 ? 'off by ' + sum.toFixed(2) + ' (more debits)' : 'off by ' + (-sum).toFixed(2) + ' (more credits)'}.` }
    v.lines = lines
  } else if (!partial) {
    return { error: 'A recurring entry needs its lines.' }
  }
  return { ok: true, value: v }
}

// ─── Templates ─────────────────────────────────────────────────────────────────────────────────

export interface RecurringTemplate {
  key: string
  name: string
  description: string
  frequency: RecurringFrequency
  dayOfMonth: number
  sourceType: string
  memo: string | null
  /** Each line: the first account of these subtypes the vehicle's chart has, and its side. */
  lines: { side: 'debit' | 'credit'; subtypes: string[]; label: string }[]
}

/**
 * Prebuilt starting points. A fixed template only fills the form (name, cadence, accounts by
 * subtype); the amounts are the person's. The management fee spread is computed from the fee
 * schedule and offered only where the vehicle has one.
 */
export const RECURRING_TEMPLATES: RecurringTemplate[] = [
  {
    key: FEE_SPREAD_KIND, name: FEE_SPREAD_NAME,
    description: 'On the 1st of each month, recognize that month\'s share of a management fee billed in advance, out of prepaid fees on the fund (and deferred revenue on the management company), whenever the cash arrives. Billed in arrears, it accrues at each month end instead. The amounts come from the fee schedule; the quarter\'s bill and invoice stay on the fee schedule.',
    frequency: 'monthly', dayOfMonth: 1, sourceType: 'management_fee', memo: null, lines: [],
  },
  {
    key: 'accrue_expense', name: 'Accrue a recurring expense',
    description: 'Book an expense that builds up before it is billed, such as audit, tax or administration fees, a little each month.',
    frequency: 'monthly', dayOfMonth: 31, sourceType: 'partnership_expense', memo: 'Accrued expense, {month}',
    lines: [
      { side: 'debit', subtypes: ['professional_fees', 'fund_administration', 'partnership_expense', 'operating_expense'], label: 'Expense' },
      { side: 'credit', subtypes: ['accrued'], label: 'Accrued expenses' },
    ],
  },
  {
    key: 'release_prepaid', name: 'Release a prepaid expense',
    description: 'Spread a cost paid up front, such as insurance or a software subscription, over the months it covers.',
    frequency: 'monthly', dayOfMonth: 31, sourceType: 'partnership_expense', memo: 'Prepaid expense released, {month}',
    lines: [
      { side: 'debit', subtypes: ['insurance', 'technology', 'professional_fees', 'partnership_expense', 'operating_expense'], label: 'Expense' },
      { side: 'credit', subtypes: ['prepaid'], label: 'Prepaid expenses' },
    ],
  },
  {
    key: 'accrue_interest', name: 'Accrue loan interest',
    description: 'Accrue interest on a loan or credit line each period until it is paid.',
    frequency: 'monthly', dayOfMonth: 31, sourceType: 'partnership_expense', memo: 'Interest accrued, {month}',
    lines: [
      { side: 'debit', subtypes: ['interest_expense'], label: 'Interest expense' },
      { side: 'credit', subtypes: ['accrued'], label: 'Accrued expenses' },
    ],
  },
]

// ─── Database ──────────────────────────────────────────────────────────────────────────────────

const SELECT = 'id, vehicle_id, name, memo, kind, template_key, source_type, frequency, day_of_month, start_date, end_date, mode, reminder_days, required_for_close, active, auto_from, last_run_at, last_error, accounting_schedule_lines(account_id, amount, lp_entity_id, sort_order)'

function rowToSchedule(r: any): RecurringSchedule {
  return {
    id: r.id, vehicleId: r.vehicle_id, name: r.name, memo: r.memo ?? null, kind: (r.kind ?? 'fixed') as RecurringKind,
    templateKey: r.template_key ?? null, sourceType: r.source_type ?? 'manual',
    frequency: (RECURRING_FREQUENCIES.includes(r.frequency) ? r.frequency : 'monthly') as RecurringFrequency,
    dayOfMonth: Number(r.day_of_month ?? 31), startDate: r.start_date, endDate: r.end_date ?? null,
    mode: (r.mode ?? 'remind') as RecurringMode, reminderDays: Number(r.reminder_days ?? 3),
    requiredForClose: r.required_for_close !== false, active: r.active !== false, autoFrom: r.auto_from ?? null,
    lastRunAt: r.last_run_at ?? null, lastError: r.last_error ?? null,
    lines: [...(r.accounting_schedule_lines ?? [])].sort((a: any, b: any) => a.sort_order - b.sort_order)
      .map((l: any) => ({ accountId: l.account_id, amount: Number(l.amount), lpEntityId: l.lp_entity_id ?? null })),
  }
}

async function readSchedules(admin: SupabaseClient, fundId: string, vehicleId: string | null): Promise<RecurringSchedule[] | { error: string }> {
  let q = (admin as any).from('accounting_schedules').select(SELECT).eq('fund_id', fundId)
  if (vehicleId) q = q.eq('vehicle_id', vehicleId)
  const { data, error } = await q.order('created_at', { ascending: true })
  if (error) return { error: `Recurring entries could not be read (${error.message}). Has migration 20261124060000 been applied?` }
  return ((data as any[]) ?? []).map(rowToSchedule)
}

async function oneSchedule(admin: SupabaseClient, fundId: string, vehicleId: string, id: string): Promise<RecurringSchedule | { error: string; status: number }> {
  const { data, error } = await (admin as any).from('accounting_schedules').select(SELECT).eq('fund_id', fundId).eq('vehicle_id', vehicleId).eq('id', id).maybeSingle()
  if (error) return { error: error.message, status: 500 }
  if (!data) return { error: 'No such recurring entry on this vehicle.', status: 404 }
  return rowToSchedule(data)
}

/** Each fixed occurrence's live (draft or posted) entry, by date. */
async function bookedFixed(admin: SupabaseClient, fundId: string, vehicleId: string, ids: string[]): Promise<Map<string, Map<string, { entryId: string; status: 'draft' | 'posted' }>>> {
  const out = new Map<string, Map<string, { entryId: string; status: 'draft' | 'posted' }>>()
  if (ids.length === 0) return out
  for (const id of ids) out.set(id, new Map())
  const { data } = await (admin as any).from('journal_entries').select('id, status, source_ref')
    .eq('book', ACTUAL_BOOK).eq('fund_id', fundId).eq('vehicle_id', vehicleId).like('source_ref', 'schedule:%').in('status', ['draft', 'posted'])
  for (const e of (data as any[]) ?? []) {
    const m = /^schedule:([0-9a-f-]+):(\d{4}-\d{2}-\d{2})$/.exec(e.source_ref ?? '')
    if (!m || !out.has(m[1])) continue
    out.get(m[1])!.set(m[2], { entryId: e.id, status: e.status })
  }
  return out
}

async function accountsFor(admin: SupabaseClient, fundId: string, vehicleId: string): Promise<Map<string, { code: string; name: string; type: string; subtype: string | null; lpEntityId: string | null }>> {
  const { data } = await (admin as any).from('chart_of_accounts').select('id, code, name, type, subtype, lp_entity_id').eq('fund_id', fundId).eq('vehicle_id', vehicleId)
  return new Map(((data as any[]) ?? []).map(a => [a.id as string, { code: a.code, name: a.name, type: a.type, subtype: a.subtype ?? null, lpEntityId: a.lp_entity_id ?? null }]))
}

/** One due date of a recurring entry, booked or not. */
export interface RecurringOccurrence {
  date: string
  amount: number
  entryId: string | null
  status: 'draft' | 'posted' | null
  /** Fee spread, in advance: the period's bill is not booked yet. */
  waitingForBill?: boolean
}

export interface RecurringEntryView extends RecurringSchedule {
  cadence: string
  /** The total of the debits: what one occurrence moves. */
  amount: number
  lines: (RecurringLine & { code: string | null; accountName: string | null })[]
  nextDue: string | null
  lastBooked: RecurringOccurrence | null
  /** Due dates on or before today with nothing booked. */
  missed: RecurringOccurrence[]
  /** Booked as drafts, waiting for a person to post. */
  drafts: RecurringOccurrence[]
}

export interface RecurringEntriesList {
  vehicle: string
  entries: RecurringEntryView[]
  templates: { key: string; name: string; description: string; frequency: RecurringFrequency; dayOfMonth: number; sourceType: string; memo: string | null; lines: { accountId: string | null; side: 'debit' | 'credit'; label: string }[]; available: boolean; reason?: string }[]
}

/** All of a fixed schedule's occurrences up to today and its next one, with what is booked. */
function fixedOccurrences(s: RecurringSchedule, booked: Map<string, { entryId: string; status: 'draft' | 'posted' }>, today: string) {
  const amount = roundCents(s.lines.filter(l => l.amount > 0).reduce((t, l) => t + l.amount, 0))
  const all = occurrenceDates(s, s.startDate, today)
  const past: RecurringOccurrence[] = all.slice(-MAX_OCCURRENCES).map(date => {
    const b = booked.get(date)
    return { date, amount, entryId: b?.entryId ?? null, status: b?.status ?? null }
  })
  return { amount, past, next: nextOccurrence(s, today) }
}

async function feeOccurrences(admin: SupabaseClient, fundId: string, group: string, s: RecurringSchedule, today: string) {
  const { feeMonthSlices } = await import('./fee-periods')
  const slices = await feeMonthSlices(admin, fundId, group)
  if ('error' in slices) return { error: slices.error }
  // One occurrence per date (two periods never share a month end, but sum to be safe).
  const byDate = new Map<string, RecurringOccurrence>()
  for (const x of slices) {
    if (x.date < s.startDate || (s.endDate && x.date > s.endDate)) continue
    const prev = byDate.get(x.date)
    const status = prev ? (prev.status === 'draft' || x.entryStatus === 'draft' ? 'draft' : prev.status && x.entryStatus ? 'posted' : null) : x.entryStatus
    byDate.set(x.date, {
      date: x.date, amount: roundCents((prev?.amount ?? 0) + x.amount), entryId: prev?.entryId ?? x.entryId, status,
      ...(x.kind === 'recognize' && !x.billBooked ? { waitingForBill: true } : prev?.waitingForBill ? { waitingForBill: true } : {}),
    })
  }
  const all = [...byDate.values()].sort((a, b) => a.date.localeCompare(b.date))
  const past = all.filter(o => o.date <= today)
  const next = all.find(o => o.date > today)
  return { past, next: next?.date ?? null, amount: next?.amount ?? past[past.length - 1]?.amount ?? 0, all }
}

async function viewOf(admin: SupabaseClient, fundId: string, group: string, s: RecurringSchedule, booked: Map<string, { entryId: string; status: 'draft' | 'posted' }>, accounts: Awaited<ReturnType<typeof accountsFor>>, today: string): Promise<RecurringEntryView> {
  const lines = s.lines.map(l => ({ ...l, code: accounts.get(l.accountId)?.code ?? null, accountName: accounts.get(l.accountId)?.name ?? null }))
  let past: RecurringOccurrence[] = [], next: string | null = null, amount = 0, lastError = s.lastError
  if (s.kind === FEE_SPREAD_KIND) {
    const f = await feeOccurrences(admin, fundId, group, s, today)
    if ('error' in f) lastError = f.error ?? lastError
    else ({ past, next, amount } = f)
  } else {
    ({ past, next, amount } = fixedOccurrences(s, booked, today))
  }
  const bookedPast = past.filter(o => o.status)
  return {
    ...s, lastError, cadence: s.kind === FEE_SPREAD_KIND ? 'Monthly from the fee schedule (the 1st of each month when billed in advance)' : cadenceLabel(s), amount, lines,
    nextDue: s.active ? next : null,
    lastBooked: bookedPast[bookedPast.length - 1] ?? null,
    missed: past.filter(o => !o.status),
    drafts: past.filter(o => o.status === 'draft'),
  }
}

/** A vehicle's recurring entries with their due dates and what is booked, and the templates. */
export async function listRecurringEntries(admin: SupabaseClient, fundId: string, group: string, today = new Date().toISOString().slice(0, 10)): Promise<RecurringEntriesList | { error: string }> {
  const vehicleId = await vehicleIdByName(admin, fundId, group)
  if (!vehicleId) return { error: `Unknown vehicle "${group}".` }
  const schedules = await readSchedules(admin, fundId, vehicleId)
  if ('error' in schedules) return schedules
  const booked = await bookedFixed(admin, fundId, vehicleId, schedules.filter(s => s.kind === 'fixed').map(s => s.id))
  const accounts = await accountsFor(admin, fundId, vehicleId)
  const entries: RecurringEntryView[] = []
  for (const s of schedules) entries.push(await viewOf(admin, fundId, group, s, booked.get(s.id) ?? new Map(), accounts, today))
  return { vehicle: group, entries, templates: await templatesFor(admin, fundId, group, vehicleId, accounts, schedules) }
}

async function templatesFor(admin: SupabaseClient, fundId: string, group: string, vehicleId: string, accounts: Awaited<ReturnType<typeof accountsFor>>, schedules: RecurringSchedule[]): Promise<RecurringEntriesList['templates']> {
  const { data: fee } = await (admin as any).from('vehicle_accounting_settings').select('fee_schedule').eq('fund_id', fundId).eq('vehicle_id', vehicleId).maybeSingle()
  const hasFee = !!fee?.fee_schedule
  const hasSpread = schedules.some(s => s.kind === FEE_SPREAD_KIND)
  const bySubtype = (subtypes: string[]) => {
    for (const st of subtypes) for (const [id, a] of accounts) if (a.subtype === st && !a.lpEntityId) return id
    return null
  }
  return RECURRING_TEMPLATES.map(t => {
    if (t.key === FEE_SPREAD_KIND) {
      const available = hasFee && !hasSpread
      return {
        key: t.key, name: t.name, description: t.description, frequency: t.frequency, dayOfMonth: t.dayOfMonth, sourceType: t.sourceType, memo: t.memo, lines: [],
        available, ...(available ? {} : { reason: hasSpread ? `${group} already has a management fee spread.` : `${group} has no management fee schedule (Allocation terms).` }),
      }
    }
    return {
      key: t.key, name: t.name, description: t.description, frequency: t.frequency, dayOfMonth: t.dayOfMonth, sourceType: t.sourceType, memo: t.memo,
      lines: t.lines.map(l => ({ accountId: bySubtype(l.subtypes), side: l.side, label: l.label })), available: true,
    }
  })
}

async function writeLines(admin: SupabaseClient, scheduleId: string, lines: RecurringLine[]): Promise<{ error?: string }> {
  const { error: delErr } = await (admin as any).from('accounting_schedule_lines').delete().eq('schedule_id', scheduleId)
  if (delErr) return { error: delErr.message }
  const { error } = await (admin as any).from('accounting_schedule_lines').insert(lines.map((l, i) => ({
    schedule_id: scheduleId, account_id: l.accountId, amount: l.amount, lp_entity_id: l.lpEntityId, sort_order: i,
  })))
  return error ? { error: error.message } : {}
}

async function checkAccounts(admin: SupabaseClient, fundId: string, vehicleId: string, group: string, lines: RecurringLine[]): Promise<string | null> {
  const accounts = await accountsFor(admin, fundId, vehicleId)
  for (const l of lines) {
    const a = accounts.get(l.accountId)
    if (!a) return `Account ${l.accountId} is not in ${group}'s chart of accounts.`
    if (a.lpEntityId && l.lpEntityId && a.lpEntityId !== l.lpEntityId) return `Account ${a.code} belongs to another partner.`
  }
  return null
}

// ─── Booking ───────────────────────────────────────────────────────────────────────────────────

export interface RecurringCaller {
  fundId: string
  userId: string | null
  role: string
  mayTouchInvestments: () => Promise<boolean>
}

export interface PreviewItem {
  date: string
  memo: string
  /** What booking does to this date: create a draft, post a new entry, post an existing draft, or nothing (already booked). */
  action: 'draft' | 'post' | 'post_draft' | 'skip'
  reason?: string
  lines: { code: string | null; account: string | null; amount: number }[]
}

/**
 * The review step: exactly what booking these dates would write, without writing anything. Fixed
 * entries list their lines; a fee spread lists the fund side's recognition for each month.
 */
export async function previewRecurring(
  admin: SupabaseClient, fundId: string, group: string, scheduleId: string, dates: string[], mode: 'draft' | 'post',
  today = new Date().toISOString().slice(0, 10),
): Promise<{ entry: string; items: PreviewItem[] } | { error: string; status: number }> {
  const vehicleId = await vehicleIdByName(admin, fundId, group)
  if (!vehicleId) return { error: `Unknown vehicle "${group}".`, status: 400 }
  const s = await oneSchedule(admin, fundId, vehicleId, scheduleId)
  if ('error' in s) return s
  const accounts = await accountsFor(admin, fundId, vehicleId)
  const items: PreviewItem[] = []
  if (s.kind === FEE_SPREAD_KIND) {
    const f = await feeOccurrences(admin, fundId, group, s, today)
    if ('error' in f) return { error: f.error ?? 'The fee schedule could not be read.', status: 400 }
    const byDate = new Map(f.all.map(o => [o.date, o]))
    const codes = new Map([...accounts.values()].map(a => [a.subtype, a]))
    for (const date of [...new Set(dates)].sort()) {
      const o = byDate.get(date)
      if (!o) { items.push({ date, memo: 'Not a date the fee schedule spreads.', action: 'skip', reason: 'no fee covers this month', lines: [] }); continue }
      const action = o.status === 'posted' ? 'skip' : o.status === 'draft' ? (mode === 'post' ? 'post_draft' : 'skip') : mode
      const expense = codes.get('management_fee'), prepaid = codes.get('prepaid_management_fee')
      items.push({
        date, memo: `${FEE_SPREAD_NAME}, through ${date}`, action,
        ...(action === 'skip' ? { reason: o.status === 'posted' ? 'already posted' : 'already drafted' } : o.waitingForBill ? { reason: 'the period\'s bill is not booked yet, so prepaid fees would go negative until it is' } : {}),
        lines: [
          { code: expense?.code ?? null, account: expense?.name ?? 'Management fee', amount: o.amount },
          { code: prepaid?.code ?? null, account: o.waitingForBill === undefined && prepaid ? prepaid.name : (prepaid?.name ?? 'Prepaid management fees'), amount: -o.amount },
        ],
      })
    }
    return { entry: s.name, items }
  }
  const booked = (await bookedFixed(admin, fundId, vehicleId, [s.id])).get(s.id) ?? new Map()
  const valid = new Set(occurrenceDates(s, s.startDate, scheduledMonth(today, 24, 31)))
  for (const date of [...new Set(dates)].sort()) {
    const entry = buildRecurringEntry(fundId, s, date)
    const b = booked.get(date)
    const action: PreviewItem['action'] = !valid.has(date) ? 'skip' : b?.status === 'posted' ? 'skip' : b?.status === 'draft' ? (mode === 'post' ? 'post_draft' : 'skip') : mode
    items.push({
      date, memo: entry.memo ?? s.name, action,
      ...(!valid.has(date) ? { reason: 'not one of this entry\'s due dates' } : action === 'skip' ? { reason: b?.status === 'posted' ? 'already posted' : 'already drafted' } : {}),
      lines: s.lines.map(l => ({ code: accounts.get(l.accountId)?.code ?? null, account: accounts.get(l.accountId)?.name ?? null, amount: l.amount })),
    })
  }
  return { entry: s.name, items }
}

/**
 * Book these due dates of one recurring entry: draft or post each that has nothing yet, and (mode
 * post) post the drafts waiting. Stops at the first failure and says which date; what was booked
 * before it stays booked.
 */
export async function bookRecurring(
  admin: SupabaseClient, who: RecurringCaller, group: string, scheduleId: string, dates: string[], mode: 'draft' | 'post',
  today = new Date().toISOString().slice(0, 10),
): Promise<{ booked: { date: string; entryId: string | null; status: 'draft' | 'posted' }[]; skipped: string[]; warnings: string[] } | { error: string; status: number }> {
  const vehicleId = await vehicleIdByName(admin, who.fundId, group)
  if (!vehicleId) return { error: `Unknown vehicle "${group}".`, status: 400 }
  const s = await oneSchedule(admin, who.fundId, vehicleId, scheduleId)
  if ('error' in s) return s
  const wanted = [...new Set(dates)].filter(d => DATE.test(d)).sort()
  if (wanted.length === 0) return { error: 'Pick at least one date to book.', status: 400 }
  const { entryPromoter } = await import('./fee-periods')
  const promote = mode === 'post' ? await entryPromoter(admin, who, group) : undefined

  if (s.kind === FEE_SPREAD_KIND) {
    const { bookFeeMonths } = await import('./fee-periods')
    const f = await feeOccurrences(admin, who.fundId, group, s, today)
    if ('error' in f) return { error: f.error ?? 'The fee schedule could not be read.', status: 400 }
    const byDate = new Map(f.all.map(o => [o.date, o]))
    const todo = wanted.filter(d => { const o = byDate.get(d); return o && o.status !== 'posted' && !(o.status === 'draft' && mode === 'draft') })
    const skipped = wanted.filter(d => !todo.includes(d))
    if (todo.length === 0) return { booked: [], skipped, warnings: [] }
    const r = await bookFeeMonths(admin, who.fundId, group, who.userId, { dates: todo, mode, promote })
    if ('error' in r) return r
    const warnings = [...r.warnings]
    if (todo.some(d => byDate.get(d)?.waitingForBill)) warnings.push('Some months were recognized before their period\'s bill was booked; prepaid fees stay negative until the bill is booked on the fee schedule.')
    return { booked: todo.map(date => ({ date, entryId: null, status: mode === 'post' ? 'posted' : 'draft' })), skipped, warnings }
  }

  const valid = new Set(occurrenceDates(s, s.startDate, scheduledMonth(today, 24, 31)))
  const existing = (await bookedFixed(admin, who.fundId, vehicleId, [s.id])).get(s.id) ?? new Map()
  const booked: { date: string; entryId: string | null; status: 'draft' | 'posted' }[] = []
  const skipped: string[] = []
  for (const date of wanted) {
    const have = existing.get(date)
    if (!valid.has(date) || have?.status === 'posted' || (have?.status === 'draft' && mode === 'draft')) { skipped.push(date); continue }
    if (have?.status === 'draft' && promote) {
      const r = await promote(have.entryId)
      if (r.error) return { error: `${date}: ${r.error}`, status: 400 }
      booked.push({ date, entryId: have.entryId, status: 'posted' })
      continue
    }
    const res = await persistEntry(admin, who.fundId, group, who.userId, buildRecurringEntry(who.fundId, s, date), mode === 'post' ? 'posted' : 'draft')
    if ('error' in res) return { error: `${date}: ${res.error}`, status: 400 }
    booked.push({ date, entryId: res.entryId, status: mode === 'post' ? 'posted' : 'draft' })
  }
  return { booked, skipped, warnings: [] }
}

/**
 * The daily run: every active recurring entry of `kind` set to draft or post books its due dates
 * from `auto_from` through today that have nothing yet. Errors stay on the entry (last_error); one
 * failing never stops the rest.
 *
 * Fixed entries run in the recurring-entries worker. Fee spreads run in the fee-periods worker,
 * right after it books the day's bills, so a month recognized on the 1st finds its quarter's bill
 * already booked (a month whose bill is still missing waits for it) and the two never race.
 */
export async function runDueRecurringEntries(
  admin: SupabaseClient, today: string, kind: RecurringKind,
): Promise<{ entries: number; booked: number; errors: string[] }> {
  const { data, error } = await (admin as any).from('accounting_schedules').select(`fund_id, ${SELECT}`).eq('active', true).eq('kind', kind).in('mode', ['draft', 'post'])
  if (error) return { entries: 0, booked: 0, errors: [error.message] }
  const errors: string[] = []
  let entries = 0, booked = 0
  for (const row of (data as any[]) ?? []) {
    const s = rowToSchedule(row)
    const fundId = row.fund_id as string
    const group = await vehicleNameById(admin, fundId, s.vehicleId)
    if (!group) continue
    entries++
    const from = s.autoFrom && s.autoFrom > s.startDate ? s.autoFrom : s.startDate
    let dates: string[]
    if (s.kind === FEE_SPREAD_KIND) {
      const f = await feeOccurrences(admin, fundId, group, s, today)
      if ('error' in f) { errors.push(`${group} ${s.name}: ${f.error}`); await noteRun(admin, s.id, f.error ?? 'error'); continue }
      dates = f.past.filter(o => o.date >= from && !o.status && !o.waitingForBill).map(o => o.date)
    } else {
      const have = (await bookedFixed(admin, fundId, s.vehicleId, [s.id])).get(s.id) ?? new Map()
      dates = occurrenceDates(s, from, today).filter(d => !have.has(d))
    }
    if (dates.length === 0) { await noteRun(admin, s.id, null); continue }
    const r = await bookRecurring(admin, { fundId, userId: null, role: 'system', mayTouchInvestments: async () => false }, group, s.id, dates, s.mode === 'post' ? 'post' : 'draft', today)
    if ('error' in r) { errors.push(`${group} ${s.name}: ${r.error}`); await noteRun(admin, s.id, r.error); continue }
    booked += r.booked.length
    await noteRun(admin, s.id, null)
  }
  return { entries, booked, errors }
}

async function noteRun(admin: SupabaseClient, id: string, err: string | null) {
  await (admin as any).from('accounting_schedules').update({ last_run_at: new Date().toISOString(), last_error: err }).eq('id', id)
}

// ─── Actions ───────────────────────────────────────────────────────────────────────────────────

/**
 * One action on a vehicle's recurring entries, shared by the route and the MCP tools:
 *   create  { entry: {...} } or { template: 'management_fee_spread', mode? }
 *   update  { id, entry: {...partial} }
 *   pause | resume | delete  { id }
 *   preview { id, dates, mode }   the review step: what booking would write
 *   book    { id, dates, mode }   book those dates (draft or post)
 */
export async function runRecurringAction(
  admin: SupabaseClient, who: RecurringCaller, group: string, body: any,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const action = String(body?.action ?? '')
  const fail = (r: { error: string; status?: number }) => ({ status: r.status ?? 400, body: { error: r.error } })
  const vehicleId = await vehicleIdByName(admin, who.fundId, group)
  if (!vehicleId) return fail({ error: `Unknown vehicle "${group}".` })
  const today = new Date().toISOString().slice(0, 10)
  const now = new Date().toISOString()

  if (action === 'create') {
    if (body?.template === FEE_SPREAD_KIND) {
      const { data: fee } = await (admin as any).from('vehicle_accounting_settings').select('fee_schedule').eq('fund_id', who.fundId).eq('vehicle_id', vehicleId).maybeSingle()
      if (!fee?.fee_schedule) return fail({ error: `${group} has no management fee schedule. Set one on the Allocation terms page (or set_fee_schedule) first.` })
      const mode = RECURRING_MODES.includes(body?.mode) ? body.mode : 'remind'
      const r = await setFeeSpread(admin, who.fundId, vehicleId, true, { userId: who.userId, mode })
      if ('error' in r) return fail(r)
      // Dates, reminder lead or a name given with the template apply to the new spread.
      const extra = body?.entry && typeof body.entry === 'object'
        ? Object.fromEntries(Object.entries(body.entry).filter(([k]) => ['name', 'startDate', 'endDate', 'reminderDays'].includes(k)))
        : {}
      if (r.id && Object.keys(extra).length > 0) {
        const u = await runRecurringAction(admin, who, group, { action: 'update', id: r.id, entry: extra })
        if (u.status >= 400) return u
      }
      return { status: 200, body: { ok: true, id: r.id } }
    }
    const parsed = parseRecurringInput(body?.entry ?? body)
    if ('error' in parsed) return fail(parsed)
    const v = parsed.value as RecurringInput
    const bad = await checkAccounts(admin, who.fundId, vehicleId, group, v.lines)
    if (bad) return fail({ error: bad })
    const mode = v.mode ?? 'remind'
    const { data: row, error } = await (admin as any).from('accounting_schedules').insert({
      fund_id: who.fundId, vehicle_id: vehicleId, name: v.name, memo: v.memo ?? null, kind: 'fixed',
      template_key: typeof body?.template === 'string' ? body.template : null, source_type: v.sourceType ?? 'manual',
      frequency: v.frequency, day_of_month: v.dayOfMonth, start_date: v.startDate, end_date: v.endDate ?? null,
      mode, auto_from: mode === 'remind' ? null : today, reminder_days: v.reminderDays ?? 3,
      required_for_close: v.requiredForClose ?? true, active: true, created_by: who.userId, updated_by: who.userId,
    }).select('id').single()
    if (error) return fail({ error: `The recurring entry could not be saved (${error.message}).`, status: 500 })
    const lw = await writeLines(admin, row.id, v.lines)
    if (lw.error) {
      await (admin as any).from('accounting_schedules').delete().eq('id', row.id)
      return fail({ error: `The lines could not be saved (${lw.error}).`, status: 500 })
    }
    return { status: 200, body: { ok: true, id: row.id } }
  }

  const id = body?.id ? String(body.id) : ''
  if (!id) return fail({ error: 'id is required.' })
  const s = await oneSchedule(admin, who.fundId, vehicleId, id)
  if ('error' in s) return fail(s)

  if (action === 'update') {
    const parsed = parseRecurringInput(body?.entry ?? body?.patch ?? {}, true)
    if ('error' in parsed) return fail(parsed)
    const v = parsed.value
    if (s.kind === FEE_SPREAD_KIND && (v.lines || v.frequency || v.dayOfMonth)) {
      return fail({ error: 'A management fee spread books every month end from the fee schedule: change its mode, dates or name here, and the fee itself on the fee schedule.' })
    }
    const start = v.startDate ?? s.startDate, end = v.endDate !== undefined ? v.endDate : s.endDate
    if (end && end < start) return fail({ error: 'The end date is before the start date.' })
    if (v.lines) {
      const bad = await checkAccounts(admin, who.fundId, vehicleId, group, v.lines)
      if (bad) return fail({ error: bad })
    }
    const patch: Record<string, unknown> = { updated_at: now, updated_by: who.userId }
    if (v.name !== undefined) patch.name = v.name
    if (v.memo !== undefined) patch.memo = v.memo
    if (v.sourceType !== undefined) patch.source_type = v.sourceType
    if (v.frequency !== undefined) patch.frequency = v.frequency
    if (v.dayOfMonth !== undefined) patch.day_of_month = v.dayOfMonth
    if (v.startDate !== undefined) patch.start_date = v.startDate
    if (v.endDate !== undefined) patch.end_date = v.endDate
    if (v.reminderDays !== undefined) patch.reminder_days = v.reminderDays
    if (v.requiredForClose !== undefined) patch.required_for_close = v.requiredForClose
    if (v.mode !== undefined && v.mode !== s.mode) {
      patch.mode = v.mode
      // Switching to draft or post arms the unattended run from today, never earlier.
      patch.auto_from = v.mode === 'remind' ? null : today
    }
    const { error } = await (admin as any).from('accounting_schedules').update(patch).eq('id', s.id).eq('fund_id', who.fundId)
    if (error) return fail({ error: error.message, status: 500 })
    if (v.lines) {
      const lw = await writeLines(admin, s.id, v.lines)
      if (lw.error) return fail({ error: `The lines could not be saved (${lw.error}).`, status: 500 })
    }
    return { status: 200, body: { ok: true, id: s.id } }
  }

  if (action === 'pause' || action === 'resume') {
    const on = action === 'resume'
    if (s.kind === FEE_SPREAD_KIND) {
      const r = await setFeeSpread(admin, who.fundId, vehicleId, on, { userId: who.userId })
      return 'error' in r ? fail(r) : { status: 200, body: { ok: true } }
    }
    const patch: Record<string, unknown> = { active: on, updated_at: now, updated_by: who.userId }
    if (on && s.mode !== 'remind') patch.auto_from = today
    const { error } = await (admin as any).from('accounting_schedules').update(patch).eq('id', s.id).eq('fund_id', who.fundId)
    return error ? fail({ error: error.message, status: 500 }) : { status: 200, body: { ok: true } }
  }

  if (action === 'delete') {
    // Its booked entries stay in the journal; only the schedule goes.
    const { error } = await (admin as any).from('accounting_schedules').delete().eq('id', s.id).eq('fund_id', who.fundId)
    return error ? fail({ error: error.message, status: 500 }) : { status: 200, body: { ok: true } }
  }

  if (action === 'preview' || action === 'book') {
    const dates = Array.isArray(body?.dates) ? body.dates.map(String) : []
    const mode = body?.mode === 'post' ? 'post' : body?.mode === 'draft' ? 'draft' : null
    if (!mode) return fail({ error: 'mode is draft or post.' })
    if (dates.length === 0) return fail({ error: 'dates is the list of due dates (YYYY-MM-DD) to book.' })
    if (dates.length > MAX_OCCURRENCES) return fail({ error: `Book at most ${MAX_OCCURRENCES} dates at once.` })
    if (action === 'preview') {
      const r = await previewRecurring(admin, who.fundId, group, s.id, dates, mode)
      return 'error' in r ? fail(r) : { status: 200, body: { ok: true, ...r } }
    }
    const r = await bookRecurring(admin, who, group, s.id, dates, mode)
    return 'error' in r ? fail(r) : { status: 200, body: { ok: true, ...r } }
  }

  return fail({ error: 'action is one of create, update, pause, resume, delete, preview, book.' })
}

/** For the reminder digest: unbooked due dates (remind) and drafts waiting (draft), per entry. */
export interface DueRecurring {
  id: string
  vehicleId: string
  name: string
  date: string
  amount: number
  status: 'due' | 'drafted'
  leadDays: number
}

/**
 * What the digest lists for a fund: each active fixed entry's due dates from `reminder_days` ahead
 * back 60 days with nothing booked (mode remind) or only a draft (mode draft). Null when the table
 * or columns are missing. A fee spread lists its months from the fee schedule the same way.
 */
export async function loadDueRecurring(admin: SupabaseClient, fundId: string, today: string): Promise<DueRecurring[] | null> {
  const schedules = await readSchedules(admin, fundId, null)
  if ('error' in schedules) return null
  const out: DueRecurring[] = []
  const from = addDaysIso(today, -60)
  // Fee spreads: their months from the fee schedule.
  for (const s of schedules.filter(x => x.active && x.kind === FEE_SPREAD_KIND && x.mode !== 'post')) {
    const group = await vehicleNameById(admin, fundId, s.vehicleId)
    if (!group) continue
    const f = await feeOccurrences(admin, fundId, group, s, addDaysIso(today, s.reminderDays))
    if ('error' in f) continue
    for (const o of f.past.filter(x => x.date >= from)) {
      if (s.mode === 'remind' && !o.status) out.push({ id: s.id, vehicleId: s.vehicleId, name: s.name, date: o.date, amount: o.amount, status: 'due', leadDays: s.reminderDays })
      else if (o.status === 'draft') out.push({ id: s.id, vehicleId: s.vehicleId, name: s.name, date: o.date, amount: o.amount, status: 'drafted', leadDays: s.reminderDays })
    }
  }
  const live = schedules.filter(s => s.active && s.kind === 'fixed')
  if (live.length === 0) return out.length ? out : null
  const byVehicle = new Map<string, RecurringSchedule[]>()
  for (const s of live) byVehicle.set(s.vehicleId, [...(byVehicle.get(s.vehicleId) ?? []), s])
  for (const [vehicleId, list] of byVehicle) {
    const booked = await bookedFixed(admin, fundId, vehicleId, list.map(s => s.id))
    for (const s of list) {
      const amount = roundCents(s.lines.filter(l => l.amount > 0).reduce((t, l) => t + l.amount, 0))
      const have = booked.get(s.id) ?? new Map()
      for (const date of occurrenceDates(s, from, addDaysIso(today, s.reminderDays))) {
        const b = have.get(date)
        if (s.mode === 'remind' && !b) out.push({ id: s.id, vehicleId, name: s.name, date, amount, status: 'due', leadDays: s.reminderDays })
        else if (b?.status === 'draft') out.push({ id: s.id, vehicleId, name: s.name, date, amount, status: 'drafted', leadDays: s.reminderDays })
      }
    }
  }
  return out.length ? out : null
}
