import { describe, it, expect, vi, beforeEach } from 'vitest'
import { memoryAdmin, type Row } from '@/tests/helpers/memory-admin'
import type { Account } from './types'
import type { SourcedPosting } from './load'

// Partner allocation must happen exactly once: on posting, or by the close's catch-up — never
// both, and never for an entry that was left unallocated on purpose.

vi.mock('./vehicle-id', () => ({ vehicleIdByName: async () => 'v', vehicleNameById: async () => 'Fund I' }))
vi.mock('./vehicle-domain', () => ({ vehicleKindByName: async () => 'fund' }))

const accounts: Account[] = [
  { id: 'cash', fundId: 'f', code: '1000', name: 'Cash', type: 'asset', subtype: 'cash' },
  { id: 'capA', fundId: 'f', code: '3100-a', name: 'Capital — A', type: 'equity', subtype: 'lp_capital', lpEntityId: 'a' },
  { id: 'capB', fundId: 'f', code: '3100-b', name: 'Capital — B', type: 'equity', subtype: 'lp_capital', lpEntityId: 'b' },
  { id: 'bridge', fundId: 'f', code: '3200', name: 'Undistributed earnings', type: 'equity', subtype: 'undistributed_earnings' },
  { id: 'interest', fundId: 'f', code: '4100', name: 'Interest income', type: 'income', subtype: 'interest_income' },
  { id: 'exp', fundId: 'f', code: '5100', name: 'Partnership expenses', type: 'expense', subtype: 'partnership_expense' },
]

// The ledger the mocked loader serves; each test sets it.
let sourced: SourcedPosting[] = []

vi.mock('./load', async importOriginal => ({
  ...(await importOriginal<typeof import('./load')>()),
  loadPostedLedger: async () => ({ accounts, postings: sourced, capitalPostings: [], sourcedPostings: sourced }),
  loadOwnership: async () => [{ lpEntityId: 'a', commitment: 600 }, { lpEntityId: 'b', commitment: 400 }],
  loadEntityNames: async () => new Map([['a', 'A'], ['b', 'B']]),
}))
vi.mock('./terms', async importOriginal => ({
  ...(await importOriginal<typeof import('./terms')>()),
  loadAllocationBasis: async () => 'commitment',
  loadPartnerTerms: async () => [],
  loadCommitmentEvents: async () => [{ lpEntityId: 'a' }],
  loadResolvedCommitments: async () => new Map([['a', 600], ['b', 400]]),
}))
// Persisting is not under test: record what would be posted.
vi.mock('./persist', () => ({
  accountIdByCode: async () => new Map(accounts.map(a => [a.code, a.id])),
  ensureCapitalAccounts: async () => new Map([['a', 'capA'], ['b', 'capB']]),
  persistEntry: vi.fn(async (admin: any, fundId: string, _g: string, _u: string, entry: any) => {
    // A write with its own id, so no read-back is needed (books.test.ts treats a `.select(` near
    // `.from('journal_entries')` as a read that must filter on book).
    const id = `posted-${entry.sourceRef ?? Math.random().toString(36).slice(2)}`
    await admin.from('journal_entries').insert({
      id, fund_id: fundId, vehicle_id: 'v', status: 'posted', book: 'actual', entry_date: entry.entryDate, source_ref: entry.sourceRef,
    })
    return { entryId: id }
  }),
}))

import { allocatePostedEntry, carriesOwnAllocation, postExistingEntryWithAllocation, setGeneratedAllocationStatus } from './continuous-allocation'
import { previewClose } from './close'

const accountById = new Map(accounts.map(a => [a.id, a]))
const line = (entryId: string, accountId: string, amount: number, sourceType = 'manual', lpEntityId: string | null = null): SourcedPosting =>
  ({ entryId, accountId, amount, currency: 'USD', lpEntityId, sourceType, entryDate: '2026-03-10', memo: null })
/** An ordinary interest receipt: Dr cash / Cr 4100, P&L only. */
const interestEntry = (id: string, amount = 100, sourceType = 'manual') =>
  [line(id, 'cash', amount, sourceType), line(id, 'interest', -amount, sourceType)]
/** The same receipt in ACCOUNTING.md's compound form: it posts its own capital side. */
const compoundInterest = (id: string) => [
  line(id, 'cash', 24_350), line(id, 'interest', -24_350),
  line(id, 'bridge', 24_350), line(id, 'capA', -14_610, 'manual', 'a'), line(id, 'capB', -9_740, 'manual', 'b'),
]
const entryOf = (lines: SourcedPosting[]) => ({
  fundId: 'f', entryDate: '2026-03-10', memo: 'Interest', sourceType: lines[0].sourceType,
  postings: lines.map(l => ({ accountId: l.accountId, amount: l.amount, currency: 'USD', lpEntityId: l.lpEntityId })),
})

beforeEach(() => { sourced = [] })

describe('carriesOwnAllocation', () => {
  it('recognises the compound form (3200 and partner capital lines)', () => {
    expect(carriesOwnAllocation(compoundInterest('e'), accountById)).toBe(true)
  })
  it('recognises capital lines that carry exactly the P&L, without 3200', () => {
    expect(carriesOwnAllocation([line('e', 'exp', 1000), line('e', 'capA', 600), line('e', 'capB', 400), line('e', 'cash', -2000), line('e', 'cash', 1000)], accountById)).toBe(true)
  })
  it('a partner paying an expense directly is a contribution, not an allocation', () => {
    expect(carriesOwnAllocation([line('e', 'exp', 1000), line('e', 'capA', -1000)], accountById)).toBe(false)
  })
  it('plain P&L, and a capital line with no P&L, are not self-allocated', () => {
    expect(carriesOwnAllocation(interestEntry('e'), accountById)).toBe(false)
    expect(carriesOwnAllocation([line('e', 'cash', 100), line('e', 'capA', -100)], accountById)).toBe(false)
  })
})

describe('allocatePostedEntry', () => {
  it('allocates an ordinary entry once, and a second call reuses the same allocation', async () => {
    const m = memoryAdmin({ journal_entries: [{ id: 'e1', fund_id: 'f', vehicle_id: 'v', status: 'posted' }] })
    const first = await allocatePostedEntry(m.admin as any, 'f', 'Fund I', 'u', 'e1', entryOf(interestEntry('e1')))
    expect('allocationEntryIds' in first && first.allocationEntryIds).toHaveLength(1)
    expect(m.tables.journal_entry_allocations.map(r => [r.lp_entity_id, r.posted_amount])).toEqual([['a', 60], ['b', 40]])
    const second = await allocatePostedEntry(m.admin as any, 'f', 'Fund I', 'u', 'e1', entryOf(interestEntry('e1')))
    expect(second).toEqual(first)
    expect(m.tables.journal_entry_allocations).toHaveLength(2)
    expect(m.tables.journal_entry_allocation_skips ?? []).toEqual([])
  })

  it('does not allocate a compound entry that already posts its own allocation, and records why', async () => {
    const m = memoryAdmin({ journal_entries: [{ id: 'e1', fund_id: 'f', vehicle_id: 'v', status: 'posted' }] })
    const r = await allocatePostedEntry(m.admin as any, 'f', 'Fund I', 'u', 'e1', entryOf(compoundInterest('e1')))
    expect(r).toEqual({ allocationEntryIds: [] })
    expect(m.tables.journal_entry_allocations ?? []).toEqual([])
    expect(m.tables.journal_entry_allocation_skips).toEqual([expect.objectContaining({ source_entry_id: 'e1', reason: 'self_allocated' })])
  })

  it('reads the whole residual history past the 1000-row cap', async () => {
    // 1,500 earlier allocations of income to A, each leaving +0.001 of rounding: 1.50 in all.
    const history: Row[] = Array.from({ length: 1500 }, (_, i) => ({
      id: `h${String(i).padStart(5, '0')}`, fund_id: 'f', vehicle_id: 'v', source_entry_id: `old${i}`, allocation_entry_id: 'alloc-old',
      source_type: 'income', lp_entity_id: 'a', exact_amount: 1.001, posted_amount: 1,
      journal_entries: { status: 'posted' },
    }))
    const m = memoryAdmin({ journal_entries: [{ id: 'e1', fund_id: 'f', vehicle_id: 'v', status: 'posted' }], journal_entry_allocations: history }, { maxRows: 1000 })
    await allocatePostedEntry(m.admin as any, 'f', 'Fund I', 'u', 'e1', entryOf(interestEntry('e1', 100)))
    const fresh = m.tables.journal_entry_allocations.filter(r => r.source_entry_id === 'e1')
    // A's carried 1.50 (less its own 60% share of the drift) is paid back: 60 + 1.50 − 0.90.
    // A read truncated at 1,000 rows carries 1.00 and gives A 60.40.
    expect(fresh.map(r => [r.lp_entity_id, r.posted_amount])).toEqual([['a', 60.6], ['b', 39.4]])
  })
})

describe('postExistingEntryWithAllocation with allocate: false', () => {
  it('records the decision, so the close does not allocate the entry later', async () => {
    const m = memoryAdmin({
      journal_entries: [{ id: 'imp', fund_id: 'f', vehicle_id: 'v', book: 'actual', status: 'draft', entry_date: '2026-03-10', memo: 'Carta', source_type: 'carta', source_ref: 'carta:1' }],
      journal_postings: interestEntry('imp', 500, 'carta').map((l, n) => ({ id: `p${n}`, fund_id: 'f', vehicle_id: 'v', book: 'actual', journal_entry_id: 'imp', account_id: l.accountId, amount: l.amount, currency: 'USD', lp_entity_id: null })),
    })
    expect(await postExistingEntryWithAllocation(m.admin as any, 'f', 'Fund I', 'u', 'imp', { allocate: false })).toEqual({ allocationEntryIds: [] })
    expect(m.tables.journal_entry_allocation_skips).toEqual([expect.objectContaining({ source_entry_id: 'imp', reason: 'allocation_off' })])

    sourced = interestEntry('imp', 500, 'carta')
    const p = await previewClose(m.admin as any, 'f', 'Fund I', '2026-03-01', '2026-03-31')
    if ('error' in p) throw new Error(p.error)
    expect(p.categories).toEqual([])
    expect(p.warnings).toContainEqual(expect.stringMatching(/1 entry in this period \(net income 500\.00\) was posted with partner allocation turned off/))
  })
})

describe('setGeneratedAllocationStatus', () => {
  it('unposting clears the skip, so the next post decides again', async () => {
    const m = memoryAdmin({ journal_entry_allocation_skips: [{ fund_id: 'f', vehicle_id: 'v', source_entry_id: 'imp', reason: 'allocation_off' }] })
    expect(await setGeneratedAllocationStatus(m.admin as any, 'f', 'imp', 'draft')).toEqual({})
    expect(m.tables.journal_entry_allocation_skips).toEqual([])
  })
})

describe('previewClose catch-up', () => {
  it('sees every allocated entry past the 1000-row cap and allocates only the one that is not', async () => {
    // 1,200 interest entries allocated on posting, one never allocated.
    sourced = []
    const allocations: Row[] = []
    for (let i = 0; i < 1200; i++) {
      const id = `e${String(i).padStart(5, '0')}`
      sourced.push(...interestEntry(id, 10))
      allocations.push({ id: `a${String(i).padStart(5, '0')}`, fund_id: 'f', vehicle_id: 'v', source_entry_id: id, allocation_entry_id: `x${i}` })
    }
    sourced.push(...interestEntry('legacy', 100))
    const m = memoryAdmin({ journal_entry_allocations: allocations }, { maxRows: 1000 })
    const p = await previewClose(m.admin as any, 'f', 'Fund I', '2026-03-01', '2026-03-31')
    if ('error' in p) throw new Error(p.error)
    expect(p.netIncome).toBe(100)
    expect(p.allocatedOnPosting).toEqual({ entries: 1200, netIncome: 12_000 })
  })

  it('leaves a self-allocated compound entry alone, even with no skip recorded (posted before this check)', async () => {
    sourced = [...compoundInterest('compound'), ...interestEntry('plain', 100)]
    const m = memoryAdmin({})
    const p = await previewClose(m.admin as any, 'f', 'Fund I', '2026-03-01', '2026-03-31')
    if ('error' in p) throw new Error(p.error)
    expect(p.netIncome).toBe(100)
    expect(p.allocatedOnPosting.entries).toBe(1)
  })

  it('reports an import with no allocation and no record instead of allocating it', async () => {
    sourced = [...interestEntry('qb', 250, 'quickbooks'), ...interestEntry('manual', 100)]
    const m = memoryAdmin({})
    const p = await previewClose(m.admin as any, 'f', 'Fund I', '2026-03-01', '2026-03-31')
    if ('error' in p) throw new Error(p.error)
    expect(p.netIncome).toBe(100)
    expect(p.warnings).toContainEqual(expect.stringMatching(/1 imported \(QuickBooks or Carta\) entry in this period \(net income 250\.00\) has no partner allocation/))
  })

  it('still catches up an ordinary entry that was never allocated', async () => {
    sourced = interestEntry('manual', 100)
    const p = await previewClose(memoryAdmin({}).admin as any, 'f', 'Fund I', '2026-03-01', '2026-03-31')
    if ('error' in p) throw new Error(p.error)
    expect(p.categories).toHaveLength(1)
    expect(p.categories[0].lines.map(l => [l.lpEntityId, l.amount])).toEqual([['a', 60], ['b', 40]])
  })

  it('refuses rather than reading a failed allocation read as "nothing allocated"', async () => {
    sourced = interestEntry('e1', 100)
    const m = memoryAdmin({})
    m.failNext('journal_entry_allocations', 'select', 'boom')
    const p = await previewClose(m.admin as any, 'f', 'Fund I', '2026-03-01', '2026-03-31')
    expect(p).toEqual({ error: expect.stringMatching(/already allocated.*boom/) })
  })
})
