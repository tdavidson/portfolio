// lib/accounting/adoption.test.ts
import { describe, it, expect, vi } from 'vitest'
import { memoryAdmin } from '@/tests/helpers/memory-admin'

vi.mock('./vehicle-id', () => ({ vehicleNameById: vi.fn(async () => 'Fund I (renamed)') }))
import { adoptEntry, entryIsOwned, removeAdopted, settleLostRace } from './adoption'

const chart = [
  { id: 'cash', fund_id: 'f', vehicle_id: 'v', code: '1000', type: 'asset', subtype: 'cash', company_id: null },
  { id: 'a1100', fund_id: 'f', vehicle_id: 'v', code: '1100-aa', type: 'asset', subtype: 'investment', company_id: 'co-a' },
  { id: 'p1100', fund_id: 'f', vehicle_id: 'v', code: '1100', type: 'asset', subtype: 'investment', company_id: null },
]
const purchase = [{ accountId: 'a1100', amount: 1000 }, { accountId: 'cash', amount: -1000 }]
const args = (over = {}) => ({ entryId: 'e1', vehicleId: 'v', entryDate: '2026-03-01', memo: 'QB 12', sourceRef: null, postings: purchase, ...over })

describe('adoptEntry', () => {
  it("inserts the transactions under the vehicle's CURRENT name, linked to the entry", async () => {
    const m = memoryAdmin({ chart_of_accounts: chart })
    const r = await adoptEntry(m.admin, 'f', args())
    expect(r).toEqual({ adoptedIds: [expect.any(String)] })
    expect(m.tables.investment_transactions).toEqual([expect.objectContaining({
      fund_id: 'f', company_id: 'co-a', transaction_type: 'investment', investment_cost: 1000,
      transaction_date: '2026-03-01', portfolio_group: 'Fund I (renamed)', adopted_entry_id: 'e1',
      notes: expect.stringContaining('QB 12'),
    })])
  })
  it('adopts nothing from a derived entry', async () => {
    const m = memoryAdmin({ chart_of_accounts: chart, investment_transactions: [{ id: '11111111-1111-4111-8111-111111111111', fund_id: 'f' }] })
    expect(await adoptEntry(m.admin, 'f', args({ sourceRef: 'txn:11111111-1111-4111-8111-111111111111' }))).toEqual({ adoptedIds: [] })
    expect(m.tables.investment_transactions).toHaveLength(1)
  })
  it('adopts nothing when no line is on an investment account', async () => {
    const m = memoryAdmin({ chart_of_accounts: chart })
    expect(await adoptEntry(m.admin, 'f', args({ postings: [{ accountId: 'cash', amount: 0 }] }))).toEqual({ adoptedIds: [] })
  })
  it('passes a refusal through and writes nothing', async () => {
    const m = memoryAdmin({ chart_of_accounts: chart })
    const r = await adoptEntry(m.admin, 'f', args({ postings: [{ accountId: 'p1100', amount: 5 }, { accountId: 'cash', amount: -5 }] }))
    expect(r).toEqual({ refused: expect.stringMatching(/pooled/) })
    expect(m.tables.investment_transactions ?? []).toEqual([])
  })
})

describe('entryIsOwned', () => {
  const seed = () => memoryAdmin({
    investment_transactions: [{ id: '11111111-1111-4111-8111-111111111111', fund_id: 'f', adopted_entry_id: null }, { id: 't2', fund_id: 'f', adopted_entry_id: 'e-adopted' }],
    journal_entries: [
      { id: '33333333-3333-4333-8333-333333333333', fund_id: 'f', book: 'actual', status: 'posted', reversed_by: null },
      { id: '44444444-4444-4444-8444-444444444444', fund_id: 'f', book: 'actual', status: 'posted', reversed_by: 'someone-else' },
    ],
  })
  it('derived, adopted and a live reversal pair are owned', async () => {
    const { admin } = seed()
    expect(await entryIsOwned(admin, 'f', { id: 'x', sourceRef: 'txn:11111111-1111-4111-8111-111111111111' })).toBe(true)
    expect(await entryIsOwned(admin, 'f', { id: 'e-adopted', sourceRef: null })).toBe(true)
    expect(await entryIsOwned(admin, 'f', { id: 'r', sourceRef: 'reversal:33333333-3333-4333-8333-333333333333' })).toBe(true)
  })
  it('a dangling txn: reference, a second reversal, and nothing at all are not', async () => {
    const { admin } = seed()
    expect(await entryIsOwned(admin, 'f', { id: 'x', sourceRef: 'txn:22222222-2222-4222-8222-222222222222' })).toBe(false)
    expect(await entryIsOwned(admin, 'f', { id: 'r2', sourceRef: 'reversal:44444444-4444-4444-8444-444444444444' })).toBe(false)
    expect(await entryIsOwned(admin, 'f', { id: 'x', sourceRef: null })).toBe(false)
  })
})

describe('settleLostRace', () => {
  it('removes mine when another request also adopted', async () => {
    const m = memoryAdmin({ investment_transactions: [{ id: 'mine', fund_id: 'f', adopted_entry_id: 'e1' }, { id: 'theirs', fund_id: 'f', adopted_entry_id: 'e1' }] })
    expect(await settleLostRace(m.admin, 'f', 'e1', ['mine'])).toEqual({})
    expect(m.tables.investment_transactions.map(t => t.id)).toEqual(['theirs'])
  })
  it('keeps mine when the winner relied on them', async () => {
    const m = memoryAdmin({ investment_transactions: [{ id: 'mine', fund_id: 'f', adopted_entry_id: 'e1' }] })
    await settleLostRace(m.admin, 'f', 'e1', ['mine'])
    expect(m.tables.investment_transactions.map(t => t.id)).toEqual(['mine'])
  })
})

describe('removeAdopted', () => {
  it('deletes only the given rows in this fund', async () => {
    const m = memoryAdmin({ investment_transactions: [{ id: 'a', fund_id: 'f' }, { id: 'b', fund_id: 'f' }, { id: 'a', fund_id: 'other' }] })
    await removeAdopted(m.admin, 'f', ['a'])
    expect(m.tables.investment_transactions).toEqual([{ id: 'b', fund_id: 'f' }, { id: 'a', fund_id: 'other' }])
  })
  it('returns the error instead of swallowing a failed delete', async () => {
    const m = memoryAdmin({ investment_transactions: [{ id: 'a', fund_id: 'f' }] })
    m.failNext('investment_transactions', 'delete', 'boom')
    expect(await removeAdopted(m.admin, 'f', ['a'])).toEqual({ error: 'boom' })
    expect(await removeAdopted(m.admin, 'f', [])).toEqual({})
  })
})

describe('rulings', () => {
  it('refuses, never throws, when the chart cannot be read', async () => {
    const m = memoryAdmin({ chart_of_accounts: chart })
    const admin = {
      from: (t: string) => t === 'chart_of_accounts'
        ? { select: () => { const q: any = { eq: () => q, order: () => q, range: () => q, then: (res: any) => res({ data: null, error: { message: 'boom' } }) }; return q } }
        : m.admin.from(t),
    } as any
    expect(await adoptEntry(admin, 'f', args())).toEqual({ refused: expect.stringMatching(/could not be read.*boom/) })
  })
  it('a reversal whose original was reversed by a void entry is still owned', async () => {
    const { admin } = memoryAdmin({ journal_entries: [
      { id: '33333333-3333-4333-8333-333333333333', fund_id: 'f', book: 'actual', status: 'posted', reversed_by: 'rev1' },
      { id: 'rev1', fund_id: 'f', book: 'actual', status: 'void', reversed_by: null },
    ] })
    expect(await entryIsOwned(admin, 'f', { id: 'rev2', sourceRef: 'reversal:33333333-3333-4333-8333-333333333333' })).toBe(true)
  })
  it('but not when that reversal is posted', async () => {
    const { admin } = memoryAdmin({ journal_entries: [
      { id: '33333333-3333-4333-8333-333333333333', fund_id: 'f', book: 'actual', status: 'posted', reversed_by: 'rev1' },
      { id: 'rev1', fund_id: 'f', book: 'actual', status: 'posted', reversed_by: null },
    ] })
    expect(await entryIsOwned(admin, 'f', { id: 'rev2', sourceRef: 'reversal:33333333-3333-4333-8333-333333333333' })).toBe(false)
  })
})

describe('failure handling', () => {
  const failing = (table: string) => {
    const m = memoryAdmin({ chart_of_accounts: chart })
    const admin = { from: (t: string) => t === table
      ? { select: () => { const q: any = { eq: () => q, limit: () => q, maybeSingle: () => q, then: (res: any) => res({ data: null, error: { message: 'boom' } }) }; return q } }
      : m.admin.from(t) } as any
    return admin
  }
  it('entryIsOwned rejects when a read errors', async () => {
    await expect(entryIsOwned(failing('investment_transactions'), 'f', { id: 'e1', sourceRef: null })).rejects.toThrow(/Ownership could not be checked: boom/)
  })
  it('adoptEntry refuses rather than risk duplicating when the ownership read errors', async () => {
    expect(await adoptEntry(failing('investment_transactions'), 'f', args())).toEqual({ refused: expect.stringMatching(/not posted.*boom/) })
  })
  it('a non-uuid txn: or reversal: ref is not ownership and is never looked up', async () => {
    const seen: string[] = []
    const admin = { from: (t: string) => { seen.push(t); const q: any = { select: () => q, eq: (c: string) => { seen.push(c); return q }, limit: () => q, then: (res: any) => res({ data: [], error: null }) }; return q } } as any
    expect(await entryIsOwned(admin, 'f', { id: 'e', sourceRef: 'txn:not-a-uuid' })).toBe(false)
    expect(await entryIsOwned(admin, 'f', { id: 'e', sourceRef: 'reversal:nope' })).toBe(false)
    expect(seen).not.toContain('journal_entries')
    expect(seen).not.toContain('id')
  })
  it('refuses when the insert errors', async () => {
    const m = memoryAdmin({ chart_of_accounts: chart })
    m.failNext('investment_transactions', 'insert', 'boom')
    expect(await adoptEntry(m.admin, 'f', args())).toEqual({ refused: expect.stringMatching(/could not be recorded.*boom/) })
  })
  it('refuses when the vehicle name cannot be resolved', async () => {
    const { vehicleNameById } = await import('./vehicle-id')
    vi.mocked(vehicleNameById).mockResolvedValueOnce(null as any)
    const m = memoryAdmin({ chart_of_accounts: chart })
    expect(await adoptEntry(m.admin, 'f', args())).toEqual({ refused: expect.stringMatching(/entity could not be found/) })
    expect(m.tables.investment_transactions ?? []).toEqual([])
  })
})
