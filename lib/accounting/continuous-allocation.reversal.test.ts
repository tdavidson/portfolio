import { describe, it, expect, vi } from 'vitest'
import { memoryAdmin } from '@/tests/helpers/memory-admin'

// Posting a reversal draft releases the entry it reverses; a failed allocation puts the entry
// back to draft on the actual book, and says so when it cannot.
vi.mock('./vehicle-id', () => ({ vehicleIdByName: async () => 'v', vehicleNameById: async () => 'Fund I' }))
vi.mock('./vehicle-domain', () => ({ vehicleKindByName: async () => 'fund' }))
vi.mock('./load', () => ({
  loadPostedLedger: async () => ({ accounts: [{ id: 'inc', code: '4100', type: 'income', subtype: 'interest_income' }], postings: [], capitalPostings: [] }),
  loadEntityNames: async () => new Map(), loadOwnership: async () => [],
}))
vi.mock('./persist', async (orig) => ({ ...(await orig<any>()), accountIdByCode: async () => new Map() }))
import { postExistingEntryWithAllocation } from './continuous-allocation'

const T1 = '00000000-0000-4000-8000-0000000000a1'

const O = '0a0a0a0a-0a0a-4a0a-8a0a-0a0a0a0a0a0a'
const chart = [
  { id: 'cash', fund_id: 'f', vehicle_id: 'v', code: '1000', type: 'asset', subtype: 'cash', company_id: null },
  { id: 'a1100', fund_id: 'f', vehicle_id: 'v', code: '1100-aa', type: 'asset', subtype: 'investment', company_id: 'co-a' },
]
const posting = (entry: string, account_id: string, amount: number, n: number) =>
  ({ id: `${entry}-${n}`, fund_id: 'f', vehicle_id: 'v', book: 'actual', journal_entry_id: entry, account_id, amount, currency: 'USD', lp_entity_id: null })

function pair() {
  return memoryAdmin({
    chart_of_accounts: chart,
    companies: [{ id: 'co-a', fund_id: 'f', name: 'Acme' }],
    investment_transactions: [{ id: T1, fund_id: 'f', company_id: 'co-a', transaction_type: 'investment', transaction_date: '2026-03-01' }],
    journal_entries: [
      { id: O, fund_id: 'f', vehicle_id: 'v', book: 'actual', status: 'posted', entry_date: '2026-03-01', source_ref: `txn:${T1}`, reversed_by: 'r1' },
      { id: 'r1', fund_id: 'f', vehicle_id: 'v', book: 'actual', status: 'draft', entry_date: '2026-04-01', memo: 'Reversal', source_type: 'investment', source_ref: `reversal:${O}`, reversed_by: null },
    ],
    journal_postings: [posting(O, 'a1100', 100, 0), posting(O, 'cash', -100, 1), posting('r1', 'a1100', -100, 0), posting('r1', 'cash', 100, 1)],
    fund_capital_events: [], fund_nav_statements: [],
  })
}

describe('posting a reversal draft', () => {
  it('deletes the transactions that owned the reversed entry, and says so', async () => {
    const m = pair()
    const r = await postExistingEntryWithAllocation(m.admin, 'f', 'Fund I', 'u', 'r1')
    expect(r).toMatchObject({ allocationEntryIds: [], removedTransactions: [expect.objectContaining({ id: T1, company: 'Acme' })], unlinkedRegisterRows: [] })
    expect(m.tables.investment_transactions).toEqual([])
    expect(m.tables.journal_entries.find(e => e.id === 'r1')?.status).toBe('posted')
    expect(m.tables.journal_entries.find(e => e.id === O)?.source_ref).toBeNull()
  })
  it('is refused, still a draft, when a conversion depends on the transaction', async () => {
    const m = pair()
    m.tables.investment_transactions.push({ id: 't2', fund_id: 'f', company_id: 'co-a', transaction_type: 'investment', converts_from_txn_id: T1 })
    expect(await postExistingEntryWithAllocation(m.admin, 'f', 'Fund I', 'u', 'r1')).toEqual({ error: expect.stringMatching(/conversion/) })
    expect(m.tables.journal_entries.find(e => e.id === 'r1')?.status).toBe('draft')
    expect(m.tables.investment_transactions).toHaveLength(2)
  })
  it('is refused, still a draft, for a caller without investments write (security M2)', async () => {
    const m = pair()
    expect(await postExistingEntryWithAllocation(m.admin, 'f', 'Fund I', 'u', 'r1', { investments: false }))
      .toEqual({ error: expect.stringMatching(/needs write access to investments/) })
    expect(m.tables.journal_entries.find(e => e.id === 'r1')?.status).toBe('draft')
    expect(m.tables.investment_transactions).toHaveLength(1)
  })
})

describe('a failed allocation', () => {
  const incomeDraft = () => memoryAdmin({
    chart_of_accounts: chart,
    journal_entries: [
      { id: 'e1', fund_id: 'f', vehicle_id: 'v', book: 'actual', status: 'draft', entry_date: '2026-03-01', memo: 'Interest', source_ref: null },
      { id: 'e1', fund_id: 'f', vehicle_id: 'v', book: 'tax', status: 'posted', entry_date: '2026-03-01', memo: 'Tax twin', source_ref: null },
    ],
    journal_postings: [posting('e1', 'inc', -10, 0), posting('e1', 'cash', 10, 1)],
  })
  it('puts the entry back to draft on the actual book only', async () => {
    const m = incomeDraft()
    expect(await postExistingEntryWithAllocation(m.admin, 'f', 'Fund I', 'u', 'e1')).toEqual({ error: expect.stringMatching(/3200/) })
    expect(m.tables.journal_entries.map(e => [e.book, e.status])).toEqual([['actual', 'draft'], ['tax', 'posted']])
  })
  it('names the entry when it cannot be put back to draft', async () => {
    const m = incomeDraft()
    // Allocation reads journal_entry_allocations once; the rollback touches it a second time,
    // right before the revert — the next journal_entries update, which is made to fail.
    const from = m.admin.from
    let seen = 0
    m.admin.from = (t: string) => {
      if (t === 'journal_entry_allocations' && ++seen === 2) m.failNext('journal_entries', 'update', 'revert failed')
      return from(t)
    }
    const r = await postExistingEntryWithAllocation(m.admin, 'f', 'Fund I', 'u', 'e1')
    expect(r).toEqual({ error: expect.stringMatching(/entry e1 is posted without its partner allocation.*revert failed/) })
  })
})
