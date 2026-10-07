import { describe, it, expect, vi } from 'vitest'
import { resolveVehicle } from './vehicle-resolver'

vi.mock('./load', () => ({
  listVehicles: vi.fn(async () => ['Fund I', 'Fund II']),
  listMancoVehicles: vi.fn(async () => []),
}))

// fund_vehicles, for turning the caller's entity ids into names.
const admin = {
  from: () => {
    const chain: any = {
      select: () => chain, eq: () => chain,
      in: (_k: string, ids: string[]) => { chain.ids = ids; return chain },
      then: (res: any) => res({ data: [{ id: 'v1', name: 'Fund I', aliases: [] }, { id: 'v2', name: 'Fund II', aliases: [] }]
        .filter(v => chain.ids.includes(v.id)), error: null }),
    }
    return chain
  },
} as any

const member = { vehicles: { all: false, ids: ['v1'] } }

describe('resolveVehicle — with the caller\'s access (agent tools, MCP, pending actions)', () => {
  it('resolves a named entity the caller can see', async () => {
    expect(await resolveVehicle(admin, 'f1', 'fund i', { access: member })).toBe('Fund I')
  })
  it('refuses a named entity they cannot see, as unknown — without listing the ones they cannot see', async () => {
    await expect(resolveVehicle(admin, 'f1', 'Fund II', { access: member })).rejects.toThrow(/Unknown vehicle "Fund II"\. This fund has: Fund I$/)
  })
  it('defaults to the one entity they can see', async () => {
    expect(await resolveVehicle(admin, 'f1', undefined, { access: member })).toBe('Fund I')
  })
  it('is unchanged for a caller who sees every entity', async () => {
    await expect(resolveVehicle(admin, 'f1', undefined, { access: { vehicles: { all: true, ids: [] } } })).rejects.toThrow(/several/)
  })
})
