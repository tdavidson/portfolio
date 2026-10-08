import { describe, it, expect, vi } from 'vitest'
import { memoryAdmin } from '@/tests/helpers/memory-admin'

vi.mock('./vehicle-id', () => ({ vehicleIdByName: async () => 'v', vehicleNameById: async () => 'Fund I' }))
vi.mock('./load', () => ({ loadPostedLedger: async () => ({ accounts: [], postings: [], capitalPostings: [] }), loadEntityNames: async () => new Map(), loadOwnership: async () => [] }))
import { postExistingEntryWithAllocation } from './continuous-allocation'

const chart = [
  { id: 'cash', fund_id: 'f', vehicle_id: 'v', code: '1000', type: 'asset', subtype: 'cash', company_id: null },
  { id: 'a1100', fund_id: 'f', vehicle_id: 'v', code: '1100-aa', type: 'asset', subtype: 'investment', company_id: 'co-a' },
  { id: 'p1100', fund_id: 'f', vehicle_id: 'v', code: '1100', type: 'asset', subtype: 'investment', company_id: null },
]
const seed = (lines: [string, number][], extra: Record<string, any[]> = {}) => ({
  chart_of_accounts: chart,
  journal_entries: [{ id: 'e1', fund_id: 'f', vehicle_id: 'v', book: 'actual', status: 'draft', entry_date: '2026-03-01', memo: 'QB', source_type: 'quickbooks', source_ref: 'qb:1' }],
  journal_postings: lines.map(([account_id, amount], n) => ({ id: `p${n}`, fund_id: 'f', vehicle_id: 'v', book: 'actual', journal_entry_id: 'e1', account_id, amount, currency: 'USD', lp_entity_id: null })),
  ...extra,
})

describe('postExistingEntryWithAllocation adopts before the flip', () => {
  it('adopts a QuickBooks draft and posts it', async () => {
    const m = memoryAdmin(seed([['a1100', 1000], ['cash', -1000]]))
    expect(await postExistingEntryWithAllocation(m.admin, 'f', 'Fund I', 'u', 'e1')).toEqual({ allocationEntryIds: [] })
    expect(m.tables.journal_entries[0].status).toBe('posted')
    expect(m.tables.investment_transactions).toEqual([expect.objectContaining({ adopted_entry_id: 'e1' })])
  })
  it('a refused shape stays a draft, with the reason', async () => {
    const m = memoryAdmin(seed([['p1100', 1000], ['cash', -1000]]))
    expect(await postExistingEntryWithAllocation(m.admin, 'f', 'Fund I', 'u', 'e1')).toEqual({ error: expect.stringMatching(/pooled/) })
    expect(m.tables.journal_entries[0].status).toBe('draft')
  })
  it('losing the flip to a request that also adopted removes ours', async () => {
    const m = memoryAdmin(seed([['a1100', 1000], ['cash', -1000]]), {
      before: (table, op, payload, tables) => {
        if (table === 'journal_entries' && op === 'update' && payload.status === 'posted') {
          tables.journal_entries[0].status = 'posted'
          tables.investment_transactions.push({ id: 'theirs', fund_id: 'f', adopted_entry_id: 'e1' })
        }
      },
    })
    expect(await postExistingEntryWithAllocation(m.admin, 'f', 'Fund I', 'u', 'e1')).toEqual({ error: 'Only a draft entry can be posted' })
    expect(m.tables.investment_transactions.map(t => t.id)).toEqual(['theirs'])
  })
  it('losing the flip to a request that adopted nothing keeps ours', async () => {
    const m = memoryAdmin(seed([['a1100', 1000], ['cash', -1000]]), {
      before: (table, op, payload, tables) => {
        if (table === 'journal_entries' && op === 'update' && payload.status === 'posted') tables.journal_entries[0].status = 'posted'
      },
    })
    await postExistingEntryWithAllocation(m.admin, 'f', 'Fund I', 'u', 'e1')
    expect(m.tables.investment_transactions).toHaveLength(1)
  })
})
