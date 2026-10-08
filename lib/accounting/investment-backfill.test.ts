import { describe, it, expect, vi, beforeEach } from 'vitest'
import { memoryAdmin } from '@/tests/helpers/memory-admin'

const h = vi.hoisted(() => ({ derive: vi.fn(), post: vi.fn(), link: vi.fn(), adopt: vi.fn() }))
vi.mock('./vehicle-id', () => ({ vehicleIdByName: async () => 'v' }))
vi.mock('./from-portfolio', async (orig) => ({ ...(await orig<any>()), draftEntryForTransaction: h.derive }))
vi.mock('./continuous-allocation', () => ({ postExistingEntryWithAllocation: h.post }))
vi.mock('./investment-bank-match', () => ({ linkOpenBankRow: h.link }))
vi.mock('./adoption', async (orig) => ({ ...(await orig<any>()), adoptEntry: h.adopt }))
import { backfillDerivedEntries, countUnderived } from './investment-backfill'

const chart = [
  { id: 'cash', fund_id: 'f', vehicle_id: 'v', code: '1000', type: 'asset', subtype: 'cash', company_id: null },
  { id: 'a1100', fund_id: 'f', vehicle_id: 'v', code: '1100-a', type: 'asset', subtype: 'investment', company_id: 'co' },
  { id: 'p4200', fund_id: 'f', vehicle_id: 'v', code: '4200', type: 'income', subtype: 'unrealized', company_id: null },
]
const entry = (id: string, over: any = {}) => ({ id, fund_id: 'f', vehicle_id: 'v', book: 'actual', status: 'posted', entry_date: '2026-01-15', memo: id, source_ref: null, reversed_by: null, ...over })
const line = (entryId: string, account_id: string, amount: number) => ({ journal_entry_id: entryId, book: 'actual', fund_id: 'f', account_id, amount })
const txn = (id: string, over: any = {}) => ({ id, fund_id: 'f', company_id: 'co', portfolio_group: 'Fund I', transaction_type: 'investment', investment_cost: 100, transaction_date: '2026-02-01', adopted_entry_id: null, ...over })

function seed(t: Record<string, any[]>) {
  return memoryAdmin({
    fund_vehicles: [{ id: 'v', fund_id: 'f', name: 'Fund I', aliases: ['Fund One'] }],
    chart_of_accounts: chart, companies: [{ id: 'co', fund_id: 'f', name: 'Acme' }],
    journal_entries: [], journal_postings: [], investment_transactions: [], ...t,
  })
}

beforeEach(() => {
  h.derive.mockReset().mockResolvedValue({ drafted: true, posted: true, entryId: 'new' })
  h.post.mockReset().mockResolvedValue({ allocationEntryIds: [] })
  h.link.mockReset().mockResolvedValue('b1')
  h.adopt.mockReset().mockResolvedValue({ adoptedIds: ['t-adopted'] })
})

describe('backfillDerivedEntries', () => {
  it('adopts unowned posted investment entries, skipping derived, adopted, income-only and reversal pairs', async () => {
    const m = seed({
      journal_entries: [entry('qb'), entry('derived', { source_ref: 'txn:x' }), entry('owned'), entry('income'),
        entry('orig', { reversed_by: 'rev' }), entry('rev', { source_ref: 'reversal:orig' })],
      journal_postings: [line('qb', 'a1100', 100), line('derived', 'a1100', 100), line('owned', 'a1100', 100), line('income', 'p4200', -5),
        line('orig', 'a1100', 100), line('rev', 'a1100', -100)],
      investment_transactions: [txn('x'), txn('o', { adopted_entry_id: 'owned' })],
    })
    const r = await backfillDerivedEntries(m.admin, 'f', 'Fund I', 'u')
    expect(h.adopt).toHaveBeenCalledTimes(1)
    expect(h.adopt.mock.calls[0][2]).toMatchObject({ entryId: 'qb', vehicleId: 'v' })
    expect(r).toMatchObject({ toAdopt: 1, adopted: 1 })
  })
  it('derives transactions with no entry, by name or alias, and leaves adopted ones alone', async () => {
    const m = seed({ investment_transactions: [txn('a'), txn('b', { portfolio_group: 'Fund One' }), txn('c', { adopted_entry_id: 'e' }), txn('r', { transaction_type: 'round_info' })] })
    const r = await backfillDerivedEntries(m.admin, 'f', 'Fund I', 'u')
    expect(h.derive.mock.calls.map(c => c[3].id)).toEqual(['a', 'b'])
    expect(r).toMatchObject({ toDerive: 2, posted: 2 })
  })
  it('posts derived drafts left waiting, then links their bank rows', async () => {
    const m = seed({ investment_transactions: [txn('a')], journal_entries: [entry('d', { status: 'draft', source_ref: 'txn:a' })] })
    const r = await backfillDerivedEntries(m.admin, 'f', 'Fund I', 'u')
    expect(h.post).toHaveBeenCalledWith(m.admin, 'f', 'Fund I', 'u', 'd')
    expect(h.link).toHaveBeenCalledWith(m.admin, 'f', 'd')
    expect(r).toMatchObject({ toPost: 1, posted: 1, linked: 1, toDerive: 0, alreadyDerived: 1 })
  })
  it('a dry run counts and writes nothing', async () => {
    const m = seed({ investment_transactions: [txn('a')], journal_entries: [entry('qb')], journal_postings: [line('qb', 'a1100', 100)] })
    expect(await backfillDerivedEntries(m.admin, 'f', 'Fund I', 'u', { dryRun: true })).toMatchObject({ toAdopt: 1, toDerive: 1, adopted: 0, posted: 0 })
    expect(h.adopt).not.toHaveBeenCalled()
    expect(h.derive).not.toHaveBeenCalled()
  })
  it('running twice books nothing twice', async () => {
    const m = seed({ investment_transactions: [txn('a')] })
    h.derive.mockImplementation(async (_a: any, _f: string, _u: any, t: any) => {
      m.tables.journal_entries.push(entry(`e-${t.id}`, { source_ref: `txn:${t.id}` }))
      return { drafted: true, posted: true, entryId: `e-${t.id}` }
    })
    await backfillDerivedEntries(m.admin, 'f', 'Fund I', 'u')
    expect(await backfillDerivedEntries(m.admin, 'f', 'Fund I', 'u')).toMatchObject({ toDerive: 0, alreadyDerived: 1 })
    expect(h.derive).toHaveBeenCalledTimes(1)
  })
})

describe('countUnderived', () => {
  it('counts what the backfill would derive', async () => {
    const m = seed({ investment_transactions: [txn('a'), txn('b'), txn('c', { adopted_entry_id: 'e' })], journal_entries: [entry('d', { source_ref: 'txn:b' })] })
    expect(await countUnderived(m.admin, 'f', 'v', ['Fund I'])).toBe(1)
  })
})
