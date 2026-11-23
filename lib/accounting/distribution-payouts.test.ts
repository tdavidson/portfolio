import { describe, it, expect } from 'vitest'
import * as XLSX from 'xlsx'
import { buildPayoutWorkbook, payoutRows } from './distribution-payouts'
import type { WireFull } from '@/lib/lps/wire-instructions'

const line = (o: Partial<any>) => ({
  id: 'l', lpEntityId: 'x', name: 'X', amount: 0, role: 'lp', character: {}, settled: 0, outstanding: 0, status: 'open',
  settledOn: null, noticeDocumentId: null, ...o,
}) as any

const wire = (o: Partial<WireFull>): WireFull => ({
  lpEntityId: 'a', beneficiaryName: 'Acme Capital LP', beneficiaryAddress: null, bankName: 'Example Bank', bankAddress: null,
  routingMasked: '••••0015', swiftCode: null, accountMasked: '••••6789', intermediaryBank: null, intermediarySwift: null,
  reference: null, currency: null, status: 'verified', enteredBy: 'jane@fund.example', enteredAt: '2026-01-05T00:00:00Z',
  verifiedBy: 'sam@fund.example', verifiedAt: '2026-01-06T00:00:00Z', verificationNote: 'Callback', routingNumber: '011000015',
  accountNumber: '00123456789', ...o,
})

const dist = {
  date: '2026-06-30',
  lines: [
    line({ id: '1', lpEntityId: 'a', name: 'Acme Capital LP', amount: 60_000, outstanding: 60_000 }),
    line({ id: '2', lpEntityId: 'gp', name: 'Example GP', amount: 20_000, outstanding: 20_000 }),
    line({ id: '3', lpEntityId: 'gp', name: 'Example GP', amount: 20_000, role: 'carry', outstanding: 15_000, settled: 5_000, deductions: [{ amount: 5_000, description: 'Fee' }] }),
    line({ id: '4', lpEntityId: 'b', name: 'Northwind Trust', amount: 10_000, outstanding: 10_000 }),
    line({ id: '5', lpEntityId: 'c', name: 'Paid Partner', amount: 5_000, outstanding: 0, settled: 5_000 }),
  ],
}

describe('payoutRows', () => {
  const wires = new Map<string, WireFull>([
    ['a', wire({})],
    ['gp', wire({ lpEntityId: 'gp', enteredAt: '2026-06-25T00:00:00Z' })],
    ['b', wire({ lpEntityId: 'b', status: 'unverified' })],
  ])
  const rows = payoutRows(dist, wires)
  const by = (id: string) => rows.find(r => r.lpEntityId === id)!

  it('pays a partner\'s capital and carry as one wire, net of deductions', () => {
    expect(by('gp')).toMatchObject({ capital: 20_000, carry: 20_000, gross: 40_000, deductions: 5_000, net: 35_000, paid: 0, leftToPay: 35_000 })
  })
  it('prints verified details and marks the row ready', () => {
    expect(by('a')).toMatchObject({ ready: true, flags: [] })
    expect(by('a').wire?.accountNumber).toBe('00123456789')
  })
  it('flags details changed shortly before the payment', () => {
    expect(by('gp').ready).toBe(false)
    expect(by('gp').flags.join(' ')).toMatch(/changed 5 day\(s\) before/)
  })
  it('leaves out unverified details, and says when nothing is on file or nothing is left to pay', () => {
    expect(by('b').wire).toBeNull()
    expect(by('b').flags.join(' ')).toMatch(/not verified/)
    expect(payoutRows(dist, new Map()).find(r => r.lpEntityId === 'a')!.flags).toEqual(['No bank details on file.'])
    expect(by('c').flags).toEqual(['Paid in full.'])
  })
})

describe('buildPayoutWorkbook', () => {
  it('keeps the leading zeros of account and routing numbers, and totals the amounts', () => {
    const rows = payoutRows(dist, new Map([['a', wire({})]]))
    const wb = XLSX.read(buildPayoutWorkbook({ fundName: 'Example Fund I', vehicle: 'Example Fund I', date: '2026-06-30', description: null, generatedAt: '2026-07-01T00:00:00Z', generatedBy: null }, rows), { type: 'buffer' })
    const aoa = XLSX.utils.sheet_to_json<unknown[]>(wb.Sheets.Payouts, { header: 1, raw: true })
    const acme = aoa.find(r => r[0] === 'Acme Capital LP')!
    expect(acme[12]).toBe('011000015')
    expect(acme[14]).toBe('00123456789')
    const total = aoa.find(r => r[0] === 'Total')!
    expect(total[3]).toBe(115_000)
  })
})
