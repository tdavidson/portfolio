import { describe, it, expect, vi } from 'vitest'
import { postExistingEntryWithAllocation } from './continuous-allocation'

vi.mock('./vehicle-id', () => ({ vehicleIdByName: vi.fn(async () => 'veh-1') }))

/**
 * Two requests can both read a draft and both post it — two posts of the same draft, from a
 * double-click or two tabs — and each runs the partner allocation, doubling it. The draft → posted
 * transition must be a compare-and-set: the loser finds no draft to flip and stops.
 */
describe('postExistingEntryWithAllocation — concurrent post', () => {
  it('refuses when the entry stopped being a draft between the read and the update', async () => {
    const updates: any[] = []
    const admin = {
      from: (table: string) => {
        let op = 'select'
        const chain: any = {
          select: () => chain, eq: () => chain, in: () => chain, like: () => chain, neq: () => chain, not: () => chain, is: () => chain, order: () => chain, range: () => chain, limit: () => chain,
          update: (v: any) => { op = 'update'; updates.push({ table, v }); return chain },
          maybeSingle: async () => ({ data: { entry_date: '2026-03-01', memo: null, source_type: 'investment', source_ref: 'txn:t1', status: 'draft' }, error: null }),
          // The update matches no row: someone else already posted it.
          then: (res: any) => res({ data: op === 'update' ? [] : [], error: null }),
        }
        return chain
      },
    } as any
    const r = await postExistingEntryWithAllocation(admin, 'f1', 'Fund I', 'u1', 'e1')
    expect(r).toEqual({ error: 'Only a draft entry can be posted' })
    expect(updates).toHaveLength(1) // no rollback-to-draft of someone else's post, no allocation
  })
})
