import { beforeEach, describe, expect, it, vi } from 'vitest'
import { memoryAdmin } from '@/tests/helpers/memory-admin'

const s = vi.hoisted(() => ({ m: null as any, drafts: 0 }))
vi.mock('@/lib/accounting/persist', () => ({
  accountIdByCode: async () => new Map([['1000', 'cash'], ['5100', 'expense']]),
  persistEntry: vi.fn(async (_a: any, fundId: string, _g: string, _u: any, entry: any, status: string) => {
    const id = `draft-${++s.drafts}`
    s.m.tables.journal_entries.push({ id, fund_id: fundId, vehicle_id: 'v', book: 'actual', status, source_type: entry.sourceType, entry_date: entry.entryDate })
    return { entryId: id }
  }),
}))
vi.mock('@/lib/accounting/vehicle-id', () => ({ vehicleIdByName: async () => 'v', vehicleNameById: async () => 'Fund I' }))
vi.mock('@/lib/accounting/provision-accounts', () => ({ ensureVehicleAccounts: async () => {} }))
vi.mock('@/lib/accounting/vendors', () => ({ vendorResolver: () => async () => null }))
vi.mock('@/lib/accounting/import-review', () => ({ reviewImport: async () => ({ differences: [], token: 't' }) }))
import { importBankTransactions } from '@/lib/accounting/bank-import'

const entry = (id: string, amount: number, over: Record<string, any> = {}) => ({
  id, fund_id: 'f', vehicle_id: 'v', book: 'actual', status: 'posted', entry_date: '2026-10-05',
  memo: `Investment ${id}`, source_ref: `txn:${id}`, source_type: 'investment', ...over, _cash: amount,
})
function seed(entries: any[], extra: Record<string, any[]> = {}, before?: any) {
  s.drafts = 0
  s.m = memoryAdmin({
    journal_entries: entries.map(({ _cash, ...e }) => e),
    journal_postings: entries.map(e => ({ journal_entry_id: e.id, book: 'actual', fund_id: 'f', account_id: 'cash', amount: e._cash })),
    bank_transactions: [], investment_transactions: [],
    ...extra,
  }, {
    unique: [
      { table: 'bank_transactions', key: (r: any) => r.journal_entry_id ?? null },
      { table: 'bank_transactions', key: (r: any) => (r.dedup_hash ? `${r.vehicle_id}|${r.dedup_hash}` : null) },
    ],
    before,
  })
  return s.m
}
const csv = (...rows: [string, string, number][]) => ['Date,Description,Amount', ...rows.map(r => r.join(','))].join('\n')
const ingest = (text: string) => importBankTransactions(s.m.admin, 'f', 'Fund I', 'u', text)
const bank = () => s.m.tables.bank_transactions

beforeEach(() => { s.drafts = 0 })

describe('bank import against posted investment entries', () => {
  it('one candidate: the row reconciles to it and no draft is made', async () => {
    seed([entry('e1', -1000)])
    expect(await ingest(csv(['2026-10-06', 'Wire to Acme', -1000]))).toMatchObject({ imported: 1, matched: 1 })
    expect(bank()[0]).toMatchObject({ status: 'reconciled', journal_entry_id: 'e1', raw: expect.objectContaining({ investmentReview: true }) })
    expect(s.drafts).toBe(0)
  })
  it('several candidates: held for review, no draft', async () => {
    seed([entry('e1', -1000), entry('e2', -1000)])
    expect(await ingest(csv(['2026-10-06', 'Wire', -1000]))).toMatchObject({ needsReview: 1 })
    expect(bank()[0]).toMatchObject({ status: 'unmatched', journal_entry_id: null })
    expect(s.drafts).toBe(0)
  })
  it('no candidate: today\'s auto-draft', async () => {
    seed([entry('e1', -1000)])
    await ingest(csv(['2026-10-06', 'Software', -55]))
    expect(bank()[0]).toMatchObject({ status: 'drafted' })
    expect(s.drafts).toBe(1)
  })
  it('one entry cannot explain two rows in one file', async () => {
    seed([entry('e1', -1000)])
    await ingest(csv(['2026-10-06', 'Wire A', -1000], ['2026-10-07', 'Wire B', -1000]))
    expect(bank().map((r: any) => r.status)).toEqual(['unmatched', 'unmatched'])
  })
  it('losing the claim to another row falls back to review', async () => {
    seed([entry('e1', -1000)], {}, (table: string, op: string, payload: any, tables: any) => {
      if (table === 'bank_transactions' && op === 'insert' && payload.journal_entry_id === 'e1' && !tables.bank_transactions.length) {
        tables.bank_transactions.push({ id: 'racer', vehicle_id: 'v', journal_entry_id: 'e1', dedup_hash: 'other' })
      }
    })
    expect(await ingest(csv(['2026-10-06', 'Wire', -1000]))).toMatchObject({ needsReview: 1, matched: 0 })
    expect(bank().find((r: any) => r.id !== 'racer')).toMatchObject({ status: 'unmatched', journal_entry_id: null })
  })
  it('a re-import skips the reconciled row', async () => {
    seed([entry('e1', -1000)])
    await ingest(csv(['2026-10-06', 'Wire', -1000]))
    expect(await ingest(csv(['2026-10-06', 'Wire', -1000]))).toMatchObject({ imported: 0, skipped: 1 })
    expect(bank()).toHaveLength(1)
  })
  it('an adopted QuickBooks entry is matched here, not held for QuickBooks review', async () => {
    seed([entry('qb1', -1000, { source_ref: 'qb:1', source_type: 'quickbooks' })],
      { investment_transactions: [{ id: 't', fund_id: 'f', adopted_entry_id: 'qb1' }] })
    await ingest(csv(['2026-10-06', 'Wire', -1000]))
    expect(bank()[0]).toMatchObject({ status: 'reconciled', journal_entry_id: 'qb1' })
    expect(bank()[0].raw.quickbooksReview).toBeUndefined()
  })
  it('a derived draft (allocation fallback) is a candidate, linked and left a draft', async () => {
    seed([entry('e1', -1000, { status: 'draft' })])
    await ingest(csv(['2026-10-06', 'Wire', -1000]))
    expect(bank()[0]).toMatchObject({ status: 'reconciled', journal_entry_id: 'e1' })
    expect(s.m.tables.journal_entries.find((e: any) => e.id === 'e1').status).toBe('draft')
  })
})
