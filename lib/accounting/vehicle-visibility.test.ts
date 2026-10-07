import { describe, it, expect, vi, beforeEach } from 'vitest'
import { assertVehicleVisible, visibleVehicleNames } from './vehicle-visibility'
import { resolveGroupOr400 } from './http-vehicle'
import { loadAccessContext } from '@/lib/access/effective'

// The registry: two funds and a legacy name with no row.
const VEHICLES = [
  { id: 'v1', fund_id: 'f1', name: 'Fund I', kind: 'fund', active: true, aliases: [] as string[] },
  { id: 'v2', fund_id: 'f1', name: 'Fund II', kind: 'fund', active: true, aliases: ['Fund 2'] },
]

vi.mock('@/lib/access/effective', async (orig) => ({
  ...(await orig<typeof import('@/lib/access/effective')>()),
  loadAccessContext: vi.fn(),
}))
vi.mock('./load', () => ({
  listVehicles: vi.fn(async () => VEHICLES.map(v => v.name)),
  listMancoVehicles: vi.fn(async () => []),
}))

function admin() {
  const from = (table: string) => {
    const f: Record<string, any> = {}
    const chain: any = {
      select: () => chain,
      eq: (k: string, v: any) => { f[k] = v; return chain },
      in: (k: string, v: any[]) => { f[`in:${k}`] = v; return chain },
      contains: (k: string, v: any[]) => { f[`contains:${k}`] = v; return chain },
      rows: () => (table === 'fund_vehicles' ? VEHICLES as Record<string, any>[] : []).filter(r => Object.entries(f).every(([k, v]) =>
        k.startsWith('in:') ? v.includes(r[k.slice(3)])
          : k.startsWith('contains:') ? v.every((x: string) => r[k.slice(9)].includes(x))
          : r[k] === v)),
      maybeSingle: async () => ({ data: chain.rows()[0] ?? null, error: null }),
      then: (res: any) => res({ data: chain.rows(), error: null }),
    }
    return chain
  }
  return { from } as any
}

const gate = { fundId: 'f1', userId: 'u1', role: 'member', need: 'read' as const }
const sees = (ids: string[] | 'all') => vi.mocked(loadAccessContext).mockResolvedValue({
  fundId: 'f1', userId: 'u1', role: ids === 'all' ? 'admin' : 'member', features: {} as any, grants: {}, defaults: {},
  vehicles: ids === 'all' ? { all: true, ids: [] } : { all: false, ids },
})

beforeEach(() => { vi.mocked(loadAccessContext).mockReset() })

describe('assertVehicleVisible', () => {
  it('lets a member reach a granted entity', async () => {
    sees(['v1'])
    expect(await assertVehicleVisible(admin(), gate, 'Fund I')).toBeNull()
  })

  it('refuses a member an entity they were not granted, with 403', async () => {
    sees(['v1'])
    const r = await assertVehicleVisible(admin(), gate, 'Fund II')
    expect(r?.status).toBe(403)
  })

  it('resolves an alias to its entity before deciding', async () => {
    sees(['v2'])
    expect(await assertVehicleVisible(admin(), gate, 'Fund 2')).toBeNull()
  })

  it('refuses a member a legacy name with no registry row — it cannot be granted', async () => {
    sees(['v1', 'v2'])
    expect((await assertVehicleVisible(admin(), gate, 'Old Fund'))?.status).toBe(403)
  })

  it('lets an admin reach anything, including a legacy name', async () => {
    sees('all')
    expect(await assertVehicleVisible(admin(), { ...gate, role: 'admin' }, 'Old Fund')).toBeNull()
  })
})

describe('visibleVehicleNames', () => {
  it('is null for a caller who sees everything', async () => {
    sees('all')
    expect(await visibleVehicleNames(admin(), gate)).toBeNull()
  })

  it('is the granted entities\' names otherwise', async () => {
    sees(['v2'])
    expect(await visibleVehicleNames(admin(), gate)).toEqual(['Fund II'])
  })
})

describe('resolveGroupOr400 — the one line every accounting route has', () => {
  it('refuses a named entity the member was not granted', async () => {
    sees(['v1'])
    const r = await resolveGroupOr400(admin(), gate, 'Fund II')
    expect((r as any).status).toBe(403)
  })

  it('defaults to the one entity a member sees, though the fund has several', async () => {
    sees(['v1'])
    expect(await resolveGroupOr400(admin(), gate, null)).toBe('Fund I')
  })

  it('tells a member with no entities so, rather than naming the ones they cannot see', async () => {
    sees([])
    const r = await resolveGroupOr400(admin(), gate, null) as any
    expect(r.status).toBe(403)
    expect(JSON.stringify(await r.json())).not.toMatch(/Fund I/)
  })

  it('still asks an admin to pick when the fund has several', async () => {
    sees('all')
    expect((await resolveGroupOr400(admin(), { ...gate, role: 'admin' }, null) as any).status).toBe(400)
  })
})
