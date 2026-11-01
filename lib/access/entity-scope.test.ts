import { describe, it, expect } from 'vitest'
import { memoryAdmin } from '@/tests/helpers/memory-admin'
import { entityScopeFor } from './entity-scope'

const access = { fundId: 'f', vehicles: { all: false, ids: ['v1'] } } as any
const seed = () => memoryAdmin({
  fund_vehicles: [{ id: 'v1', fund_id: 'f', name: 'Fund I', aliases: ['Fund One'] }, { id: 'v2', fund_id: 'f', name: 'Fund II', aliases: null }],
  company_vehicles: [{ fund_id: 'f', company_id: 'k1', vehicle_id: 'v1' }, { fund_id: 'f', company_id: 'k2', vehicle_id: 'v2' }],
})

describe('entityScopeFor', () => {
  it("names the caller's entities, with their aliases, and their companies", async () => {
    expect(await entityScopeFor(seed().admin, access)).toEqual({ access, vehicleNames: ['Fund I', 'Fund One'], writableNames: ['Fund I', 'Fund One'], companyIds: ['k1'] })
  })

  it('leaves an entity capped at read or propose out of the names a write may use', async () => {
    const capped = { fundId: 'f', vehicles: { all: false, ids: ['v1', 'v2'], caps: { v2: 'read' } } } as any
    const scope = await entityScopeFor(seed().admin, capped)
    expect(scope.vehicleNames).toEqual(['Fund I', 'Fund II', 'Fund One'])
    expect(scope.writableNames).toEqual(['Fund I', 'Fund One'])
    const proposer = { fundId: 'f', vehicles: { all: false, ids: ['v1', 'v2'], caps: { v2: 'propose' } } } as any
    expect((await entityScopeFor(seed().admin, proposer)).writableNames).toEqual(['Fund I', 'Fund One'])
  })

  it('throws when the entities cannot be read, rather than scoping the caller to nothing', async () => {
    const m = seed()
    m.failNext('fund_vehicles', 'select', 'boom')
    await expect(entityScopeFor(m.admin, access)).rejects.toThrow('fund_vehicles read failed: boom')
  })

  it('throws when the entities\' companies cannot be read, rather than showing an empty portfolio', async () => {
    const m = seed()
    m.failNext('company_vehicles', 'select', 'boom')
    await expect(entityScopeFor(m.admin, access)).rejects.toThrow('company_vehicles read failed: boom')
  })
})
