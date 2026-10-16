import { describe, expect, it, vi } from 'vitest'
import { memoryAdmin } from '@/tests/helpers/memory-admin'
import { createTransactionLoader } from './transactions'

const txn = (id: string, company_id: string, fund_id = 'fund-1') => ({
  id, company_id, fund_id, transaction_date: '2026-01-01', transaction_type: 'investment', amount: 10,
})

describe('request-local portfolio histories', () => {
  it('shares overlapping and empty-company reads across concurrent consumers, without widening the fund', async () => {
    const { admin } = memoryAdmin({ investment_transactions: [txn('a', 'c1'), txn('b', 'c2'), txn('hidden', 'c1', 'other-fund')] })
    const from = vi.spyOn(admin, 'from')
    const load = createTransactionLoader(admin, 'fund-1')
    const [dashboard, picker] = await Promise.all([load(['c1', 'c2', 'empty']), load(['c2', 'empty'])])
    expect(dashboard.map(t => t.id)).toEqual(['a', 'b'])
    expect(picker.map(t => t.id)).toEqual(['b'])
    expect(await load(['empty', 'c1', 'c1'])).toEqual([expect.objectContaining({ id: 'a' })])
    expect(from).toHaveBeenCalledTimes(1)
  })

  it('reads beyond the API row cap without dropping or duplicating transactions', async () => {
    const rows = Array.from({ length: 1201 }, (_, i) => txn(String(i).padStart(5, '0'), 'c1'))
    const { admin } = memoryAdmin({ investment_transactions: rows }, { maxRows: 1000 })
    const from = vi.spyOn(admin, 'from')
    const result = await createTransactionLoader(admin, 'fund-1')(['c1'])
    expect(result).toEqual(rows)
    expect(from).toHaveBeenCalledTimes(3)
  })

  it('does not cache across requests, and propagates failures instead of calculating from partial rows', async () => {
    const m = memoryAdmin({ investment_transactions: [txn('a', 'c1')] })
    expect(await createTransactionLoader(m.admin, 'fund-1')(['c1'])).toHaveLength(1)
    m.failNext('investment_transactions', 'select', 'private detail')
    await expect(createTransactionLoader(m.admin, 'fund-1')(['c1'])).rejects.toThrow(/^Could not load portfolio investments$/)
  })

  it('makes no query for an empty company selection', async () => {
    const { admin } = memoryAdmin({})
    const from = vi.spyOn(admin, 'from')
    expect(await createTransactionLoader(admin, 'fund-1')([])).toEqual([])
    expect(from).not.toHaveBeenCalled()
  })
})
