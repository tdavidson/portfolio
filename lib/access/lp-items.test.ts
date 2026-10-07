import { describe, it, expect } from 'vitest'
import { visibleLpItems } from './lp-scope'

const tables: Record<string, any[]> = {
  lp_documents: [
    { id: 'dF', scope: 'fund', vehicle: null },
    { id: 'd1', scope: 'investor', vehicle: 'Fund I' },
    { id: 'd2', scope: 'investor', vehicle: 'Fund II' },
    { id: 'dX', scope: 'investor', vehicle: null },
  ],
  lp_document_shares: [
    { document_id: 'd1', lp_investor_id: 'ann' }, { document_id: 'd2', lp_investor_id: 'ann' }, { document_id: 'dX', lp_investor_id: 'bob' },
  ],
  lp_letters: [{ id: 'l1', portfolio_group: 'Fund I' }, { id: 'l2', portfolio_group: 'Fund II' }],
}
const admin = {
  from: (t: string) => {
    const f: Array<(r: any) => boolean> = []
    const chain: any = {
      select: () => chain, eq: () => chain,
      in: (k: string, v: any[]) => { f.push(r => v.includes(r[k])); return chain },
      then: (res: any) => res({ data: (tables[t] ?? []).filter(r => f.every(x => x(r))), error: null }),
    }
    return chain
  },
} as any
const scoped = { scope: { vehicleNames: ['Fund I'] }, entityIds: ['e1'], investorIds: ['ann'] } as any
const unscoped = { scope: { vehicleNames: null }, entityIds: null, investorIds: null } as any

describe('visibleLpItems — documents and letters as the caller may see them', () => {
  it('a scoped member: fund-wide documents, their entity\'s documents shared with LPs they see, their entity\'s letters', async () => {
    const v = await visibleLpItems(admin, 'f1', scoped, { documents: ['dF', 'd1', 'd2', 'dX'], letters: ['l1', 'l2'] })
    expect([...v!.documents].sort()).toEqual(['d1', 'dF'])
    expect([...v!.letters]).toEqual(['l1'])
  })
  it('unscoped: null (everything)', async () => {
    expect(await visibleLpItems(admin, 'f1', unscoped, { documents: ['d2'], letters: ['l2'] })).toBeNull()
  })
})
