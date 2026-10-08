import { beforeEach, describe, expect, it, vi } from 'vitest'
import { NextRequest } from 'next/server'
import { memoryAdmin } from '@/tests/helpers/memory-admin'

const s = vi.hoisted(() => ({ m: null as any, scope: null as any }))
vi.mock('@/lib/supabase/server', () => ({ createClient: async () => ({ auth: { getUser: async () => ({ data: { user: { id: 'u' } } }) } }) }))
vi.mock('@/lib/supabase/admin', () => ({ createAdminClient: () => s.m.admin }))
vi.mock('@/lib/api-helpers', async (orig) => ({ ...(await orig<any>()), assertReadAccess: async () => ({ fundId: 'f', userId: 'u', role: 'member' }) }))
vi.mock('@/lib/access/entity-scope', async (orig) => ({ ...(await orig<any>()), loadEntityScope: async () => s.scope }))
import { GET } from '@/app/api/portfolio/fund-holdings/route'

beforeEach(() => {
  s.scope = { access: { vehicles: { all: true, ids: [] } }, companyIds: null }
  s.m = memoryAdmin({
    companies: [{ id: 'h1', fund_id: 'f', name: 'Acme Ventures III', holding_type: 'fund' }],
    fund_vehicles: [{ id: 'v1', fund_id: 'f', name: 'Fund I' }, { id: 'v2', fund_id: 'f', name: 'Fund II' }],
    fund_holding_terms: [{ fund_id: 'f', company_id: 'h1', vehicle_id: 'v1', commitment: 5000 }, { fund_id: 'f', company_id: 'h1', vehicle_id: 'v2', commitment: 3000 }],
    fund_capital_events: [
      { id: 'e1', fund_id: 'f', company_id: 'h1', vehicle_id: 'v1', kind: 'call', event_date: '2026-01-15', amount: 1000 },
      { id: 'e2', fund_id: 'f', company_id: 'h1', vehicle_id: 'v2', kind: 'call', event_date: '2026-01-20', amount: 600 },
    ],
    fund_nav_statements: [],
  })
})
const get = async () => (await GET(new NextRequest('http://localhost/api/portfolio/fund-holdings?asOf=2026-06-30'))).json()

describe('fund-holdings register', () => {
  it('lists one row per holding and entity for a caller who sees everything', async () => {
    const json = await get()
    expect(json.positions.map((p: any) => p.key)).toEqual(['h1:v1', 'h1:v2'])
  })

  it('lists only the entities a scoped member can see', async () => {
    s.scope = { access: { vehicles: { all: false, ids: ['v1'] } }, companyIds: ['h1'] }
    const json = await get()
    expect(json.positions.map((p: any) => p.key)).toEqual(['h1:v1'])
    expect(JSON.stringify(json)).not.toContain('Fund II')
    expect(json.positions[0].commitment).toBe(5000)
  })
})
