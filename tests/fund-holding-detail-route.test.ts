import { beforeEach, describe, expect, it, vi } from 'vitest'
import { NextRequest } from 'next/server'
import { memoryAdmin } from '@/tests/helpers/memory-admin'

const s = vi.hoisted(() => ({ m: null as any, access: { vehicles: { all: true, ids: [] as string[] } } as any }))
vi.mock('@/lib/supabase/server', () => ({ createClient: async () => ({ auth: { getUser: async () => ({ data: { user: { id: 'u' } } }) } }) }))
vi.mock('@/lib/supabase/admin', () => ({ createAdminClient: () => s.m.admin }))
vi.mock('@/lib/api-helpers', async (orig) => ({ ...(await orig<any>()), assertReadAccess: async () => ({ fundId: 'f', userId: 'u', role: 'member' }) }))
vi.mock('@/lib/access/effective', async (orig) => ({ ...(await orig<any>()), loadAccessContext: async () => s.access }))
import { GET } from '@/app/api/portfolio/fund-holdings/[id]/route'

beforeEach(() => {
  s.access = { vehicles: { all: true, ids: [] } }
  s.m = memoryAdmin({
    companies: [{ id: 'h1', fund_id: 'f', name: 'Acme Ventures III', holding_type: 'fund' }],
    fund_vehicles: [{ id: 'v1', fund_id: 'f', name: 'Fund I' }, { id: 'v2', fund_id: 'f', name: 'Fund II' }, { id: 'v3', fund_id: 'f', name: 'Fund III' }],
    fund_holding_terms: [{ fund_id: 'f', company_id: 'h1', vehicle_id: 'v1', commitment: 5000 }, { fund_id: 'f', company_id: 'h1', vehicle_id: 'v2', commitment: 3000 }],
    fund_capital_events: [
      { id: 'e1', fund_id: 'f', company_id: 'h1', vehicle_id: 'v1', event_date: '2026-01-15', amount: 1000 },
      { id: 'e2', fund_id: 'f', company_id: 'h1', vehicle_id: 'v2', event_date: '2026-01-20', amount: 600 },
    ],
    fund_nav_statements: [{ id: 'n2', fund_id: 'f', company_id: 'h1', vehicle_id: 'v2', as_of_date: '2026-03-31', reported_nav: 700 }],
  })
})
const get = async (qs = '') => (await GET(new NextRequest(`http://localhost/api/portfolio/fund-holdings/h1${qs}`), { params: Promise.resolve({ id: 'h1' }) })).json()

describe('one fund holding, for one entity', () => {
  it('shows the first entity by name when none is asked for, and lists the holding\'s entities', async () => {
    const json = await get()
    expect(json.vehicleId).toBe('v1')
    expect(json.vehicles).toEqual([{ id: 'v1', name: 'Fund I' }, { id: 'v2', name: 'Fund II' }])
    expect(json.events.map((e: any) => e.id)).toEqual(['e1'])
    expect(json.terms.commitment).toBe(5000)
    expect(json.navStatements).toEqual([])
  })

  it('shows the entity asked for', async () => {
    const json = await get('?entity=v2')
    expect(json.vehicleId).toBe('v2')
    expect(json.events.map((e: any) => e.id)).toEqual(['e2'])
    expect(json.navStatements.map((n: any) => n.id)).toEqual(['n2'])
  })

  it('ignores an entity the member cannot see', async () => {
    s.access = { vehicles: { all: false, ids: ['v1'] } }
    const json = await get('?entity=v2')
    expect(json.vehicleId).toBe('v1')
    expect(json.vehicles).toEqual([{ id: 'v1', name: 'Fund I' }])
    expect(json.events.map((e: any) => e.id)).toEqual(['e1'])
    expect(json.navStatements).toEqual([])
    expect(JSON.stringify(json)).not.toContain('Fund II')
  })

  it('opens an entity of the caller\'s with no activity yet, so its first notice can be recorded', async () => {
    const json = await get('?entity=v3')
    expect(json.vehicleId).toBe('v3')
    expect(json.events).toEqual([])
    expect(json.terms).toBeNull()
  })
  it('lists the entity\'s open manager-email reviews, and unassigned ones only to an unscoped caller', async () => {
    s.m.tables.parsing_reviews = [
      { id: 'r1', fund_id: 'f', company_id: 'h1', vehicle_id: 'v1', issue_type: 'fund_nav', resolution: null, payload: { kind: 'nav' } },
      { id: 'r2', fund_id: 'f', company_id: 'h1', vehicle_id: 'v2', issue_type: 'fund_nav', resolution: null, payload: { kind: 'nav' } },
      { id: 'r3', fund_id: 'f', company_id: 'h1', vehicle_id: null, issue_type: 'fund_capital_call', resolution: null, payload: { kind: 'call' } },
      { id: 'r4', fund_id: 'f', company_id: 'h1', vehicle_id: 'v1', issue_type: 'fund_nav', resolution: 'accepted', payload: { kind: 'nav' } },
    ]
    expect((await get()).reviews.map((r: any) => r.id).sort()).toEqual(['r1', 'r3'])
    s.access = { vehicles: { all: false, ids: ['v1'] } }
    expect((await get()).reviews.map((r: any) => r.id)).toEqual(['r1'])
  })

  it('says the reviews could not be loaded rather than showing none', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const from = s.m.admin.from
    s.m.admin.from = (t: string) => t === 'parsing_reviews'
      ? { select: () => { const q: any = { eq: () => q, is: () => q, in: () => q, order: async () => ({ data: null, error: { message: 'timeout' } }) }; return q } }
      : from(t)
    const json = await get()
    expect(json.reviews).toEqual([])
    expect(json.reviewsWarning).toMatch(/could not be loaded/)
  })
})
