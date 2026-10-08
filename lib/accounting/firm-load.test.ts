import { describe, it, expect, vi } from 'vitest'

vi.mock('./load', () => ({
  listVehiclesWithId: async () => [{ id: 'v1', name: 'Fund I', kind: 'fund' }, { id: 'v2', name: 'Fund II', kind: 'fund' }, { id: 'v3', name: 'Fund III', kind: 'fund' }],
  listMancoVehicles: async () => [],
  loadPostedLedger: async () => ({ accounts: [], postings: [], capitalPostings: [] }),
}))
vi.mock('./investment-backfill', () => ({
  vehicleNames: async (_a: any, _f: string, _v: string, group: string) => [group],
  countUnderived: vi.fn(async (_a: any, _f: string, vehicleId: string) => {
    if (vehicleId === 'v3') throw new Error('db down')
    return vehicleId === 'v2' ? 4 : 0
  }),
}))
import { loadFirmOverview } from './firm-load'

const admin = { from: () => { const q: any = { select: () => q, eq: () => q, in: () => q, order: () => q, limit: () => q, maybeSingle: async () => ({ data: { name: 'x', aliases: [] } }), then: (r: any) => r({ data: [], count: 0, error: null }) }; return q } } as any

describe('loadFirmOverview', () => {
  it('counts each vehicle\'s transactions that are not on the ledger; one failing count leaves that row at 0', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const o = await loadFirmOverview(admin, 'f', { includeManco: false, includeBacklog: true })
    expect(o.vehicles.map(v => [v.name, v.underivedTransactions])).toEqual([['Fund I', 0], ['Fund II', 4], ['Fund III', 0]])
    expect(spy).toHaveBeenCalled()
    spy.mockRestore()
  })

  it('does not count the backlog unless asked', async () => {
    const o = await loadFirmOverview(admin, 'f', { includeManco: false })
    expect(o.vehicles.map(v => v.underivedTransactions)).toEqual([0, 0, 0])
  })
})
