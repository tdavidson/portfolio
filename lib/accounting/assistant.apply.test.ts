// applyProposal's edit path on entries investment transactions care about (review M-2 / T-5).
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { memoryAdmin } from '@/tests/helpers/memory-admin'

vi.mock('./vehicle-id', () => ({ vehicleIdByName: async () => 'v', vehicleNameById: async () => 'Fund I' }))
vi.mock('./load', () => ({ loadEntityNames: async () => new Map(), loadPostedLedger: async () => ({ accounts: [], postings: [], capitalPostings: [] }) }))
vi.mock('./periods', () => ({ closedPeriodRanges: async () => [], dateInAnyClosedPeriod: () => false }))
vi.mock('./currency', () => ({ fundCurrency: async () => 'USD' }))
import { applyProposal } from './assistant'

const T1 = '00000000-0000-4000-8000-0000000000d1'
const O = '00000000-0000-4000-8000-0000000000d2'
const chart = [
  { id: 'cost', fund_id: 'f', vehicle_id: 'v', code: '1100-a', type: 'asset', subtype: 'investment', company_id: 'co-a' },
  { id: 'cash', fund_id: 'f', vehicle_id: 'v', code: '1000', type: 'asset', subtype: 'cash', company_id: null },
]
const edit = (entryId: string) => ({
  type: 'edit', entryId, entryDate: '2026-03-01', memo: 'fixed', sourceType: 'manual',
  postings: [{ accountCode: '1100-a', amount: 50, lpEntity: null }, { accountCode: '1000', amount: -50, lpEntity: null }],
}) as any
let m: ReturnType<typeof memoryAdmin>
beforeEach(() => {
  m = memoryAdmin({
    chart_of_accounts: chart,
    companies: [{ id: 'co-a', fund_id: 'f', name: 'Acme' }],
    investment_transactions: [{ id: T1, fund_id: 'f', company_id: 'co-a', transaction_type: 'investment' }],
    journal_entries: [
      { id: 'e1', fund_id: 'f', vehicle_id: 'v', book: 'actual', status: 'posted', entry_date: '2026-03-01', source_ref: `txn:${T1}`, reversed_by: null },
      { id: O, fund_id: 'f', vehicle_id: 'v', book: 'actual', status: 'posted', entry_date: '2026-03-01', source_ref: null, reversed_by: 'r1' },
      { id: 'r1', fund_id: 'f', vehicle_id: 'v', book: 'actual', status: 'posted', entry_date: '2026-04-01', source_ref: `reversal:${O}`, reversed_by: null },
    ],
    journal_postings: [
      { id: 'p1', journal_entry_id: O, book: 'actual', fund_id: 'f', account_id: 'cost', amount: 100 },
      { id: 'p2', journal_entry_id: 'r1', book: 'actual', fund_id: 'f', account_id: 'cost', amount: -100 },
    ],
    journal_entry_allocations: [], bank_transactions: [], fund_capital_events: [], fund_nav_statements: [],
  })
})

describe('assistant edit', () => {
  it('refuses either half of a live reversal pair on investment accounts', async () => {
    for (const id of [O, 'r1']) {
      expect(await applyProposal(m.admin, 'f', 'Fund I', 'u', edit(id))).toEqual({ error: 'This entry is half of a reversal pair — reverse the reversal instead.' })
    }
    expect(m.tables.journal_entries.every((e: any) => e.status === 'posted')).toBe(true)
  })
  it('editing an owned posted entry deletes its transaction and says so', async () => {
    const r = await applyProposal(m.admin, 'f', 'Fund I', 'u', edit('e1'))
    expect(r).toMatchObject({ entryId: 'e1', removedTransactions: [{ id: T1, company: 'Acme' }] })
    expect(m.tables.investment_transactions).toEqual([])
    expect(m.tables.journal_entries[0].status).toBe('draft')
  })
  it('a failed unpost is reported, not ignored', async () => {
    const from = m.admin.from
    m.admin.from = (t: string) => {
      const q = from(t)
      if (t !== 'journal_entries') return q
      const update = q.update.bind(q)
      q.update = (v: any) => { if (v.status === 'draft') m.failNext('journal_entries', 'update', 'unpost failed'); return update(v) }
      return q
    }
    const r = await applyProposal(m.admin, 'f', 'Fund I', 'u', edit('e1'))
    expect(r).toMatchObject({ error: expect.stringMatching(/could not be put back to draft.*unpost failed/), removedTransactions: [{ id: T1 }] })
    expect(m.tables.journal_postings.filter((p: any) => p.journal_entry_id === 'e1')).toEqual([])
  })
})

describe('assistant edit without investments write (security M2)', () => {
  it('refuses to edit an owned entry and deletes nothing', async () => {
    expect(await applyProposal(m.admin, 'f', 'Fund I', 'u', edit('e1'), { investments: false })).toEqual({ error: expect.stringMatching(/needs write access to investments/) })
    expect(m.tables.investment_transactions).toHaveLength(1)
    expect(m.tables.journal_entries[0].status).toBe('posted')
  })
})
