// The management fee schedule, written out period by period, editable, posted on its due dates,
// and invoiced.
//
// `vehicle_accounting_settings.fee_schedule` (fee-schedule.ts) is the LPA's wording. This module
// turns it into stored rows (`management_fee_periods`), one per period, each with per-partner lines
// (`management_fee_period_lines`), so an admin can see every payment and change any of it:
//
//   - the period's dates and due date (in advance: its first day; in arrears: its last);
//   - the rate, the basis and the capital the fee is calculated on, and the fee;
//   - each partner's share, and lines the terms add or an admin types: a LATER CLOSER'S CATCH-UP
//     (the fee it would have paid for the periods before it was admitted, charged in the first
//     period it is in), an EQUALIZATION fee, or any other adjustment (negative for a credit).
//
// Regenerating from the terms rewrites only rows nobody has edited and nothing has booked. An
// edited row is locked; resetting it hands it back to the terms.
//
// MONTHLY SPREADING, whatever day the cash arrives: a period billed in advance is billed whole on
// its due date (fund Dr 1500 Prepaid management fees / Cr payable; manager Dr Due from the fund /
// Cr 2400 Deferred management fee revenue), and the 1st of each month recognizes that month's share
// (fund Dr 5000 / Cr 1500 with the partners' capital; manager Dr 2400 / Cr income). A period billed
// in arrears accrues month by month, at each month end, as charges instead.
//
// The spread is a RECURRING JOURNAL ENTRY (kind management_fee_spread, lib/accounting/
// recurring-entries.ts): it is on when the vehicle has an active one (loadFeeSchedule reports it as
// `monthlyAccrual`), and it books the month slices with its own mode (remind, draft or post). The
// fee schedule books only its part: the bill on the due date (or the whole charge when nothing is
// spread) and the invoice. postFeePeriod's `part` says which.
//
// POSTING a period (a charge) books, on its due date:
//   the fund    Dr 5000 Management fee (gross)   Cr 5010 offsets   Cr payable to the manager
//               Dr 3100-<partner> its own lines  Cr 3200 bridge    (self-allocated: ACCOUNTING.md §4)
//   the manager Dr Due from <fund>               Cr Management fee income
// The payable is the fund's "Due to <manager>" account when a management company is linked to the
// fund (manco_fee_links) and the vehicle books the manager's side, else 2100 Due to GP. When both
// sides post, an intercompany charge links them, so the manager's Intercompany tab settles the cash.
//
// Each payment gets an INVOICE from the manager to the fund, numbered and kept on the period row
// (fee-invoice-pdf.ts renders it).
//
// The daily tick (app/api/cron/fee-periods) does this on its own for a vehicle whose schedule says
// postMode 'draft' or 'post'; otherwise an admin posts each period from the schedule.

import type { SupabaseClient } from '@supabase/supabase-js'
import { addMonths, allocateAmount, roundCents } from '@portfolio/fund-engine'
import { chargeScheduledFee, loadFeeSchedule, loadScheduleInputs, type SchedulePayer, type StoredFeeSchedule } from './fee-schedule'
import { vehicleIdByName, vehicleNameById } from './vehicle-id'
import { accountIdByCode, ensureCapitalAccounts, persistEntry } from './persist'
import { ensureVehicleAccounts } from './provision-accounts'
import { ensureIntercompanyAccounts, resolveSideAccounts } from './intercompany'
import { ACTUAL_BOOK } from './books'
import type { JournalEntry, Posting } from './types'

export const FEE_LINE_KINDS = ['fee', 'catch_up', 'equalization', 'adjustment'] as const
export type FeeLineKind = (typeof FEE_LINE_KINDS)[number]
export const FEE_LINE_KIND_LABELS: Record<FeeLineKind, string> = {
  fee: 'Management fee',
  catch_up: 'Catch-up (later closing)',
  equalization: 'Equalization fee',
  adjustment: 'Adjustment',
}
export const FEE_BASES = ['commitments', 'invested', 'nav', 'other'] as const
export type FeePeriodBasis = (typeof FEE_BASES)[number]

export interface FeeLine {
  id?: string
  lpEntityId: string
  kind: FeeLineKind
  basisAmount: number | null
  rate: number | null
  amount: number
  auto: boolean
  note: string | null
}

export interface FeePeriodDraft {
  start: string
  /** Exclusive. */
  end: string
  dueDate: string
  rate: number
  basis: FeePeriodBasis
  basisAmount: number
  gross: number
  offset: number
  lines: FeeLine[]
}

export interface FeeSlice {
  /**
   * charge: the fee itself (expense and payable, receivable and income), on the due date or one
   * month. bill: an in-advance period billed whole on its due date when the fee is spread monthly
   * (prepaid and payable, receivable and deferred revenue). recognize: one month of a billed period
   * spread (expense out of prepaid, income out of deferred revenue). Absent on rows booked before
   * kinds existed: a charge.
   */
  kind?: 'charge' | 'bill' | 'recognize'
  date: string
  entryId: string
  managerEntryId?: string | null
  chargeId?: string | null
  amount: number
}

export type FeePeriodStatus = 'scheduled' | 'drafted' | 'posted' | 'waived'

export interface FeePeriod extends FeePeriodDraft {
  id: string
  note: string | null
  edited: boolean
  status: FeePeriodStatus
  postings: FeeSlice[]
  lastError: string | null
  invoice: { number: string; date: string; status: 'draft' | 'issued' | 'void'; amount: number } | null
  /** Every line added up: what the period charges. */
  total: number
}

const pad = (n: number) => String(n).padStart(2, '0')
const MONTHS = { quarterly: 3, semiannual: 6, annual: 12 } as const

export function addDays(date: string, days: number): string {
  const [y, m, d] = date.split('-').map(Number)
  const t = new Date(Date.UTC(y, m - 1, d + days))
  return `${t.getUTCFullYear()}-${pad(t.getUTCMonth() + 1)}-${pad(t.getUTCDate())}`
}

/** Whole months from start to end (end exclusive), at least 1. */
export function monthsIn(start: string, end: string): number {
  const [y1, m1, d1] = start.split('-').map(Number)
  const [y2, m2, d2] = end.split('-').map(Number)
  const months = (y2 - y1) * 12 + (m2 - m1) + (d2 > d1 ? 1 : 0)
  return Math.max(1, months)
}

export function dueDateFor(start: string, end: string, timing: StoredFeeSchedule['timing']): string {
  return timing === 'arrears' ? addDays(end, -1) : start
}

export const periodTotal = (lines: Pick<FeeLine, 'amount'>[]) => roundCents(lines.reduce((s, l) => s + l.amount, 0))

/**
 * Pure: every period the schedule charges, with each partner's lines.
 *
 * A partner admitted after the schedule starts (`admissions`: its closing date) pays nothing for the
 * periods that began before it was admitted. What it would have paid for them, had it been in from
 * the start, is charged as one catch-up line in the first period that begins on or after its
 * admission. On a commitments basis that is exactly the LPA's usual later-closer fee; on invested
 * capital or NAV it is the share the partner would have borne, which an admin can edit.
 */
export function draftFeePeriods(
  schedule: StoredFeeSchedule,
  payers: SchedulePayer[],
  facts: Parameters<typeof chargeScheduledFee>[3],
  admissions: Map<string, string> = new Map(),
): FeePeriodDraft[] {
  const step = MONTHS[schedule.frequency]
  const owed = new Map<string, { amount: number; periods: number; from: string }>()
  const out: FeePeriodDraft[] = []
  for (let d = schedule.start; d < schedule.end; d = addMonths(d, step)) {
    const isIn = (p: SchedulePayer) => { const a = admissions.get(p.lpEntityId); return !a || a <= d }
    const present = payers.filter(isIn)
    const full = chargeScheduledFee(schedule, payers, d, facts)
    if (!full) continue
    const charged = present.length > 0 ? chargeScheduledFee(schedule, present, d, facts) : null
    const { period } = full
    const stepNow = [...schedule.steps].reverse().find(s => s.from <= period.start) ?? schedule.steps[0]

    // Partners not yet admitted: what they would have paid accrues to their catch-up.
    for (const p of payers) {
      if (isIn(p)) continue
      const line = full.fee.lines.find(l => l.lpEntityId === p.lpEntityId)
      if (!line || !(line.fee > 0)) continue
      const o = owed.get(p.lpEntityId) ?? { amount: 0, periods: 0, from: period.start }
      owed.set(p.lpEntityId, { amount: o.amount + line.fee, periods: o.periods + 1, from: o.from })
    }

    const lines: FeeLine[] = (charged?.fee.lines ?? [])
      .filter(l => l.fee !== 0)
      .map(l => ({ lpEntityId: l.lpEntityId, kind: 'fee' as const, basisAmount: l.basisAmount, rate: l.rate, amount: roundCents(l.fee), auto: true, note: null }))
    for (const p of present) {
      const o = owed.get(p.lpEntityId)
      if (!o) continue
      owed.delete(p.lpEntityId)
      const amount = roundCents(o.amount)
      if (amount === 0) continue
      lines.push({
        lpEntityId: p.lpEntityId, kind: 'catch_up', basisAmount: p.commitment, rate: null, amount, auto: true,
        note: `Admitted ${admissions.get(p.lpEntityId)}: the fee for ${o.periods} earlier period${o.periods === 1 ? '' : 's'} from ${o.from}`,
      })
    }

    const bearing = present.filter(p => !p.exempt)
    const gross = roundCents(charged?.period.gross ?? 0)
    const fraction = monthsIn(period.start, period.end) / 12
    const basisAmount = stepNow.basis === 'commitments'
      ? roundCents(bearing.reduce((s, p) => s + p.commitment, 0))
      : stepNow.rate > 0 ? roundCents(gross / (stepNow.rate * fraction)) : 0
    out.push({
      start: period.start, end: period.end, dueDate: dueDateFor(period.start, period.end, schedule.timing),
      rate: stepNow.rate, basis: stepNow.basis, basisAmount, gross, offset: roundCents(charged?.period.offset ?? 0), lines,
    })
  }
  return out
}

/**
 * Pure: an admin's edit applied to a period. A new rate or capital amount (without a fee) re-prices
 * the fee as capital × rate × months / 12; a new fee (or a re-priced one) rescales the partners'
 * fee lines to it, side letters keeping their proportions. Lines passed in replace the period's.
 */
export function applyFeePeriodEdit(
  p: FeePeriodDraft,
  patch: { dueDate?: string; rate?: number; basis?: FeePeriodBasis; basisAmount?: number; fee?: number; lines?: FeeLine[] },
): FeePeriodDraft {
  const next: FeePeriodDraft = { ...p, lines: patch.lines ? patch.lines.map(l => ({ ...l, amount: roundCents(l.amount) })) : p.lines.map(l => ({ ...l })) }
  if (patch.dueDate) next.dueDate = patch.dueDate
  if (patch.basis) next.basis = patch.basis
  if (patch.rate != null) next.rate = patch.rate
  if (patch.basisAmount != null) next.basisAmount = roundCents(patch.basisAmount)
  let fee = patch.fee
  if (fee == null && !patch.lines && (patch.rate != null || patch.basisAmount != null)) {
    fee = roundCents(next.basisAmount * next.rate * (monthsIn(next.start, next.end) / 12))
  }
  if (fee != null && !patch.lines) {
    const feeLines = next.lines.filter(l => l.kind === 'fee')
    const current = periodTotal(feeLines)
    if (feeLines.length > 0) {
      const shares = allocateAmount(fee, feeLines.map(l => ({ lpEntityId: l.lpEntityId, commitment: current > 0 ? l.amount : 1 })))
      for (const l of feeLines) l.amount = shares.get(l.lpEntityId) ?? 0
    }
    if (patch.rate != null) for (const l of feeLines) l.rate = patch.rate
    next.gross = roundCents(fee + next.offset)
  }
  return next
}

/**
 * Pure: the slices a period is booked in. One on its due date; with monthly accrual, one a month,
 * cents carried so the slices add up exactly. `end` dates each at its month's end (the last on the
 * period's last day); `first` dates each on its month's first day (the first on the period's start),
 * so a fee billed in advance on the 1st of the quarter is recognized on the 1st of each month.
 */
export function feeSlices(p: Pick<FeePeriodDraft, 'start' | 'end' | 'dueDate' | 'lines' | 'offset'>, monthly: boolean, on: 'first' | 'end' = 'end'): { date: string; lines: { lpEntityId: string; amount: number }[]; offset: number }[] {
  const byLp = new Map<string, number>()
  for (const l of p.lines) byLp.set(l.lpEntityId, roundCents((byLp.get(l.lpEntityId) ?? 0) + l.amount))
  const lines = [...byLp].map(([lpEntityId, amount]) => ({ lpEntityId, amount })).filter(l => l.amount !== 0)
  if (!monthly) return [{ date: p.dueDate, lines, offset: p.offset }]
  const n = monthsIn(p.start, p.end)
  const cut = (amount: number, k: number) => roundCents(Math.round(amount * 100 * k / n) / 100)
  const out = []
  for (let k = 1; k <= n; k++) {
    const first = addMonths(p.start.slice(0, 8) + '01', k - 1)
    const monthEnd = addDays(addMonths(p.start.slice(0, 8) + '01', k), -1)
    const date = on === 'first'
      ? (first > p.start ? first : p.start)
      : (monthEnd < p.end ? monthEnd : addDays(p.end, -1))
    out.push({
      date,
      lines: lines.map(l => ({ lpEntityId: l.lpEntityId, amount: roundCents(cut(l.amount, k) - cut(l.amount, k - 1)) })).filter(l => l.amount !== 0),
      offset: roundCents(cut(p.offset, k) - cut(p.offset, k - 1)),
    })
  }
  return out
}

/**
 * Pure: the fund's entry for one slice. The partners' capital is charged their own lines through
 * the bridge, so the close leaves it as booked (a catch-up lands on the later closer alone).
 */
export function buildFeeSliceEntry(
  base: { fundId: string; entryDate: string; memo: string; sourceRef: string },
  slice: { lines: { lpEntityId: string; amount: number }[]; offset: number },
  accts: { expense: string; offset: string | null; payable: string; bridge: string },
  capMap: Map<string, string>,
): JournalEntry | null {
  const net = periodTotal(slice.lines)
  if (!(net > 0)) return null
  const offset = accts.offset ? roundCents(slice.offset) : 0
  const postings: Posting[] = [
    { accountId: accts.expense, amount: roundCents(net + offset), currency: 'USD', lpEntityId: null },
    ...(offset > 0 && accts.offset ? [{ accountId: accts.offset, amount: -offset, currency: 'USD', lpEntityId: null }] : []),
    { accountId: accts.payable, amount: -net, currency: 'USD', lpEntityId: null },
  ]
  for (const l of slice.lines) {
    const capital = capMap.get(l.lpEntityId)
    if (!capital) throw new Error(`No capital account for partner ${l.lpEntityId}`)
    postings.push({ accountId: capital, amount: roundCents(l.amount), currency: 'USD', lpEntityId: l.lpEntityId })
  }
  postings.push({ accountId: accts.bridge, amount: -net, currency: 'USD', lpEntityId: null })
  return { fundId: base.fundId, entryDate: base.entryDate, memo: base.memo, sourceType: 'management_fee', sourceRef: base.sourceRef, postings }
}

export interface FeeBooking { kind: 'charge' | 'bill' | 'recognize'; date: string; lines: { lpEntityId: string; amount: number }[]; offset: number }

/**
 * Pure: what booking a period means. Without monthly spreading, one charge on the due date. With
 * it, a period billed IN ADVANCE is billed whole on its due date (the manager's receivable and the
 * fund's payable, which the payment a day or two later clears) and then recognized month by month
 * out of prepaid fees and deferred revenue: the fee is already billed, so the months spread it, they
 * do not accrue it. A period billed IN ARREARS accrues month by month as a charge and is invoiced at
 * its end.
 */
export function feeBookings(
  p: Pick<FeePeriodDraft, 'start' | 'end' | 'dueDate' | 'lines' | 'offset'>,
  monthly: boolean,
  timing: StoredFeeSchedule['timing'],
): FeeBooking[] {
  if (!monthly) return feeSlices(p, false).map(x => ({ kind: 'charge' as const, ...x }))
  if (timing === 'arrears') return feeSlices(p, true, 'end').map(x => ({ kind: 'charge' as const, ...x }))
  const months = feeSlices(p, true, 'first')
  const [whole] = feeSlices(p, false)
  return [{ kind: 'bill' as const, ...whole }, ...months.map(x => ({ kind: 'recognize' as const, ...x }))]
}

export const bookingKey = (s: { kind?: string; date: string }) => `${s.kind ?? 'charge'}:${s.date}`

/**
 * Which side books a booking. With monthly spreading the recurring spread books every month slice
 * (a recognized month, or an arrears month's charge) and the fee schedule books only the bill;
 * without it the fee schedule books everything.
 */
export type FeeBookingPart = 'schedule' | 'months'
export function bookingPart(b: Pick<FeeBooking, 'kind'>, monthly: boolean): FeeBookingPart {
  return monthly && b.kind !== 'bill' ? 'months' : 'schedule'
}

/** Pure: the fund's bill for an in-advance period it spreads monthly. Dr prepaid fees / Cr payable. */
export function buildFeeBillEntry(
  base: { fundId: string; entryDate: string; memo: string; sourceRef: string },
  net: number,
  accts: { prepaid: string; payable: string },
): JournalEntry | null {
  const amount = roundCents(net)
  if (!(amount > 0)) return null
  return {
    fundId: base.fundId, entryDate: base.entryDate, memo: base.memo, sourceType: 'management_fee_billing', sourceRef: base.sourceRef,
    postings: [
      { accountId: accts.prepaid, amount, currency: 'USD', lpEntityId: null },
      { accountId: accts.payable, amount: -amount, currency: 'USD', lpEntityId: null },
    ],
  }
}

/** Pure: the manager's side of a booking: the receivable, the income, or deferred revenue between them. */
export function buildManagerFeeEntry(
  base: { fundId: string; entryDate: string; memo: string; sourceRef: string },
  kind: FeeBooking['kind'],
  net: number,
  accts: { receivable: string; income: string; deferred: string | null },
): JournalEntry | null {
  const amount = roundCents(net)
  if (!(amount > 0)) return null
  const [debit, credit] = kind === 'charge' ? [accts.receivable, accts.income]
    : kind === 'bill' ? [accts.receivable, accts.deferred]
    : [accts.deferred, accts.income]
  if (!debit || !credit) return null
  return {
    fundId: base.fundId, entryDate: base.entryDate, memo: base.memo, sourceType: kind === 'bill' ? 'management_fee_billing' : 'intercompany', sourceRef: base.sourceRef,
    postings: [
      { accountId: debit, amount, currency: 'USD', lpEntityId: null },
      { accountId: credit, amount: -amount, currency: 'USD', lpEntityId: null },
    ],
  }
}

export function feeInvoiceNumber(periodStart: string, vehicleId: string, seq: number): string {
  const base = `MF-${periodStart.replace(/-/g, '')}-${vehicleId.slice(0, 6).toUpperCase()}`
  return seq > 0 ? `${base}-${seq + 1}` : base
}

// ── The database ─────────────────────────────────────────────────────────────────────────────

const PERIOD_COLUMNS = 'id, vehicle_id, period_start, period_end, due_date, rate, basis, basis_amount, gross, offset_amount, note, edited, status, postings, last_error, invoice_number, invoice_date, invoice_status, invoice_amount, invoice_seq'

function rowToPeriod(r: any, lines: any[]): FeePeriod {
  const ls: FeeLine[] = lines.map(l => ({
    id: l.id, lpEntityId: l.lp_entity_id, kind: l.kind, basisAmount: l.basis_amount == null ? null : Number(l.basis_amount),
    rate: l.rate == null ? null : Number(l.rate), amount: Number(l.amount), auto: !!l.auto, note: l.note ?? null,
  }))
  return {
    id: r.id, start: r.period_start, end: r.period_end, dueDate: r.due_date, rate: Number(r.rate), basis: r.basis,
    basisAmount: Number(r.basis_amount), gross: Number(r.gross), offset: Number(r.offset_amount), lines: ls,
    note: r.note ?? null, edited: !!r.edited, status: r.status, postings: Array.isArray(r.postings) ? r.postings : [],
    lastError: r.last_error ?? null,
    invoice: r.invoice_number && r.invoice_status ? { number: r.invoice_number, date: r.invoice_date, status: r.invoice_status, amount: Number(r.invoice_amount ?? 0) } : null,
    total: periodTotal(ls),
  }
}

const MISSING_TABLE = /management_fee_period|relation .* does not exist|schema cache/i
const NEEDS_MIGRATION = 'The editable fee schedule needs migration 20261124030000_management_fee_periods.sql. Apply it, then try again.'

async function readPeriods(admin: SupabaseClient, fundId: string, vehicleId: string): Promise<FeePeriod[] | { error: string }> {
  const { data, error } = await (admin as any).from('management_fee_periods').select(PERIOD_COLUMNS)
    .eq('fund_id', fundId).eq('vehicle_id', vehicleId).order('period_start')
  if (error) return { error: MISSING_TABLE.test(error.message) ? NEEDS_MIGRATION : error.message }
  const rows = (data as any[]) ?? []
  if (rows.length === 0) return []
  const { data: lines } = await (admin as any).from('management_fee_period_lines')
    .select('id, period_id, lp_entity_id, kind, basis_amount, rate, amount, auto, note')
    .eq('fund_id', fundId).in('period_id', rows.map(r => r.id)).order('created_at')
  const byPeriod = new Map<string, any[]>()
  for (const l of (lines as any[]) ?? []) byPeriod.set(l.period_id, [...(byPeriod.get(l.period_id) ?? []), l])
  return rows.map(r => rowToPeriod(r, byPeriod.get(r.id) ?? []))
}

async function writeLines(admin: SupabaseClient, fundId: string, periodId: string, lines: FeeLine[]): Promise<{ error?: string }> {
  await (admin as any).from('management_fee_period_lines').delete().eq('fund_id', fundId).eq('period_id', periodId)
  if (lines.length === 0) return {}
  const { error } = await (admin as any).from('management_fee_period_lines').insert(lines.map(l => ({
    fund_id: fundId, period_id: periodId, lp_entity_id: l.lpEntityId, kind: l.kind,
    basis_amount: l.basisAmount, rate: l.rate, amount: roundCents(l.amount), auto: l.auto, note: l.note,
  })))
  return error ? { error: error.message } : {}
}

/** Each partner's admission date: the closing it was admitted at, for those admitted after the first. */
async function loadAdmissions(admin: SupabaseClient, fundId: string, vehicleId: string): Promise<Map<string, string>> {
  const out = new Map<string, string>()
  const { data: closings } = await (admin as any).from('vehicle_closings').select('id, close_date').eq('fund_id', fundId).eq('vehicle_id', vehicleId)
  const rows = ((closings as any[]) ?? []) as { id: string; close_date: string }[]
  if (rows.length < 2) return out // one closing (or none): everyone is in from the start
  const first = rows.map(r => r.close_date).sort()[0]
  const dateOf = new Map(rows.map(r => [r.id, r.close_date]))
  const { data: members } = await (admin as any).from('vehicle_closing_members').select('closing_id, lp_entity_id').eq('fund_id', fundId).in('closing_id', rows.map(r => r.id))
  for (const m of (members as any[]) ?? []) {
    const d = dateOf.get(m.closing_id)
    if (!d || d <= first) continue
    const prior = out.get(m.lp_entity_id)
    if (!prior || d < prior) out.set(m.lp_entity_id, d)
  }
  return out
}

/** The management company linked to this fund vehicle for its fees, if any. */
export async function feeManager(admin: SupabaseClient, fundId: string, vehicleId: string): Promise<{ vehicleId: string; name: string } | null> {
  const { data } = await (admin as any).from('manco_fee_links').select('manco_vehicle_id').eq('fund_id', fundId).eq('fund_vehicle_id', vehicleId).eq('active', true).limit(1)
  const id = (data as any[])?.[0]?.manco_vehicle_id as string | undefined
  if (!id) return null
  const name = await vehicleNameById(admin, fundId, id)
  return name ? { vehicleId: id, name } : null
}

/** Booked slices whose entries are gone (voided or deleted) drop off; drafts posted elsewhere count as posted. */
async function syncPostings(admin: SupabaseClient, fundId: string, periods: FeePeriod[]): Promise<FeePeriod[]> {
  const ids = periods.flatMap(p => p.postings.flatMap(s => [s.entryId, s.managerEntryId].filter(Boolean) as string[]))
  if (ids.length === 0) return periods
  const status = new Map<string, string>()
  for (let i = 0; i < ids.length; i += 200) {
    const { data } = await (admin as any).from('journal_entries').select('id, status').eq('book', ACTUAL_BOOK).eq('fund_id', fundId).in('id', ids.slice(i, i + 200))
    for (const e of (data as any[]) ?? []) status.set(e.id, e.status)
  }
  const out: FeePeriod[] = []
  for (const p of periods) {
    if (p.postings.length === 0) { out.push(p); continue }
    const live = p.postings.filter(s => { const st = status.get(s.entryId); return st === 'draft' || st === 'posted' })
    const allPosted = live.length > 0 && live.every(s => status.get(s.entryId) === 'posted')
    const nextStatus: FeePeriodStatus = live.length === 0 ? 'scheduled' : allPosted ? 'posted' : 'drafted'
    const invoiceStatus = p.invoice && p.invoice.status !== 'void'
      ? (live.length === 0 ? 'void' : allPosted ? 'issued' : p.invoice.status)
      : p.invoice?.status ?? null
    if (live.length === p.postings.length && nextStatus === p.status && invoiceStatus === (p.invoice?.status ?? null)) { out.push(p); continue }
    const patch: Record<string, unknown> = { postings: live, status: nextStatus, updated_at: new Date().toISOString() }
    if (p.invoice && invoiceStatus !== p.invoice.status) {
      patch.invoice_status = invoiceStatus
      if (invoiceStatus === 'void') patch.invoice_seq = (await currentSeq(admin, p.id)) + 1
    }
    await (admin as any).from('management_fee_periods').update(patch).eq('id', p.id).eq('fund_id', fundId)
    out.push({ ...p, postings: live, status: nextStatus, invoice: p.invoice ? { ...p.invoice, status: invoiceStatus as any } : null })
  }
  return out
}

async function currentSeq(admin: SupabaseClient, id: string): Promise<number> {
  const { data } = await (admin as any).from('management_fee_periods').select('invoice_seq').eq('id', id).maybeSingle()
  return Number(data?.invoice_seq ?? 0)
}

export interface FeePeriodsView {
  vehicle: string
  schedule: StoredFeeSchedule | null
  manager: { vehicleId: string; name: string } | null
  periods: FeePeriod[]
  /** What regenerating would change: periods it would add and unedited ones whose figures moved. */
  stale: number
  names: Record<string, string>
}

/** The stored periods, brought into line with the books (voided entries drop off). Writes nothing else. */
export async function listFeePeriods(admin: SupabaseClient, fundId: string, group: string): Promise<FeePeriodsView | { error: string }> {
  const vehicleId = await vehicleIdByName(admin, fundId, group)
  if (!vehicleId) return { error: `Unknown vehicle "${group}".` }
  const schedule = await loadFeeSchedule(admin, fundId, group)
  const read = await readPeriods(admin, fundId, vehicleId)
  if ('error' in read) return read
  const periods = await syncPostings(admin, fundId, read)
  const manager = await feeManager(admin, fundId, vehicleId)
  const names = await partnerNames(admin, fundId, periods)
  let stale = 0
  if (schedule) {
    const drafts = await draftsFor(admin, fundId, group, vehicleId, schedule)
    if (!('error' in drafts)) {
      const byStart = new Map(periods.map(p => [p.start, p]))
      for (const d of drafts) {
        const p = byStart.get(d.start)
        if (!p) { stale++; continue }
        if (p.edited || p.status !== 'scheduled') continue
        if (Math.abs(periodTotal(d.lines) - p.total) >= 0.01 || d.dueDate !== p.dueDate || d.end !== p.end) stale++
      }
    }
  }
  return { vehicle: group, schedule, manager, periods, stale, names }
}

async function partnerNames(admin: SupabaseClient, fundId: string, periods: FeePeriod[]): Promise<Record<string, string>> {
  const ids = Array.from(new Set(periods.flatMap(p => p.lines.map(l => l.lpEntityId))))
  if (ids.length === 0) return {}
  const { data } = await (admin as any).from('lp_entities').select('id, entity_name').eq('fund_id', fundId).in('id', ids)
  return Object.fromEntries(((data as any[]) ?? []).map(e => [e.id, e.entity_name]))
}

async function draftsFor(admin: SupabaseClient, fundId: string, group: string, vehicleId: string, schedule: StoredFeeSchedule): Promise<FeePeriodDraft[] | { error: string }> {
  const inputs = await loadScheduleInputs(admin, fundId, group, schedule)
  if ('error' in inputs) return inputs
  const admissions = await loadAdmissions(admin, fundId, vehicleId)
  return draftFeePeriods(schedule, inputs.payers, inputs.facts, admissions)
}

/**
 * Write the schedule's periods: add the missing ones and rewrite every period nobody edited and
 * nothing booked. Edited, drafted, posted and waived periods are kept as they are; a kept period
 * the terms no longer cover is listed in `orphaned` rather than deleted.
 */
export async function generateFeePeriods(
  admin: SupabaseClient, fundId: string, group: string,
): Promise<{ added: number; updated: number; kept: number; removed: number; orphaned: string[] } | { error: string }> {
  const vehicleId = await vehicleIdByName(admin, fundId, group)
  if (!vehicleId) return { error: `Unknown vehicle "${group}".` }
  const schedule = await loadFeeSchedule(admin, fundId, group)
  if (!schedule) return { error: `${group} has no fee schedule. Set one first (the Allocation terms page, or set_fee_schedule).` }
  const existingRead = await readPeriods(admin, fundId, vehicleId)
  if ('error' in existingRead) return existingRead
  const existing = await syncPostings(admin, fundId, existingRead)
  const drafts = await draftsFor(admin, fundId, group, vehicleId, schedule)
  if ('error' in drafts) return drafts

  const locked = (p: FeePeriod) => p.edited || p.status !== 'scheduled' || p.postings.length > 0 || (p.invoice != null && p.invoice.status !== 'void')
  const byStart = new Map(existing.map(p => [p.start, p]))
  let added = 0, updated = 0, kept = 0, removed = 0
  const now = new Date().toISOString()
  for (const d of drafts) {
    const p = byStart.get(d.start)
    byStart.delete(d.start)
    const fields = {
      period_end: d.end, due_date: d.dueDate, rate: d.rate, basis: d.basis, basis_amount: d.basisAmount,
      gross: d.gross, offset_amount: d.offset, updated_at: now,
    }
    if (p && locked(p)) { kept++; continue }
    let id = p?.id
    if (p) {
      const { error } = await (admin as any).from('management_fee_periods').update(fields).eq('id', p.id).eq('fund_id', fundId)
      if (error) return { error: error.message }
      updated++
    } else {
      const { data, error } = await (admin as any).from('management_fee_periods')
        .insert({ fund_id: fundId, vehicle_id: vehicleId, period_start: d.start, ...fields }).select('id').single()
      if (error) return { error: MISSING_TABLE.test(error.message) ? NEEDS_MIGRATION : error.message }
      id = data.id
      added++
    }
    const w = await writeLines(admin, fundId, id!, d.lines)
    if (w.error) return { error: w.error }
  }
  const orphaned: string[] = []
  for (const p of byStart.values()) {
    if (locked(p)) { orphaned.push(p.start); continue }
    await (admin as any).from('management_fee_periods').delete().eq('id', p.id).eq('fund_id', fundId)
    removed++
  }
  return { added, updated, kept, removed, orphaned }
}

export interface FeePeriodPatch {
  dueDate?: string
  rate?: number
  basis?: FeePeriodBasis
  basisAmount?: number
  fee?: number
  note?: string | null
  lines?: { lpEntityId: string; kind?: string; amount: number; basisAmount?: number | null; rate?: number | null; note?: string | null }[]
}

const DATE = /^\d{4}-\d{2}-\d{2}$/
const MONTH_NAMES = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December']

/** Check an edit without touching the database. */
export function parseFeePeriodPatch(raw: any): { ok: true; patch: FeePeriodPatch & { lines?: FeeLine[] } } | { error: string } {
  if (!raw || typeof raw !== 'object') return { error: 'Nothing to change.' }
  const patch: FeePeriodPatch & { lines?: FeeLine[] } = {}
  if (raw.dueDate != null) { if (!DATE.test(String(raw.dueDate))) return { error: 'dueDate must be YYYY-MM-DD.' }; patch.dueDate = String(raw.dueDate) }
  if (raw.rate != null) { const r = Number(raw.rate); if (!(r >= 0 && r <= 0.2)) return { error: 'rate is an annual fraction between 0 and 0.2 (0.02 = 2%).' }; patch.rate = r }
  if (raw.basis != null) { if (!(FEE_BASES as readonly string[]).includes(raw.basis)) return { error: 'basis is commitments, invested, nav or other.' }; patch.basis = raw.basis }
  if (raw.basisAmount != null) { const v = Number(raw.basisAmount); if (!(v >= 0)) return { error: 'basisAmount must be zero or more.' }; patch.basisAmount = v }
  if (raw.fee != null) { const v = Number(raw.fee); if (!(v >= 0)) return { error: 'fee must be zero or more.' }; patch.fee = v }
  if (raw.note !== undefined) patch.note = raw.note == null || String(raw.note).trim() === '' ? null : String(raw.note).trim().slice(0, 1000)
  if (raw.lines != null) {
    if (!Array.isArray(raw.lines)) return { error: 'lines is a list.' }
    const lines: FeeLine[] = []
    for (const l of raw.lines) {
      const kind = (l?.kind ?? 'fee') as FeeLineKind
      if (!(FEE_LINE_KINDS as readonly string[]).includes(kind)) return { error: `"${l?.kind}" is not a kind of fee line (fee, catch_up, equalization, adjustment).` }
      if (typeof l?.lpEntityId !== 'string' || !l.lpEntityId) return { error: 'Each line names a partner (lpEntityId).' }
      const amount = Number(l.amount)
      if (!Number.isFinite(amount)) return { error: 'Each line has an amount.' }
      lines.push({
        lpEntityId: l.lpEntityId, kind, amount: roundCents(amount),
        basisAmount: l.basisAmount == null || l.basisAmount === '' ? null : Number(l.basisAmount),
        rate: l.rate == null || l.rate === '' ? null : Number(l.rate),
        auto: false, note: l.note == null || String(l.note).trim() === '' ? null : String(l.note).trim().slice(0, 500),
      })
    }
    patch.lines = lines
  }
  return { ok: true, patch }
}

async function onePeriod(admin: SupabaseClient, fundId: string, group: string, periodId: string): Promise<{ vehicleId: string; period: FeePeriod } | { error: string; status: number }> {
  const vehicleId = await vehicleIdByName(admin, fundId, group)
  if (!vehicleId) return { error: `Unknown vehicle "${group}".`, status: 400 }
  const read = await readPeriods(admin, fundId, vehicleId)
  if ('error' in read) return { error: read.error, status: 400 }
  const synced = await syncPostings(admin, fundId, read)
  const period = synced.find(p => p.id === periodId)
  if (!period) return { error: 'That fee period is not on this vehicle.', status: 404 }
  return { vehicleId, period }
}

/** Edit a period by hand. It is then locked: regenerating leaves it as edited. */
export async function editFeePeriod(
  admin: SupabaseClient, fundId: string, group: string, userId: string | null, periodId: string, raw: unknown,
): Promise<{ period: FeePeriod } | { error: string; status: number }> {
  const parsed = parseFeePeriodPatch(raw)
  if ('error' in parsed) return { error: parsed.error, status: 400 }
  const found = await onePeriod(admin, fundId, group, periodId)
  if ('error' in found) return found
  const { period } = found
  if (period.postings.length > 0) return { error: 'This period is booked. Void its entries (they are listed on the period) to change it.', status: 409 }
  if (period.invoice && period.invoice.status === 'issued') return { error: `Invoice ${period.invoice.number} has been issued for this period. Void it first.`, status: 409 }
  const next = applyFeePeriodEdit(period, parsed.patch)
  const { error } = await (admin as any).from('management_fee_periods').update({
    due_date: next.dueDate, rate: next.rate, basis: next.basis, basis_amount: next.basisAmount, gross: next.gross,
    ...(parsed.patch.note !== undefined ? { note: parsed.patch.note } : {}),
    edited: true, edited_by: userId, edited_at: new Date().toISOString(), updated_at: new Date().toISOString(),
  }).eq('id', periodId).eq('fund_id', fundId)
  if (error) return { error: error.message, status: 500 }
  const w = await writeLines(admin, fundId, periodId, next.lines)
  if (w.error) return { error: w.error, status: 500 }
  return { period: { ...period, ...next, note: parsed.patch.note !== undefined ? parsed.patch.note : period.note, edited: true, total: periodTotal(next.lines) } }
}

/** Hand a period back to the terms (unlock it and regenerate), or waive it, or un-waive it. */
export async function setFeePeriodState(
  admin: SupabaseClient, fundId: string, group: string, periodId: string, action: 'reset' | 'waive' | 'unwaive',
): Promise<{ ok: true } | { error: string; status: number }> {
  const found = await onePeriod(admin, fundId, group, periodId)
  if ('error' in found) return found
  const { period } = found
  if (period.postings.length > 0) return { error: 'This period is booked. Void its entries first.', status: 409 }
  if (period.invoice && period.invoice.status !== 'void') return { error: `Invoice ${period.invoice.number} is still live for this period. Void it first.`, status: 409 }
  const now = new Date().toISOString()
  if (action === 'waive') {
    await (admin as any).from('management_fee_periods').update({ status: 'waived', edited: true, updated_at: now }).eq('id', periodId).eq('fund_id', fundId)
    return { ok: true }
  }
  await (admin as any).from('management_fee_periods').update({ status: 'scheduled', edited: false, updated_at: now }).eq('id', periodId).eq('fund_id', fundId)
  const regen = await generateFeePeriods(admin, fundId, group)
  return 'error' in regen ? { error: regen.error, status: 400 } : { ok: true }
}

export interface PostFeePeriodResult {
  periodId: string
  status: FeePeriodStatus
  booked: FeeSlice[]
  invoice: FeePeriod['invoice']
  warnings: string[]
}

/**
 * Book a period (the slices due by `through`, or every slice with `all`) and invoice it.
 * `mode` 'post' posts the entries and issues the invoice; 'draft' leaves both for review. A period
 * already drafted is promoted: its drafts are posted and its invoice issued.
 */
export async function postFeePeriod(
  admin: SupabaseClient,
  fundId: string,
  group: string,
  userId: string | null,
  periodId: string,
  opts: {
    mode: 'draft' | 'post'; through?: string; all?: boolean; promote?: (entryId: string) => Promise<{ error?: string }>
    /** Which bookings: the fee schedule's (default) or the monthly spread's (the recurring entry). */
    part?: FeeBookingPart
    /** months only: book exactly these slice dates. */
    dates?: string[]
  },
): Promise<PostFeePeriodResult | { error: string; status: number }> {
  const found = await onePeriod(admin, fundId, group, periodId)
  if ('error' in found) return found
  const { vehicleId, period } = found
  if (period.status === 'waived') return { error: 'This period is waived. Un-waive it to book it.', status: 409 }
  const schedule = await loadFeeSchedule(admin, fundId, group)
  const monthly = !!schedule?.monthlyAccrual
  const part: FeeBookingPart = opts.part ?? 'schedule'
  const inPart = (b: Pick<FeeBooking, 'kind'>) => bookingPart(b, monthly) === part
  const warnings: string[] = []

  // Promote drafts first: this part's, and only the dates asked for.
  const booked: FeeSlice[] = [...period.postings]
  if (opts.mode === 'post' && period.status === 'drafted') {
    for (const s of booked) {
      if (!inPart({ kind: s.kind ?? 'charge' })) continue
      if (opts.dates && !opts.dates.includes(s.date)) continue
      for (const id of [s.entryId, s.managerEntryId].filter(Boolean) as string[]) {
        const { data } = await (admin as any).from('journal_entries').select('status').eq('book', ACTUAL_BOOK).eq('id', id).eq('fund_id', fundId).maybeSingle()
        if (data?.status !== 'draft') continue
        if (!opts.promote) return { error: 'Drafts can only be posted by a person.', status: 400 }
        const r = await opts.promote(id)
        if (r.error) return { error: `Entry ${id} could not be posted: ${r.error}`, status: 400 }
      }
    }
  }

  const manager = schedule?.bookManagerSide === false ? null : await feeManager(admin, fundId, vehicleId)
  const timing = schedule?.timing
  const plan = feeBookings(period, monthly, timing)
  const spreads = plan.some(b => b.kind === 'bill')
  const fundSide = await fundAccounts(admin, fundId, group, manager, spreads)
  if ('error' in fundSide) return { error: fundSide.error, status: 400 }

  const today = opts.through ?? new Date().toISOString().slice(0, 10)
  const done = new Set(booked.map(bookingKey))
  const periodLabel = `${period.start} to ${addDays(period.end, -1)}`
  const wanted = (x: FeeBooking) => inPart(x) && (opts.dates ? opts.dates.includes(x.date) : (opts.all || x.date <= today))
  for (const b of plan.filter(wanted)) {
    if (done.has(bookingKey(b))) continue
    const net = periodTotal(b.lines)
    if (!(net > 0)) continue
    const sourceRef = `fee-period:${period.id}:${b.kind}:${b.date}`
    const memo = b.kind === 'bill' ? `Management fee ${periodLabel}, billed in advance`
      : b.kind === 'recognize' ? `Management fee ${periodLabel}, ${MONTH_NAMES[Number(b.date.slice(5, 7)) - 1]} ${b.date.slice(0, 4)} share recognized`
      : `Management fee ${periodLabel}${monthly ? ` (accrued through ${b.date})` : ''}`
    let entry: JournalEntry | null
    if (b.kind === 'bill') {
      entry = buildFeeBillEntry({ fundId, entryDate: b.date, memo, sourceRef }, net, { prepaid: fundSide.prepaid!, payable: fundSide.accts.payable })
    } else {
      const capMap = await ensureCapitalAccounts(admin, fundId, group, b.lines.map(l => l.lpEntityId))
      // A recognized month comes out of prepaid fees, not a new payable.
      const accts = b.kind === 'recognize' ? { ...fundSide.accts, payable: fundSide.prepaid! } : fundSide.accts
      entry = buildFeeSliceEntry({ fundId, entryDate: b.date, memo, sourceRef }, b, accts, capMap)
    }
    if (!entry) continue
    const status = opts.mode === 'post' ? 'posted' : 'draft'
    const fundRes = await persistEntry(admin, fundId, group, userId, entry, status)
    if ('error' in fundRes) {
      await (admin as any).from('management_fee_periods').update({ last_error: fundRes.error, postings: booked, updated_at: new Date().toISOString() }).eq('id', period.id)
      return { error: `${group} ${b.date}: ${fundRes.error}`, status: 400 }
    }
    const s: FeeSlice = { kind: b.kind, date: b.date, entryId: fundRes.entryId, amount: net }
    if (manager && fundSide.manager) {
      const managerEntry = buildManagerFeeEntry({ fundId, entryDate: b.date, memo: `${memo}, ${group}`, sourceRef }, b.kind, net, fundSide.manager)
      const mRes = managerEntry ? await persistEntry(admin, fundId, manager.name, userId, managerEntry, status) : { error: 'no deferred revenue account' }
      if ('error' in mRes) warnings.push(`${manager.name}'s side was not booked for ${b.date}: ${mRes.error}. Book it by hand.`)
      else s.managerEntryId = mRes.entryId
    }
    booked.push(s)
    done.add(bookingKey(s))
  }

  // Link the receivable and the payable as an intercompany charge once both are posted, so the
  // manager settles it. A recognized month moves nothing between the two, so it is not a charge.
  if (manager) {
    for (const s of booked) {
      if (s.chargeId || !s.managerEntryId || s.kind === 'recognize') continue
      const { data } = await (admin as any).from('journal_entries').select('id, status').eq('book', ACTUAL_BOOK).eq('fund_id', fundId).in('id', [s.entryId, s.managerEntryId])
      if (((data as any[]) ?? []).filter(e => e.status === 'posted').length !== 2) continue
      const { data: row } = await (admin as any).from('intercompany_transactions').insert({
        fund_id: fundId, from_vehicle_id: vehicleId, to_vehicle_id: manager.vehicleId, kind: 'management_fee',
        charge_date: s.date, amount: s.amount, memo: `Management fee ${periodLabel}`, status: 'accrued',
        from_entry_id: s.entryId, to_entry_id: s.managerEntryId, created_by: userId,
      }).select('id').single()
      if (row?.id) s.chargeId = row.id
    }
  }

  const allSlices = plan.filter(b => periodTotal(b.lines) > 0)
  // The period's status follows its entries, whichever part booked them: a posted bill and a
  // drafted month is still waiting on a person.
  const statusNow = await statusOfSlices(admin, fundId, booked)
  const patch: Record<string, unknown> = { postings: booked, status: statusNow, last_error: null, updated_at: new Date().toISOString() }
  if (statusNow === 'posted' && period.status !== 'posted') patch.posted_at = new Date().toISOString()

  // The invoice: one per payment, on the due date, whatever the accrual. The fee schedule's part.
  let invoice = period.invoice && period.invoice.status !== 'void' ? period.invoice : null
  const dueReached = opts.all || period.dueDate <= today
  if (part === 'schedule' && dueReached && period.total > 0) {
    const invoiceStatus: 'draft' | 'issued' = opts.mode === 'post' ? 'issued' : 'draft'
    if (!invoice) {
      const seq = await currentSeq(admin, period.id)
      invoice = { number: feeInvoiceNumber(period.start, vehicleId, seq), date: period.dueDate, status: invoiceStatus, amount: period.total }
    } else if (invoice.status === 'draft' && invoiceStatus === 'issued') {
      invoice = { ...invoice, status: 'issued', amount: period.total }
    }
    Object.assign(patch, { invoice_number: invoice.number, invoice_date: invoice.date, invoice_status: invoice.status, invoice_amount: invoice.amount })
  }
  const { error } = await (admin as any).from('management_fee_periods').update(patch).eq('id', period.id).eq('fund_id', fundId)
  if (error) return { error: error.message, status: 500 }
  if (monthly && part === 'schedule' && booked.length < allSlices.length) {
    warnings.push(`${booked.length} of ${allSlices.length} entries for this period are booked; the monthly spread (a recurring journal entry) books the rest as each month comes due.`)
  }
  return { periodId: period.id, status: statusNow, booked, invoice, warnings }
}

async function statusOfSlices(admin: SupabaseClient, fundId: string, booked: FeeSlice[]): Promise<FeePeriodStatus> {
  if (booked.length === 0) return 'scheduled'
  const { data } = await (admin as any).from('journal_entries').select('id, status').eq('book', ACTUAL_BOOK).eq('fund_id', fundId).in('id', booked.map(s => s.entryId))
  const rows = (data as any[]) ?? []
  return rows.some(e => e.status === 'draft') ? 'drafted' : 'posted'
}

/** One month slice of the spread, with what is booked for it. */
export interface FeeMonthSlice {
  periodId: string
  periodStart: string
  periodEnd: string
  kind: 'recognize' | 'charge'
  date: string
  amount: number
  /** The fund side's entry, when booked. */
  entryId: string | null
  entryStatus: 'draft' | 'posted' | null
  /** In advance: the period's bill is booked (recognizing before it would run prepaid fees negative). */
  billBooked: boolean
}

/**
 * Every month slice the vehicle's spread covers, period by period, booked or not. Empty when the
 * spread is off or there are no periods. Waived periods are left out.
 */
export async function feeMonthSlices(admin: SupabaseClient, fundId: string, group: string): Promise<FeeMonthSlice[] | { error: string }> {
  const view = await listFeePeriods(admin, fundId, group)
  if ('error' in view) return view
  if (!view.schedule?.monthlyAccrual) return []
  const ids = view.periods.flatMap(p => p.postings.map(s => s.entryId))
  const status = new Map<string, string>()
  for (let i = 0; i < ids.length; i += 200) {
    const { data } = await (admin as any).from('journal_entries').select('id, status').eq('book', ACTUAL_BOOK).eq('fund_id', fundId).in('id', ids.slice(i, i + 200))
    for (const e of (data as any[]) ?? []) status.set(e.id, e.status)
  }
  const out: FeeMonthSlice[] = []
  for (const p of view.periods) {
    if (p.status === 'waived') continue
    const byKey = new Map(p.postings.map(s => [bookingKey(s), s]))
    const plan = feeBookings(p, true, view.schedule?.timing)
    const billBooked = !plan.some(b => b.kind === 'bill') || p.postings.some(s => s.kind === 'bill')
    for (const b of plan) {
      if (b.kind === 'bill') continue
      const amount = periodTotal(b.lines)
      if (!(amount > 0)) continue
      const s = byKey.get(bookingKey(b))
      const st = s ? status.get(s.entryId) : undefined
      out.push({
        periodId: p.id, periodStart: p.start, periodEnd: p.end, kind: b.kind as 'recognize' | 'charge', date: b.date, amount,
        entryId: s?.entryId ?? null, entryStatus: st === 'draft' || st === 'posted' ? st : null, billBooked,
      })
    }
  }
  return out.sort((a, b) => a.date.localeCompare(b.date))
}

/**
 * Book the spread's month slices on these dates (the recurring entry's run, or a person choosing
 * them). A drafted slice is posted when mode is post and `promote` is given.
 */
export async function bookFeeMonths(
  admin: SupabaseClient, fundId: string, group: string, userId: string | null,
  opts: { dates: string[]; mode: 'draft' | 'post'; promote?: (entryId: string) => Promise<{ error?: string }> },
): Promise<{ booked: number; warnings: string[] } | { error: string; status: number }> {
  const slices = await feeMonthSlices(admin, fundId, group)
  if ('error' in slices) return { error: slices.error, status: 400 }
  const byPeriod = new Map<string, string[]>()
  for (const s of slices) {
    if (!opts.dates.includes(s.date)) continue
    if (s.entryStatus === 'posted' || (s.entryStatus === 'draft' && opts.mode === 'draft')) continue
    byPeriod.set(s.periodId, [...(byPeriod.get(s.periodId) ?? []), s.date])
  }
  let booked = 0
  const warnings: string[] = []
  for (const [periodId, dates] of byPeriod) {
    const r = await postFeePeriod(admin, fundId, group, userId, periodId, { mode: opts.mode, part: 'months', dates, all: true, promote: opts.promote })
    if ('error' in r) return r
    booked += dates.length
    warnings.push(...r.warnings)
  }
  return { booked, warnings }
}

async function accountBySubtype(admin: SupabaseClient, fundId: string, group: string, subtype: string): Promise<string | null> {
  const vehicleId = await vehicleIdByName(admin, fundId, group)
  const { data } = await (admin as any).from('chart_of_accounts').select('id').eq('fund_id', fundId).eq('vehicle_id', vehicleId).eq('subtype', subtype).limit(1)
  return ((data as any[])?.[0]?.id as string | undefined) ?? null
}

async function fundAccounts(
  admin: SupabaseClient, fundId: string, group: string, manager: { vehicleId: string; name: string } | null, spreads: boolean,
): Promise<{
  accts: { expense: string; offset: string | null; payable: string; bridge: string }
  prepaid?: string
  manager?: { receivable: string; income: string; deferred: string | null }
} | { error: string }> {
  let codes = await accountIdByCode(admin, fundId, group)
  if (!codes.has('5000') || !codes.has('3200') || !codes.has('2100') || !codes.has('5010')) {
    await ensureVehicleAccounts(admin, fundId, group)
    codes = await accountIdByCode(admin, fundId, group)
  }
  const expense = codes.get('5000'), bridge = codes.get('3200')
  if (!expense || !bridge) return { error: `${group}'s chart is missing 5000 Management fee or 3200 Undistributed earnings.` }
  let prepaid: string | undefined
  if (spreads) {
    prepaid = (await accountBySubtype(admin, fundId, group, 'prepaid_management_fee')) ?? undefined
    if (!prepaid) {
      await ensureVehicleAccounts(admin, fundId, group)
      prepaid = (await accountBySubtype(admin, fundId, group, 'prepaid_management_fee')) ?? undefined
    }
    if (!prepaid) return { error: `${group}'s chart has no Prepaid management fees account (1500), which spreading a fee billed in advance needs.` }
  }
  let payable = codes.get('2100') ?? null
  let managerAccts: { receivable: string; income: string; deferred: string | null } | undefined
  if (manager) {
    try {
      const vehicleId = await vehicleIdByName(admin, fundId, group)
      const fundIc = await ensureIntercompanyAccounts(admin, fundId, group, manager)
      const mIc = await ensureIntercompanyAccounts(admin, fundId, manager.name, { vehicleId: vehicleId!, name: group })
      const side = await resolveSideAccounts(admin, fundId, manager.name, 'management_fee', 'payee', mIc.receivableAccountId)
      if ('error' in side) return { error: side.error }
      let deferred: string | null = null
      if (spreads) {
        deferred = await accountBySubtype(admin, fundId, manager.name, 'deferred_revenue')
        if (!deferred) {
          await ensureVehicleAccounts(admin, fundId, manager.name)
          deferred = await accountBySubtype(admin, fundId, manager.name, 'deferred_revenue')
        }
        if (!deferred) return { error: `${manager.name}'s chart has no Deferred management fee revenue account (2400), which spreading a fee billed in advance needs.` }
      }
      payable = fundIc.payableAccountId
      managerAccts = { receivable: side.intercompanyAccountId, income: side.pnlAccountId!, deferred }
    } catch (e) {
      return { error: (e as Error).message }
    }
  }
  if (!payable) return { error: `${group}'s chart is missing 2100 Due to GP.` }
  return { accts: { expense, offset: codes.get('5010') ?? null, payable, bridge }, ...(prepaid ? { prepaid } : {}), ...(managerAccts ? { manager: managerAccts } : {}) }
}

/**
 * The daily tick's pass: every vehicle whose schedule posts on its own (postMode draft or post),
 * each period due by today booked and invoiced. Errors are kept on the period (last_error) and
 * returned; one vehicle failing never stops the rest.
 */
export async function postDueFeePeriods(admin: SupabaseClient, today: string): Promise<{ vehicles: number; booked: number; errors: string[] }> {
  const { data } = await (admin as any).from('vehicle_accounting_settings').select('fund_id, vehicle_id, fee_schedule').not('fee_schedule', 'is', null)
  const errors: string[] = []
  let vehicles = 0, booked = 0
  for (const row of (data as any[]) ?? []) {
    const mode = row.fee_schedule?.postMode
    if (mode !== 'draft' && mode !== 'post') continue
    const group = await vehicleNameById(admin, row.fund_id, row.vehicle_id)
    if (!group) continue
    vehicles++
    const gen = await generateFeePeriods(admin, row.fund_id, group)
    if ('error' in gen) { errors.push(`${group}: ${gen.error}`); continue }
    const view = await listFeePeriods(admin, row.fund_id, group)
    if ('error' in view) { errors.push(`${group}: ${view.error}`); continue }
    const monthly = !!view.schedule?.monthlyAccrual
    for (const p of view.periods) {
      if (p.status === 'waived') continue
      const plan = feeBookings(p, monthly, view.schedule?.timing).filter(b => periodTotal(b.lines) > 0 && bookingPart(b, monthly) === 'schedule')
      const have = new Set(p.postings.map(bookingKey))
      const due = plan.filter(b => b.date <= today && !have.has(bookingKey(b)))
      if (p.status === 'drafted' && !monthly) continue // waiting for a person to post the drafts
      if (due.length === 0 && (p.invoice || p.dueDate > today)) continue
      const r = await postFeePeriod(admin, row.fund_id, group, null, p.id, { mode, through: today, part: 'schedule' })
      if ('error' in r) errors.push(`${group} ${p.start}: ${r.error}`)
      else booked += r.booked.length - p.postings.length
    }
  }
  return { vehicles, booked, errors }
}

export interface FeePeriodCaller {
  fundId: string
  userId: string | null
  role: string
  mayTouchInvestments: () => Promise<boolean>
}

/**
 * Posts a draft entry as `who`, through the journal's own state change (its checks and audit), on
 * whichever vehicle's books the draft is: the manager's side lives on the manager's books.
 */
export async function entryPromoter(admin: SupabaseClient, who: FeePeriodCaller, group: string): Promise<(entryId: string) => Promise<{ error?: string }>> {
  const { changeEntryState } = await import('./journal-state')
  const vehicleId = await vehicleIdByName(admin, who.fundId, group)
  return async (entryId: string) => {
    const { data } = await (admin as any).from('journal_entries').select('vehicle_id').eq('book', ACTUAL_BOOK).eq('id', entryId).eq('fund_id', who.fundId).maybeSingle()
    const entryVehicle = (data?.vehicle_id as string | undefined) ?? vehicleId
    const entryGroup = entryVehicle === vehicleId ? group : (await vehicleNameById(admin, who.fundId, entryVehicle!)) ?? group
    const out = await changeEntryState(admin, { fundId: who.fundId, role: who.role, userId: who.userId ?? '', mayTouchInvestments: who.mayTouchInvestments }, entryGroup, entryVehicle!, { id: entryId, action: 'post' })
    return out.status >= 400 ? { error: String(out.body.error ?? 'could not post') } : {}
  }
}

/**
 * One action on a vehicle's fee periods, shared by the route and the MCP tools so both doors behave
 * the same: generate | edit | reset | waive | unwaive | post | draft.
 */
export async function runFeePeriodAction(
  admin: SupabaseClient, who: FeePeriodCaller, group: string, body: any,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const action = String(body?.action ?? '')
  const periodId = body?.periodId ? String(body.periodId) : ''
  const fail = (r: { error: string; status?: number }) => ({ status: r.status ?? 400, body: { error: r.error } })
  if (action === 'generate') {
    const r = await generateFeePeriods(admin, who.fundId, group)
    return 'error' in r ? fail(r) : { status: 200, body: { ok: true, ...r } }
  }
  if (!periodId) return fail({ error: 'periodId is required.' })
  if (action === 'edit') {
    const r = await editFeePeriod(admin, who.fundId, group, who.userId, periodId, body?.patch ?? body)
    return 'error' in r ? fail(r) : { status: 200, body: { ok: true, period: r.period } }
  }
  if (action === 'reset' || action === 'waive' || action === 'unwaive') {
    const r = await setFeePeriodState(admin, who.fundId, group, periodId, action)
    return 'error' in r ? fail(r) : { status: 200, body: { ok: true } }
  }
  if (action === 'post' || action === 'draft') {
    const promote = await entryPromoter(admin, who, group)
    const r = await postFeePeriod(admin, who.fundId, group, who.userId, periodId, {
      mode: action, all: body?.all === true, ...(typeof body?.through === 'string' && DATE.test(body.through) ? { through: body.through } : {}), promote,
    })
    return 'error' in r ? fail(r) : { status: 200, body: { ok: true, ...r } }
  }
  return fail({ error: 'action is one of generate, edit, reset, waive, unwaive, post, draft.' })
}
