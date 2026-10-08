import { describe, it, expect, vi, beforeEach } from 'vitest'

const m = vi.hoisted(() => ({ updates: [] as any[], access: { vehicles: { all: false, ids: ['v1'] } } as any }))

function chain(table: string) {
  const c: any = {
    select: () => c, eq: () => c,
    update: (u: any) => { m.updates.push(u); return c },
    maybeSingle: async () => ({
      data: table === 'fund_members' ? { fund_id: 'f1', role: 'member' } : table === 'fund_vehicles' ? { id: 'v1' } : null,
      error: null,
    }),
    then: (res: any) => res({ error: null }),
  }
  return c
}
vi.mock('@/lib/supabase/server', () => ({ createClient: async () => ({ auth: { getUser: async () => ({ data: { user: { id: 'u1' } } }) } }) }))
vi.mock('@/lib/supabase/admin', () => ({ createAdminClient: () => ({ from: (t: string) => chain(t) }) }))
vi.mock('@/lib/access/entity-scope', () => ({ loadEntityScopeForUser: async () => ({ access: m.access, vehicleNames: ['Fund I'], companyIds: [] }) }))

import { PATCH } from '@/app/api/diligence/[id]/route'

const patch = (body: unknown) => PATCH(new Request('http://x', { method: 'PATCH', body: JSON.stringify(body) }) as any, { params: Promise.resolve({ id: 'd1' }) })

describe('PATCH /api/diligence/[id] — the record\'s entity', () => {
  beforeEach(() => { m.updates = [] })
  it('a member may move it to one of their entities', async () => {
    expect((await patch({ vehicle_id: 'v1' }))!.status).toBe(200)
    expect(m.updates).toEqual([{ vehicle_id: 'v1' }])
  })
  it('…not to another entity, and not to unassigned (which would hide it from them)', async () => {
    expect((await patch({ vehicle_id: 'v2' }))!.status).toBe(403)
    expect((await patch({ vehicle_id: null }))!.status).toBe(403)
    expect(m.updates).toEqual([])
  })
})
