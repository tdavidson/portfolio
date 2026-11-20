// Investor groupings and alternate names in the assistant's LP tools. Every name is invented.
import { describe, it, expect, vi } from 'vitest'

vi.mock('@/lib/access/entity-scope', () => ({
  entityScopeFor: async (_a: any, access: any) => ({ access, vehicleNames: null, writableNames: null, companyIds: null }),
}))
vi.mock('@/lib/access/lp-scope', async orig => ({
  ...(await orig<typeof import('@/lib/access/lp-scope')>()),
  visibleLpEntityIds: async () => null,
}))

import { LP_HANDLERS, cardGroupsOf, loadIdentities, resolveLp } from './lp-tools'

// Northwind rolls up under Acme; Acme is also known as Jane Doe.
const investors = [
  { id: 'i1', name: 'Acme', parent_id: null, alternate_name: 'Jane Doe' },
  { id: 'i2', name: 'Northwind', parent_id: 'i1', alternate_name: null },
  { id: 'i3', name: 'Birch Family', parent_id: null, alternate_name: null },
]
const entities = [
  { id: 'e1', entity_name: 'Acme Trust', investor_id: 'i1', lp_investors: { id: 'i1', name: 'Acme' } },
  { id: 'e2', entity_name: 'Northwind LLC', investor_id: 'i2', lp_investors: { id: 'i2', name: 'Northwind' } },
  { id: 'e3', entity_name: 'Birch Trust', investor_id: 'i3', lp_investors: { id: 'i3', name: 'Birch Family' } },
]
const admin = {
  from: (t: string) => {
    const data: any[] = t === 'lp_entities' ? entities : t === 'lp_investors' ? investors : []
    let rows = data
    const chain: any = {
      select: () => chain, eq: () => chain, in: () => chain, order: () => chain,
      range: (a: number, b: number) => { rows = data.slice(a, b + 1); return chain },
      then: (res: any) => res({ data: rows, error: null }),
    }
    return chain
  },
} as any
const ctx = { admin, fundId: 'f1', portfolioGroup: '', userId: 'u1', access: { fundId: 'f1', vehicles: { all: true, ids: [] } } } as any

describe('LP tools: investor groupings', () => {
  it('knows each entity\'s group and the investor\'s alternate name', async () => {
    const ids = await loadIdentities(admin, 'f1', null)
    expect(ids.get('e2')).toMatchObject({ investorName: 'Northwind', groupId: 'i1', groupName: 'Acme' })
    expect(ids.get('e1')).toMatchObject({ alternateName: 'Jane Doe', groupId: 'i1' })
  })

  it('finds an LP by its alternate name, and a group by its name', async () => {
    const ids = await loadIdentities(admin, 'f1', null)
    expect(resolveLp(ids, 'jane doe').map(i => i.entityId)).toEqual(['e1'])
    expect(resolveLp(ids, 'Acme').map(i => i.entityId).sort()).toEqual(['e1', 'e2'])
  })

  it('gives one report card per group, under the group\'s name', async () => {
    const ids = await loadIdentities(admin, 'f1', null)
    expect([...cardGroupsOf(resolveLp(ids, 'Northwind'))]).toEqual([['i1', 'Acme']])
    expect([...cardGroupsOf([...ids.values()])].sort()).toEqual([['i1', 'Acme'], ['i3', 'Birch Family']])
  })

  it('lp_list_investors lists a grouped investor under its parent', async () => {
    const out = await LP_HANDLERS.lp_list_investors(ctx, {}) as any
    expect(out.investors).toEqual([
      { investor: 'Acme', also_known_as: ['Jane Doe'], grouped_investors: ['Northwind'], entities: ['Acme Trust', 'Northwind LLC'] },
      { investor: 'Birch Family', entities: ['Birch Trust'] },
    ])
  })
})
