// postExistingEntryWithAllocation's failure paths: a postings read that fails, and an allocation
// failure whose cleanup fails twice over (consistency review M-3 / T-3).
import { describe, it, expect, vi } from 'vitest'
import { memoryAdmin } from '@/tests/helpers/memory-admin'

vi.mock('./vehicle-id', () => ({ vehicleIdByName: async () => 'v', vehicleNameById: async () => 'Fund I' }))
// The allocation's view of the ledger sees an income line, so it allocates — and, with no 3200 in
// the chart, fails. Adoption reads the real chart table, where 'inc' is not an investment account.
vi.mock('./load', () => ({
  loadPostedLedger: async () => ({ accounts: [{ id: 'inc', code: '4000', type: 'income', subtype: 'other' }], postings: [], capitalPostings: [] }),
  loadEntityNames: async () => new Map(), loadOwnership: async () => [],
}))
import { postExistingEntryWithAllocation } from './continuous-allocation'

const chart = [
  { id: 'cash', fund_id: 'f', vehicle_id: 'v', code: '1000', type: 'asset', subtype: 'cash', company_id: null },
  { id: 'a1100', fund_id: 'f', vehicle_id: 'v', code: '1100-aa', type: 'asset', subtype: 'investment', company_id: 'co-a' },
  { id: 'inc', fund_id: 'f', vehicle_id: 'v', code: '4000', type: 'income', subtype: 'other', company_id: null },
]
const seed = () => ({
  chart_of_accounts: chart,
  fund_vehicles: [{ id: 'v', fund_id: 'f', name: 'Fund I', kind: 'fund' }],
  journal_entries: [{ id: 'e1', fund_id: 'f', vehicle_id: 'v', book: 'actual', status: 'draft', entry_date: '2026-03-01', memo: 'QB', source_type: 'quickbooks', source_ref: 'qb:1' }],
  journal_postings: [['a1100', 1000], ['cash', -900], ['inc', -100]].map(([account_id, amount], n) => ({ id: `p${n}`, fund_id: 'f', vehicle_id: 'v', book: 'actual', journal_entry_id: 'e1', account_id, amount, currency: 'USD', lp_entity_id: null })),
  journal_entry_allocations: [], investment_transactions: [],
})

describe('postExistingEntryWithAllocation cleanup', () => {
  it('a failed postings read refuses rather than posting the entry unowned', async () => {
    const m = memoryAdmin(seed())
    m.failNext('journal_postings', 'select', 'read failed')
    expect(await postExistingEntryWithAllocation(m.admin, 'f', 'Fund I', 'u', 'e1')).toEqual({ error: expect.stringMatching(/could not be read.*read failed/) })
    expect(m.tables.journal_entries[0].status).toBe('draft')
    expect(m.tables.investment_transactions).toEqual([])
  })
  it('an allocation failure undoes the adoption and keeps the draft', async () => {
    const m = memoryAdmin(seed())
    const r = await postExistingEntryWithAllocation(m.admin, 'f', 'Fund I', 'u', 'e1')
    expect(r).toEqual({ error: expect.stringMatching(/Missing account 3200/) })
    expect(m.tables.journal_entries[0].status).toBe('draft')
    expect(m.tables.investment_transactions).toEqual([])
  })
  it('when the revert AND the adoption undo both fail, both are reported', async () => {
    const m = memoryAdmin(seed(), {
      before: (table, op, payload) => {
        if (table === 'journal_entries' && op === 'update' && payload.status === 'draft') m.failNext('journal_entries', 'update', 'revert failed')
        if (table === 'investment_transactions' && op === 'delete') m.failNext('investment_transactions', 'delete', 'undo failed')
      },
    })
    const r = await postExistingEntryWithAllocation(m.admin, 'f', 'Fund I', 'u', 'e1') as { error: string }
    expect(r.error).toMatch(/revert failed/)
    expect(r.error).toMatch(/could not be undone either \(undo failed\)/)
  })
})
