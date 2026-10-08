import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextRequest } from 'next/server'
import { memoryAdmin } from '@/tests/helpers/memory-admin'

const s = vi.hoisted(() => ({ m: null as any, seeded: [] as string[], canInvest: true }))
vi.mock('@/lib/supabase/server', () => ({ createClient: async () => ({ auth: { getUser: async () => ({ data: { user: { id: 'u' } } }) } }) }))
vi.mock('@/lib/supabase/admin', () => ({ createAdminClient: () => s.m.admin }))
vi.mock('@/lib/metrics/seed-default-metrics', () => ({ seedCompanyFromDefaults: vi.fn(async (_a: unknown, _f: string, id: string) => { s.seeded.push(id) }) }))
vi.mock('@/lib/activity', () => ({ logActivity: vi.fn() }))
vi.mock('@/lib/accounting/vehicle-id', () => ({ ensureVehiclesByName: vi.fn(async () => {}) }))
vi.mock('@/lib/access/entity-scope', () => ({ loadEntityScopeForUser: async () => ({ access: {}, vehicleNames: ['Fund I'], companyIds: [] }) }))
vi.mock('@/lib/access/effective', () => ({ loadAccessContext: async () => ({}), hasAccess: () => s.canInvest }))
import { POST } from '@/app/api/companies/route'

const post = (body: object) => POST(new NextRequest('http://x/api/companies', { method: 'POST', body: JSON.stringify(body) }))

beforeEach(() => {
  s.m = memoryAdmin({ fund_members: [{ user_id: 'u', fund_id: 'f', role: 'member' }], companies: [] })
  s.seeded = []
  s.canInvest = true
})

describe('POST /api/companies', () => {
  it("creates a digital asset in the caller's entity, with no company metrics", async () => {
    const res = await post({ name: 'Ether', holding_type: 'crypto', portfolio_group: ['Fund I'] })
    expect(res.status).toBe(201)
    expect(s.m.tables.companies[0]).toMatchObject({ name: 'Ether', holding_type: 'crypto', portfolio_group: ['Fund I'], status: 'active' })
    expect(s.seeded).toEqual([])
  })

  it('reads anything unknown as a company, and seeds its metrics', async () => {
    expect((await post({ name: 'Acme', holding_type: 'banana', portfolio_group: ['Fund I'] })).status).toBe(201)
    expect(s.m.tables.companies[0].holding_type).toBe('company')
    expect(s.seeded).toEqual([s.m.tables.companies[0].id])
  })

  it('refuses a digital asset in an entity the caller cannot see', async () => {
    expect((await post({ name: 'Ether', holding_type: 'crypto', portfolio_group: ['Fund II'] })).status).toBe(403)
    expect(s.m.tables.companies).toEqual([])
  })

  it('refuses a digital asset from a member without write access to investments', async () => {
    s.canInvest = false
    expect((await post({ name: 'Ether', holding_type: 'crypto', portfolio_group: ['Fund I'] })).status).toBe(403)
    expect(s.m.tables.companies).toEqual([])
  })

  it('refuses a fund holding: that is created from Investments', async () => {
    const res = await post({ name: 'Fund X', holding_type: 'fund', portfolio_group: ['Fund I'] })
    expect(res.status).toBe(400)
    expect((await res.json()).error).toBe('Add a fund holding from Investments.')
    expect(s.m.tables.companies).toEqual([])
  })
})
