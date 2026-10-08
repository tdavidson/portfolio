import { describe, it, expect, vi } from 'vitest'

const m = vi.hoisted(() => ({ ops: [] as string[] }))

function chain(table: string) {
  let op = 'select'
  const c: any = {
    select: () => c, eq: () => c,
    update: () => { op = 'update'; return c },
    upsert: () => { m.ops.push(`upsert ${table}`); return Promise.resolve({ error: null }) },
    delete: () => { op = 'delete'; return c },
    maybeSingle: async () => ({ data: table === 'fund_vehicles' ? { id: 'x', name: table, aliases: [] } : null, error: null }),
    single: async () => ({ data: { id: 'into', name: 'Fund I', aliases: ['Fund 1'] }, error: null }),
    then: (res: any) => {
      if (op !== 'select') m.ops.push(`${op} ${table}`)
      return res({ data: table === 'fund_member_vehicles' && op === 'select' ? [{ user_id: 'u2' }] : [], error: null })
    },
  }
  return c
}

vi.mock('@/lib/supabase/server', () => ({ createClient: async () => ({ auth: { getUser: async () => ({ data: { user: { id: 'u1' } } }) } }) }))
vi.mock('@/lib/supabase/admin', () => ({ createAdminClient: () => ({ from: (t: string) => chain(t) }) }))
vi.mock('@/lib/api-helpers', () => ({
  assertWriteAccess: async () => ({ fundId: 'f1', userId: 'u1', role: 'admin' }),
  assertReadAccess: async () => ({ fundId: 'f1', userId: 'u1', role: 'admin' }),
}))
vi.mock('@/lib/access/effective', () => ({ loadAccessContext: async () => ({ fundId: 'f1', vehicles: { all: true, ids: [] } }) }))
vi.mock('@/lib/vehicles', () => ({ retagPortfolioGroup: async () => { m.ops.push('retag') } }))

import { PATCH } from '@/app/api/vehicles/route'

describe('merging an entity', () => {
  it('moves everything that names the source by id, and its members\' grants, before deleting it', async () => {
    const res = await PATCH(new Request('http://x/api/vehicles', { method: 'PATCH', body: JSON.stringify({ id: 'from', mergeIntoId: 'into' }) }) as any)
    expect(res.status).toBe(200)
    const del = m.ops.indexOf('delete fund_vehicles')
    for (const step of ['update company_notes', 'update inbound_deals', 'update diligence_deals', 'update pending_actions', 'upsert fund_member_vehicles']) {
      expect(m.ops.indexOf(step), step).toBeGreaterThanOrEqual(0)
      expect(m.ops.indexOf(step), step).toBeLessThan(del)
    }
  })
})
