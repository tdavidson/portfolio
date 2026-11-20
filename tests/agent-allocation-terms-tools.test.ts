import { beforeEach, describe, expect, it } from 'vitest'
import type { AccessContext } from '@/lib/access/effective'
import { DEFAULT_FEATURE_VISIBILITY, type FeatureVisibilityMap } from '@/lib/types/features'
import { memoryAdmin } from './helpers/memory-admin'
import { getTool } from '@/lib/accounting/agent-tools'
import { shouldStage } from '@/lib/agent/dispatch'

/** allocation_terms and set_allocation_terms: an associate's members' carry points. */

const access: AccessContext = {
  fundId: 'fund-1', userId: 'me', vehicles: { all: true, ids: [] }, role: 'admin',
  features: Object.fromEntries(Object.keys(DEFAULT_FEATURE_VISIBILITY).map(k => [k, 'everyone'])) as FeatureVisibilityMap,
  grants: {}, defaults: {},
}
let store: ReturnType<typeof memoryAdmin>
const run = (name: string, input: Record<string, unknown>) =>
  getTool(name)!.handler({ admin: store.admin, fundId: 'fund-1', portfolioGroup: 'Example Associates', userId: 'me', access }, input)

beforeEach(() => {
  store = memoryAdmin({
    fund_vehicles: [{ id: 'assoc', fund_id: 'fund-1', name: 'Example Associates', kind: 'associate', aliases: null, active: true }],
    lp_entities: [
      { id: 'm1', fund_id: 'fund-1', entity_name: 'Jane Doe' },
      { id: 'm2', fund_id: 'fund-1', entity_name: 'John Roe' },
    ],
    lp_investments: [
      { id: 'i1', fund_id: 'fund-1', entity_id: 'm1', portfolio_group: 'Example Associates', commitment: 100_000 },
      { id: 'i2', fund_id: 'fund-1', entity_id: 'm2', portfolio_group: 'Example Associates', commitment: 0 },
    ],
    partner_allocation_terms: [],
    commitment_events: [],
    vehicle_accounting_settings: [],
  })
})

describe('set_allocation_terms', () => {
  it('sets carry points by partner name, then lists them', async () => {
    const out: any = await run('set_allocation_terms', {
      category: 'carried_interest',
      terms: [{ partner: 'Jane Doe', weight: 60 }, { partner: 'john roe', weight: 40 }],
    })
    expect(out.terms).toEqual([
      { partner: 'Jane Doe', participates: true, weight: 60, rate: null },
      { partner: 'John Roe', participates: true, weight: 40, rate: null },
    ])
    expect(store.tables.partner_allocation_terms).toMatchObject([
      { vehicle_id: 'assoc', lp_entity_id: 'm1', category: 'carried_interest', participates: true, weight_override: 60 },
      { vehicle_id: 'assoc', lp_entity_id: 'm2', category: 'carried_interest', participates: true, weight_override: 40 },
    ])

    const listed: any = await run('allocation_terms', { category: 'carried_interest' })
    expect(listed.partners.find((p: any) => p.id === 'm2').terms).toEqual([
      { category: 'carried_interest', participates: true, weight: 40, rate: null },
    ])
  })

  it('changes nothing when any partner is unknown', async () => {
    await expect(run('set_allocation_terms', {
      category: 'carried_interest',
      terms: [{ partner: 'Jane Doe', weight: 60 }, { partner: 'Someone Else', weight: 40 }],
    })).rejects.toThrow(/Someone Else.*Nothing was changed/)
    expect(store.tables.partner_allocation_terms).toHaveLength(0)
  })

  it('needs a category with terms', async () => {
    await expect(run('set_allocation_terms', { terms: [{ partner: 'Jane Doe', weight: 1 }] })).rejects.toThrow(/category/)
  })

  it('is staged from the assistant', () => {
    expect(shouldStage(getTool('set_allocation_terms')!, { category: 'carried_interest', terms: [] }, { keyId: 'oauth:assistant' })).toBe(true)
  })
})
