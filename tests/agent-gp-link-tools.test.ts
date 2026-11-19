import { beforeEach, describe, expect, it } from 'vitest'
import type { AccessContext } from '@/lib/access/effective'
import { DEFAULT_FEATURE_VISIBILITY, type FeatureVisibilityMap } from '@/lib/types/features'
import { memoryAdmin } from './helpers/memory-admin'
import { getTool } from '@/lib/accounting/agent-tools'
import { shouldStage } from '@/lib/agent/dispatch'
import { adminOnlyToolLabel } from '@/lib/access/admin-only'
import { resolvePartner } from '@/lib/agent/gp-link-tools'

/** set_gp_link and gp_links: an associate made GP of a vehicle, as one of that vehicle's partners. */

const access: AccessContext = {
  fundId: 'fund-1', userId: 'me', vehicles: { all: true, ids: [] }, role: 'admin',
  features: Object.fromEntries(Object.keys(DEFAULT_FEATURE_VISIBILITY).map(k => [k, 'everyone'])) as FeatureVisibilityMap,
  grants: {}, defaults: {},
}
let store: ReturnType<typeof memoryAdmin>
const run = (name: string, input: Record<string, unknown>) =>
  getTool(name)!.handler({ admin: store.admin, fundId: 'fund-1', portfolioGroup: 'Example SPV', userId: 'me', access }, input)

beforeEach(() => {
  store = memoryAdmin({
    fund_vehicles: [
      { id: 'spv', fund_id: 'fund-1', name: 'Example SPV', kind: 'spv', aliases: null, active: true },
      { id: 'assoc', fund_id: 'fund-1', name: 'Example Associates', kind: 'associate', aliases: null, active: true },
      { id: 'other', fund_id: 'fund-2', name: 'Elsewhere GP', kind: 'gp', aliases: null, active: true },
    ],
    lp_entities: [
      { id: 'gp-ent', fund_id: 'fund-1', entity_name: 'Example GP LLC' },
      { id: 'lp-ent', fund_id: 'fund-1', entity_name: 'Jane Doe' },
      { id: 'foreign', fund_id: 'fund-2', entity_name: 'Someone Else' },
    ],
    lp_investments: [
      { id: 'i1', fund_id: 'fund-1', entity_id: 'gp-ent', portfolio_group: 'Example SPV', commitment: 0 },
      { id: 'i2', fund_id: 'fund-1', entity_id: 'lp-ent', portfolio_group: 'Example SPV', commitment: 100_000 },
    ],
    vehicle_gp_links: [],
  })
})

describe('set_gp_link', () => {
  it('links the associate as the named partner, then changes and removes it', async () => {
    await run('set_gp_link', { gp_vehicle: 'Example Associates', partner: 'Example GP LLC' })
    expect(store.tables.vehicle_gp_links).toMatchObject([{ gp_vehicle_id: 'assoc', served_vehicle_id: 'spv', lp_entity_id: 'gp-ent' }])

    // Changing the partner is the same upsert on (gp_vehicle_id, served_vehicle_id); the in-memory
    // store does not merge on conflict, so start from an empty table to read the second write.
    store.tables.vehicle_gp_links.length = 0
    await run('set_gp_link', { gp_vehicle: 'assoc', partner: 'lp-ent' })
    expect(store.tables.vehicle_gp_links).toMatchObject([{ gp_vehicle_id: 'assoc', lp_entity_id: 'lp-ent' }])

    const listed: any = await run('gp_links', {})
    expect(listed.links).toEqual([{ gpVehicle: 'Example Associates', gpVehicleId: 'assoc', partner: 'Jane Doe', partnerId: 'lp-ent' }])
    expect(listed.candidates.map((c: any) => c.id)).toEqual(['assoc'])

    expect(await run('set_gp_link', { gp_vehicle: 'Example Associates', remove: true })).toMatchObject({ removed: true })
    expect(store.tables.vehicle_gp_links).toHaveLength(0)
  })

  it('refuses a partner the vehicle does not have, and an entity from another fund', async () => {
    await expect(run('set_gp_link', { gp_vehicle: 'Example Associates', partner: 'Someone Else' })).rejects.toThrow(/add_partner/)
    await expect(run('set_gp_link', { gp_vehicle: 'other' })).rejects.toThrow(/No entity/)
    await expect(run('set_gp_link', { gp_vehicle: 'Example SPV' })).rejects.toThrow(/its own GP/)
    expect(store.tables.vehicle_gp_links).toHaveLength(0)
  })

  it('is staged from the assistant, and only removing is admin-only', () => {
    const tool = getTool('set_gp_link')!
    expect(shouldStage(tool, { gp_vehicle: 'x' }, { keyId: 'oauth:assistant' })).toBe(true)
    expect(adminOnlyToolLabel('set_gp_link', { gp_vehicle: 'x' })).toBeUndefined()
    expect(adminOnlyToolLabel('set_gp_link', { gp_vehicle: 'x', remove: true })).toBe('remove a GP link')
  })
})

describe('resolvePartner', () => {
  it('matches an id, or exactly one name ignoring case', () => {
    const partners = new Map([['a', 'Jane Doe'], ['b', 'John Roe'], ['c', 'john roe']])
    expect(resolvePartner(partners, 'a')).toBe('a')
    expect(resolvePartner(partners, ' jane doe ')).toBe('a')
    expect(resolvePartner(partners, 'John Roe')).toBeNull()
  })
})
