import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextRequest } from 'next/server'
import { memoryAdmin } from '@/tests/helpers/memory-admin'

const s = vi.hoisted(() => ({ m: null as any, seeded: [] as string[], vehicleId: 'v1' as string | null, fail: false }))
vi.mock('@/lib/supabase/server', () => ({ createClient: async () => ({ auth: { getUser: async () => ({ data: { user: { id: 'u' } } }) } }) }))
vi.mock('@/lib/supabase/admin', () => ({ createAdminClient: () => s.m.admin }))
vi.mock('@/lib/api-helpers', async (orig) => ({ ...(await orig<any>()), assertReadAccess: async () => ({ fundId: 'f', userId: 'u', role: 'admin' }) }))
vi.mock('@/lib/accounting/http-vehicle', () => ({ resolveGroupOr400: async () => 'Fund I' }))
vi.mock('@/lib/accounting/vehicle-id', () => ({ vehicleIdByName: async () => s.vehicleId }))
vi.mock('@/lib/accounting/provision-accounts', () => ({ ensureVehicleAccounts: vi.fn(async (_a: any, _f: string, g: string) => { if (s.fail) throw new Error('boom'); s.seeded.push(g) }) }))
import { GET } from '@/app/api/accounting/chart/route'

const get = () => GET(new NextRequest('http://x/api/accounting/chart?group=Fund%20I'))

describe('GET chart seeds on first look', () => {
  beforeEach(() => { s.seeded = []; s.vehicleId = 'v1'; s.fail = false })
  it('seeds when the entity has no accounts', async () => {
    s.m = memoryAdmin({ chart_of_accounts: [] })
    expect((await get()).status).toBe(200)
    expect(s.seeded).toEqual(['Fund I'])
  })
  it('does not seed when a chart exists', async () => {
    s.m = memoryAdmin({ chart_of_accounts: [{ id: 'a', fund_id: 'f', vehicle_id: 'v1', code: '1000' }] })
    expect((await get()).status).toBe(200)
    expect(s.seeded).toEqual([])
  })
  it('does not seed without a vehicle id', async () => {
    s.vehicleId = null; s.m = memoryAdmin({ chart_of_accounts: [] })
    await get()
    expect(s.seeded).toEqual([])
  })
  it('a seed failure does not fail the read', async () => {
    s.fail = true; s.m = memoryAdmin({ chart_of_accounts: [] })
    const err = vi.spyOn(console, 'error').mockImplementation(() => {})
    try { expect((await get()).status).toBe(200) } finally { err.mockRestore() }
  })
})
