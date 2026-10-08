import { describe, it, expect } from 'vitest'
import { memoryAdmin } from '@/tests/helpers/memory-admin'
import { linkOpenBankRow } from './investment-bank-match'

const base = (bank: any[], extraEntries: any[] = []) => memoryAdmin({
  chart_of_accounts: [{ id: 'cash', fund_id: 'f', vehicle_id: 'v', code: '1000' }],
  journal_entries: [
    { id: 'e1', fund_id: 'f', vehicle_id: 'v', book: 'actual', status: 'posted', entry_date: '2026-10-05', source_ref: 'txn:t1' },
    ...extraEntries,
  ],
  journal_postings: [{ journal_entry_id: 'e1', book: 'actual', fund_id: 'f', account_id: 'cash', amount: -1000 }],
  bank_transactions: bank,
}, { unique: [{ table: 'bank_transactions', key: (r: any) => r.journal_entry_id ?? null }] })
const row = (id: string, over: any = {}) => ({ id, fund_id: 'f', vehicle_id: 'v', amount: -1000, txn_date: '2026-10-06', status: 'drafted', journal_entry_id: null, raw: {}, ...over })

describe('linkOpenBankRow', () => {
  it('links the one open row of that amount and retires its auto-draft', async () => {
    const m = base([row('b1', { journal_entry_id: 'auto' })], [{ id: 'auto', fund_id: 'f', book: 'actual', status: 'draft', source_ref: null }])
    expect(await linkOpenBankRow(m.admin, 'f', 'e1')).toBe('b1')
    expect(m.tables.bank_transactions[0]).toMatchObject({ status: 'reconciled', journal_entry_id: 'e1' })
    expect(m.tables.journal_entries.map((e: any) => e.id)).toEqual(['e1'])
  })
  it('links a released row that has no placeholder', async () => {
    const m = base([row('b1', { status: 'unmatched' })])
    expect(await linkOpenBankRow(m.admin, 'f', 'e1')).toBe('b1')
  })
  it('does nothing with several candidates, a row under review, or one held by another derived entry', async () => {
    expect(await linkOpenBankRow(base([row('b1'), row('b2')]).admin, 'f', 'e1')).toBeNull()
    expect(await linkOpenBankRow(base([row('b1', { status: 'unmatched', raw: { quickbooksReview: true } })]).admin, 'f', 'e1')).toBeNull()
    const held = base([row('b1', { journal_entry_id: 'other' })], [{ id: 'other', fund_id: 'f', book: 'actual', status: 'draft', source_ref: 'txn:t9' }])
    expect(await linkOpenBankRow(held.admin, 'f', 'e1')).toBeNull()
  })
  it('ignores rows outside seven days or of another amount', async () => {
    expect(await linkOpenBankRow(base([row('b1', { txn_date: '2026-10-20' }), row('b2', { amount: -999 })]).admin, 'f', 'e1')).toBeNull()
  })
})
