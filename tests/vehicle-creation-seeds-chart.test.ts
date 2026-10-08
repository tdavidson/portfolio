import { describe, it, expect, vi } from 'vitest'
import { NextRequest } from 'next/server'
import { memoryAdmin } from '@/tests/helpers/memory-admin'

const s = vi.hoisted(() => ({ m: null as any, seeded: [] as string[], role: 'admin', fail: false }))
vi.mock('@/lib/supabase/server', () => ({ createClient: async () => ({ auth: { getUser: async () => ({ data: { user: { id: 'u' } } }) } }) }))
vi.mock('@/lib/supabase/admin', () => ({ createAdminClient: () => s.m.admin }))
vi.mock('@/lib/api-helpers', async (orig) => ({ ...(await orig<any>()), assertWriteAccess: async () => ({ fundId: 'f', userId: 'u', role: s.role }) }))
vi.mock('@/lib/access/effective', async (orig) => ({ ...(await orig<any>()), loadAccessContext: async () => ({}) }))
vi.mock('@/lib/access/scope', async (orig) => ({ ...(await orig<any>()), entityIdentityChangeDenial: () => null }))
vi.mock('@/lib/accounting/provision-accounts', () => ({ ensureVehicleAccounts: vi.fn(async (_a: any, _f: string, name: string) => { if (s.fail) throw new Error('boom'); s.seeded.push(name) }) }))
import { POST as createVehicle } from '@/app/api/vehicles/route'
import { POST as createManco } from '@/app/api/manco/vehicles/route'

const req = (body: object) => new NextRequest('http://x', { method: 'POST', body: JSON.stringify(body) })

describe('creating an entity seeds its chart', () => {
  it('a fund', async () => {
    s.m = memoryAdmin({ fund_vehicles: [] }); s.seeded = []
    expect((await createVehicle(req({ name: 'Fund IV', kind: 'fund' }))).status).toBe(200)
    expect(s.seeded).toEqual(['Fund IV'])
  })
  it('a management company', async () => {
    s.m = memoryAdmin({ fund_vehicles: [] }); s.seeded = []
    expect((await createManco(req({ name: 'Mgmt LLC' }))).status).toBe(200)
    expect(s.seeded).toEqual(['Mgmt LLC'])
  })
  it('a seed failure leaves the entity created and the creator granted', async () => {
    s.m = memoryAdmin({ fund_vehicles: [], fund_member_vehicles: [] }); s.seeded = []; s.role = 'member'; s.fail = true
    const err = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      expect((await createVehicle(req({ name: 'Fund V', kind: 'fund' }))).status).toBe(200)
      expect(s.m.tables.fund_member_vehicles).toHaveLength(1)
    } finally { s.role = 'admin'; s.fail = false; err.mockRestore() }
  })
})
