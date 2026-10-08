import { describe, it, expect, vi, beforeEach } from 'vitest'
import { memoryAdmin } from '@/tests/helpers/memory-admin'

vi.mock('./currency', () => ({ fundCurrency: async () => 'USD' }))
vi.mock('./periods', () => ({ closedPeriodRanges: async () => [], dateInAnyClosedPeriod: () => false }))
vi.mock('./vehicle-id', () => ({ vehicleIdByName: async () => 'v', vehicleNameById: async () => 'Fund I' }))
const allocate = vi.fn(async () => ({ allocationEntryIds: [] as string[] }))
vi.mock('./continuous-allocation', () => ({ allocatePostedEntry: (...a: any[]) => (allocate as any)(...a), rollbackGeneratedAllocations: vi.fn(async () => {}) }))
import { persistEntry } from './persist'

const TXN = '00000000-0000-0000-0000-0000000000a1'
const chart = [
  { id: 'cash', fund_id: 'f', vehicle_id: 'v', code: '1000', type: 'asset', subtype: 'cash', company_id: null },
  { id: 'a1100', fund_id: 'f', vehicle_id: 'v', code: '1100-aa', type: 'asset', subtype: 'investment', company_id: 'co-a' },
  { id: 'p1100', fund_id: 'f', vehicle_id: 'v', code: '1100', type: 'asset', subtype: 'investment', company_id: null },
]
const entry = (lines: [string, number][], over = {}) => ({
  fundId: 'f', entryDate: '2026-03-01', memo: 'QB 12',
  postings: lines.map(([accountId, amount]) => ({ accountId, amount, currency: 'USD', lpEntityId: null })), ...over,
})
const purchase: [string, number][] = [['a1100', 1000], ['cash', -1000]]

beforeEach(() => { allocate.mockReset().mockResolvedValue({ allocationEntryIds: [] }) })

describe('persistEntry adopts before it posts', () => {
  it('an unowned investment entry is adopted, then posted', async () => {
    const m = memoryAdmin({ chart_of_accounts: chart })
    const r = await persistEntry(m.admin, 'f', 'Fund I', 'u', entry(purchase), 'posted')
    expect(r).toEqual({ entryId: expect.any(String) })
    const id = (r as any).entryId
    expect(m.tables.journal_entries).toEqual([expect.objectContaining({ id, status: 'posted' })])
    expect(m.tables.investment_transactions).toEqual([expect.objectContaining({ adopted_entry_id: id, investment_cost: 1000 })])
  })
  it('a refused shape leaves nothing behind and says why', async () => {
    const m = memoryAdmin({ chart_of_accounts: chart })
    const r = await persistEntry(m.admin, 'f', 'Fund I', 'u', entry([['p1100', 5], ['cash', -5]]), 'posted')
    expect(r).toEqual({ error: expect.stringMatching(/pooled/), adoptionRefused: true })
    expect(m.tables.journal_entries ?? []).toEqual([])
  })
  it('a failed allocation removes the adopted transactions with the entry', async () => {
    allocate.mockResolvedValueOnce({ error: 'No partner participates' } as any)
    const m = memoryAdmin({ chart_of_accounts: chart })
    const r = await persistEntry(m.admin, 'f', 'Fund I', 'u', entry(purchase), 'posted')
    expect(r).toMatchObject({ allocationFailed: true })
    expect(m.tables.journal_entries ?? []).toEqual([])
    expect(m.tables.investment_transactions ?? []).toEqual([])
  })
  it('a derived entry adopts nothing', async () => {
    const m = memoryAdmin({ chart_of_accounts: chart, investment_transactions: [{ id: TXN, fund_id: 'f' }] })
    await persistEntry(m.admin, 'f', 'Fund I', 'u', entry(purchase, { sourceRef: `txn:${TXN}` }), 'posted')
    expect(m.tables.investment_transactions).toHaveLength(1)
  })
  it('a draft and a tax-book entry adopt nothing', async () => {
    const m = memoryAdmin({ chart_of_accounts: chart })
    await persistEntry(m.admin, 'f', 'Fund I', 'u', entry(purchase), 'draft')
    await persistEntry(m.admin, 'f', 'Fund I', 'u', entry(purchase), 'posted', 'tax' as any)
    expect(m.tables.investment_transactions ?? []).toEqual([])
    expect(m.tables.journal_entries.map(e => e.status)).toEqual(['draft', 'posted'])
  })
  it('losing the flip to another post allocates nothing and leaves the winner its entry', async () => {
    const m = memoryAdmin({ chart_of_accounts: chart }, {
      before: (table, op, payload, tables) => {
        if (table === 'journal_entries' && op === 'update' && payload.status === 'posted') tables.journal_entries[0].status = 'posted'
      },
    })
    const r = await persistEntry(m.admin, 'f', 'Fund I', 'u', entry(purchase), 'posted')
    expect(r).toEqual({ error: 'This entry was posted by another request at the same time.' })
    expect(allocate).not.toHaveBeenCalled()
    expect(m.tables.journal_entries).toEqual([expect.objectContaining({ status: 'posted' })])
  })
  it('keeps the entry as a draft when its adopted transactions cannot be removed', async () => {
    allocate.mockResolvedValueOnce({ error: 'No partner participates' } as any)
    const m = memoryAdmin({ chart_of_accounts: chart })
    m.failNext('investment_transactions', 'delete', 'boom')
    const r = await persistEntry(m.admin, 'f', 'Fund I', 'u', entry(purchase), 'posted')
    expect(r).toEqual({ error: expect.stringMatching(/kept as a draft.*boom/) })
    expect(m.tables.journal_entries).toEqual([expect.objectContaining({ status: 'draft' })])
    expect(m.tables.investment_transactions).toHaveLength(1)
  })
})
