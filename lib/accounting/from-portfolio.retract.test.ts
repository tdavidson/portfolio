import { describe, it, expect, vi } from 'vitest'
import { retractEntriesForTransaction } from './from-portfolio'
import { setGeneratedAllocationStatus } from './continuous-allocation'

vi.mock('./continuous-allocation', () => ({
  setGeneratedAllocationStatus: vi.fn(async () => ({})),
}))
vi.mock('./periods', () => ({
  closedPeriodRanges: vi.fn(async () => []),
  dateInAnyClosedPeriod: vi.fn(() => false),
}))

/** Records every write; answers the one select retract makes with `entries`. */
function fakeAdmin(entries: any[]) {
  const writes: { table: string; op: string; values?: any; filters: [string, any][] }[] = []
  const from = (table: string) => {
    const w: any = { table, op: 'select', filters: [] as [string, any][] }
    const chain: any = {
      select: () => chain,
      update: (values: any) => { w.op = 'update'; w.values = values; writes.push(w); return chain },
      delete: () => { w.op = 'delete'; writes.push(w); return chain },
      eq: (k: string, v: any) => { w.filters.push([k, v]); return chain },
      neq: () => chain,
      // The adopted-entry self lookup: any of the rows will do — none carries adopted_entry_id.
      maybeSingle: async () => ({ data: entries[0] ?? null, error: null }),
      then: (res: any) => res({ data: w.op === 'select' ? entries : null, error: null }),
    }
    return chain
  }
  return { admin: { from } as any, writes }
}

describe('retractEntriesForTransaction', () => {
  it('voids a posted entry rather than rewriting it', async () => {
    const { admin, writes } = fakeAdmin([{ id: 'e1', status: 'posted', entry_date: '2026-03-01', portfolio_group: 'Fund I' }])
    const r = await retractEntriesForTransaction(admin, 'f1', 't1')
    expect(r.retracted).toBe(1)
    expect(writes.find(w => w.table === 'journal_entries')).toMatchObject({ op: 'update', values: { status: 'void' } })
  })

  it('releases the bank row a voided entry was matched to, so the payment can be matched again', async () => {
    const { admin, writes } = fakeAdmin([{ id: 'e1', status: 'posted', entry_date: '2026-03-01', portfolio_group: 'Fund I' }])
    await retractEntriesForTransaction(admin, 'f1', 't1')
    const bank = writes.find(w => w.table === 'bank_transactions')
    expect(bank).toMatchObject({ op: 'update', values: { journal_entry_id: null, status: 'unmatched' } })
    expect(bank!.filters).toEqual(expect.arrayContaining([['fund_id', 'f1'], ['journal_entry_id', 'e1']]))
  })

  it('releases any bank row a draft holds before deleting it — a match that crashed between claim and post', async () => {
    const { admin, writes } = fakeAdmin([{ id: 'e1', status: 'draft', entry_date: '2026-03-01', portfolio_group: 'Fund I' }])
    await retractEntriesForTransaction(admin, 'f1', 't1')
    expect(writes.map(w => `${w.table}:${w.op}`)).toEqual(['bank_transactions:update', 'journal_entries:delete'])
  })
})

describe('retractEntriesForTransaction — partner allocations', () => {
  it('voids the allocation a posted entry generated, so partners are not credited twice on re-derive', async () => {
    vi.mocked(setGeneratedAllocationStatus).mockClear()
    const { admin } = fakeAdmin([{ id: 'e1', status: 'posted', entry_date: '2026-03-01', portfolio_group: 'Fund I' }])
    await retractEntriesForTransaction(admin, 'f1', 't1')
    expect(setGeneratedAllocationStatus).toHaveBeenCalledWith(admin, 'f1', 'e1', 'void')
  })

  it('refuses, and leaves the entry posted, when its allocation cannot be voided', async () => {
    vi.mocked(setGeneratedAllocationStatus).mockResolvedValueOnce({ error: 'boom' })
    const { admin, writes } = fakeAdmin([{ id: 'e1', status: 'posted', entry_date: '2026-03-01', portfolio_group: 'Fund I' }])
    const r = await retractEntriesForTransaction(admin, 'f1', 't1')
    expect(r.reason).toMatch(/boom/)
    expect(writes).toEqual([])
  })
})
