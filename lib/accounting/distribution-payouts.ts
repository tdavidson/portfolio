// The payout sheet: one row per partner of a declared distribution, with what to wire and where.
//
// It is the one place full account numbers are printed, so it is admin-only and logged
// (app/api/accounting/distributions/payouts). It prints bank details only when they are verified,
// and flags what a person should look at before sending money:
//
//   * no bank details on file, or details not verified by callback — the row is left blank;
//   * details changed within RECENT_CHANGE_DAYS before the payment date, or after it — printed,
//     but flagged to confirm again;
//   * a partner already paid in full — nothing left to wire.
//
// A partner's capital line and carry line are one wire: the row shows both and pays their sum.

import * as XLSX from 'xlsx'
import type { SupabaseClient } from '@supabase/supabase-js'
import { roundCents } from './ledger'
import { DISTRIBUTION_XLSX_TYPE } from './distribution-workbook'
import type { DeclaredDistribution } from './distributions'
import { daysBetween, loadFullWires, RECENT_CHANGE_DAYS, type WireFull } from '@/lib/lps/wire-instructions'

export interface PayoutRow {
  lpEntityId: string
  partner: string
  capital: number
  carry: number
  gross: number
  deductions: number
  net: number
  /** Wired so far (what settled the lines, less the deductions). */
  paid: number
  leftToPay: number
  /** Printed only when verified. */
  wire: WireFull | null
  /** Why a person should look before paying; empty = ready. */
  flags: string[]
  ready: boolean
}

/** Pure: the rows from a declared distribution's lines and the bank details on file. */
export function payoutRows(d: Pick<DeclaredDistribution, 'date' | 'lines'>, wires: Map<string, WireFull>): PayoutRow[] {
  const byEntity = new Map<string, PayoutRow>()
  for (const l of d.lines) {
    let r = byEntity.get(l.lpEntityId)
    if (!r) {
      r = { lpEntityId: l.lpEntityId, partner: l.name, capital: 0, carry: 0, gross: 0, deductions: 0, net: 0, paid: 0, leftToPay: 0, wire: null, flags: [], ready: false }
      byEntity.set(l.lpEntityId, r)
    }
    if (l.role === 'carry') r.carry = roundCents(r.carry + l.amount)
    else r.capital = roundCents(r.capital + l.amount)
    const ded = roundCents((l.deductions ?? []).reduce((s, x) => s + x.amount, 0))
    r.deductions = roundCents(r.deductions + ded)
    r.paid = roundCents(r.paid + Math.max(0, l.settled - ded))
    r.leftToPay = roundCents(r.leftToPay + Math.max(0, l.outstanding))
  }
  const rows = Array.from(byEntity.values())
  for (const r of rows) {
    r.gross = roundCents(r.capital + r.carry)
    r.net = roundCents(r.gross - r.deductions)
    const w = wires.get(r.lpEntityId) ?? null
    if (r.leftToPay <= 0.005) {
      r.flags.push('Paid in full.')
    } else if (!w) {
      r.flags.push('No bank details on file.')
    } else if (w.status !== 'verified') {
      r.flags.push(`Bank details not verified by callback (ending ${w.accountMasked.slice(-4)}). Verify before paying.`)
    } else {
      r.wire = w
      const changedDaysBefore = daysBetween(w.enteredAt, d.date)
      if (changedDaysBefore < RECENT_CHANGE_DAYS) {
        r.flags.push(changedDaysBefore < 0
          ? `Bank details changed ${-changedDaysBefore} day(s) after the distribution date. Confirm again by callback before paying.`
          : `Bank details changed ${changedDaysBefore} day(s) before the distribution date. Confirm again by callback before paying.`)
      }
    }
    r.ready = r.leftToPay > 0.005 && !!r.wire && r.flags.length === 0
  }
  return rows.sort((a, b) => a.partner.localeCompare(b.partner))
}

const NUM = '#,##0.00;(#,##0.00)'

export function buildPayoutWorkbook(meta: { fundName: string; vehicle: string; date: string; description: string | null; generatedAt: string; generatedBy: string | null }, rows: PayoutRow[]): Buffer {
  const header = [
    'Partner', 'Distribution on capital', 'Carried interest', 'Gross', 'Deductions', 'Net payable', 'Paid', 'Left to pay',
    'Beneficiary', 'Beneficiary address', 'Bank', 'Bank address', 'ABA routing', 'SWIFT/BIC', 'Account / IBAN', 'Reference / FFC',
    'Intermediary bank', 'Intermediary SWIFT', 'Currency', 'Verified', 'Ready to pay', 'Check before paying',
  ]
  const aoa: (string | number | null)[][] = [
    [`${meta.fundName} — ${meta.vehicle}`],
    [`Distribution payout sheet — ${meta.date}${meta.description ? ` — ${meta.description}` : ''}`],
    [`Generated ${meta.generatedAt.slice(0, 16).replace('T', ' ')} UTC${meta.generatedBy ? ` by ${meta.generatedBy}` : ''}. Confidential: contains full account numbers. Bank details are printed only when verified by callback.`],
    [],
    header,
  ]
  const first = aoa.length
  for (const r of rows) {
    const w = r.wire
    aoa.push([
      r.partner, r.capital, r.carry, r.gross, r.deductions, r.net, r.paid, r.leftToPay,
      w?.beneficiaryName ?? null, w?.beneficiaryAddress ?? null, w?.bankName ?? null, w?.bankAddress ?? null,
      w?.routingNumber ?? null, w?.swiftCode ?? null, w?.accountNumber ?? null, w?.reference ?? null,
      w?.intermediaryBank ?? null, w?.intermediarySwift ?? null, w?.currency ?? null,
      w?.verifiedAt ? `${w.verifiedAt.slice(0, 10)}${w.verifiedBy ? ` by ${w.verifiedBy}` : ''}` : null,
      r.ready ? 'Yes' : 'No', r.flags.join(' ') || null,
    ])
  }
  const sum = (k: keyof PayoutRow) => roundCents(rows.reduce((s, r) => s + (r[k] as number), 0))
  aoa.push(['Total', sum('capital'), sum('carry'), sum('gross'), sum('deductions'), sum('net'), sum('paid'), sum('leftToPay')])

  const ws = XLSX.utils.aoa_to_sheet(aoa)
  for (let r = first; r < aoa.length; r++) {
    for (let c = 1; c <= 7; c++) {
      const cell = ws[XLSX.utils.encode_cell({ r, c })]
      if (cell && typeof cell.v === 'number') cell.z = NUM
    }
    // Account and routing numbers are text, so a leading zero survives.
    for (const c of [12, 14]) {
      const cell = ws[XLSX.utils.encode_cell({ r, c })]
      if (cell && cell.v != null) { cell.t = 's'; cell.v = String(cell.v) }
    }
  }
  ws['!cols'] = [30, 16, 16, 14, 12, 14, 12, 14, 28, 30, 24, 30, 12, 13, 22, 22, 22, 14, 9, 24, 8, 60].map(wch => ({ wch }))
  const wb = XLSX.utils.book_new()
  XLSX.utils.book_append_sheet(wb, ws, 'Payouts')
  return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }) as Buffer
}

export function payoutFileName(fundName: string, vehicle: string, date: string): string {
  const clean = (s: string) => s.replace(/[^\w .,-]/g, '').trim()
  return `${clean(fundName || 'Fund')} - ${clean(vehicle)} - Payouts ${date}.xlsx`
}

/** The sheet for one declared distribution; null when it is not on this vehicle. */
export async function distributionPayoutDocument(
  admin: SupabaseClient,
  fundId: string,
  group: string,
  distributionId: string,
  meta: { fundName: string; generatedBy: string | null },
  now: Date = new Date(),
): Promise<{ body: Buffer; fileName: string; contentType: string; rows: PayoutRow[] } | null> {
  const { listDistributions } = await import('./distributions')
  const d = (await listDistributions(admin, fundId, group)).find(x => x.distributionId === distributionId)
  if (!d) return null
  const wires = await loadFullWires(admin, fundId, Array.from(new Set(d.lines.map(l => l.lpEntityId))))
  const rows = payoutRows(d, wires)
  const body = buildPayoutWorkbook({ fundName: meta.fundName, vehicle: group, date: d.date, description: d.description, generatedAt: now.toISOString(), generatedBy: meta.generatedBy }, rows)
  return { body, fileName: payoutFileName(meta.fundName, group, d.date), contentType: DISTRIBUTION_XLSX_TYPE, rows }
}
