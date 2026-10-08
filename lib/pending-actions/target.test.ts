import { describe, it, expect, vi } from 'vitest'

vi.mock('@/lib/accounting/vehicle-resolver', () => ({
  resolveVehicle: vi.fn(async (_a: any, _f: string, requested?: string) => {
    if (requested && requested !== 'Fund I') throw new Error(`Unknown vehicle "${requested}"`)
    return 'Fund I'
  }),
}))
vi.mock('@/lib/accounting/vehicle-id', () => ({ vehicleIdByName: vi.fn(async () => 'v1') }))

import { stagedTarget } from './target'

const deps = { admin: {} as any, fundId: 'f1', userId: 'u1', access: { vehicles: { all: false, ids: ['v1'] } } as any }

describe('stagedTarget — the entity a staged action acts on, pinned once', () => {
  it('a vehicle-bound action with none named is pinned to the stager\'s entity', async () => {
    expect(await stagedTarget(deps, { entity: 'required' }, { amount: 1 })).toEqual({ input: { amount: 1, vehicle: 'Fund I' }, vehicleId: 'v1' })
  })
  it('refuses an entity the stager cannot see', async () => {
    await expect(stagedTarget(deps, { entity: 'required' }, { vehicle: 'Fund II' })).rejects.toThrow(/Unknown vehicle/)
  })
  it('an optional entity left out stays out (a company-wide row); none is never resolved', async () => {
    expect(await stagedTarget(deps, { entity: 'optional' }, { company: 'Acme' })).toEqual({ input: { company: 'Acme' }, vehicleId: null })
    expect(await stagedTarget(deps, { entity: 'none' }, { vehicle: 'Fund II' })).toEqual({ input: { vehicle: 'Fund II' }, vehicleId: null })
  })
})
