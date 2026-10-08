import { describe, it, expect, vi } from 'vitest'
import { NextRequest } from 'next/server'

const h = vi.hoisted(() => ({ vehicleIdByName: vi.fn() }))
vi.mock('@/lib/supabase/server', () => ({ createClient: async () => ({ auth: { getUser: async () => ({ data: { user: { id: 'u' } } }) } }) }))
vi.mock('@/lib/supabase/admin', () => ({ createAdminClient: () => ({}) }))
vi.mock('@/lib/api-helpers', () => ({ assertReadAccess: async () => ({ fundId: 'f', userId: 'u', role: 'member', need: 'read' }) }))
vi.mock('@/lib/accounting/http-vehicle', () => ({ resolveGroupOr400: async (_a: unknown, _g: unknown, group: string) => group }))
vi.mock('@/lib/accounting/vehicle-visibility', () => ({ visibleVehicleNames: async () => null }))
vi.mock('@/lib/accounting/load', () => ({ listVehicles: async () => ['Fund I', 'Fund II'] }))
vi.mock('@/lib/accounting/vehicle-id', () => ({ vehicleIdByName: h.vehicleIdByName }))
vi.mock('@/lib/portfolio/sheet-load', () => ({ loadPortfolioSheet: async () => ({ companies: [], funds: [], crypto: [] }) }))
import { GET } from '@/app/api/portfolio/sheet/route'
import { soiRowHref } from '@/lib/portfolio/holding-href'

const get = (qs = '') => GET(new NextRequest(`http://x/api/portfolio/sheet${qs}`)).then(r => r.json())

describe("an entity's portfolio sheet", () => {
  it("returns the entity's id, so each holding opens on that entity's view of it", async () => {
    h.vehicleIdByName.mockResolvedValue('v2')
    const body = await get('?group=Fund%20II')
    expect(body).toMatchObject({ vehicles: ['Fund II'], vehicleId: 'v2' })
    expect(soiRowHref({ companyId: 'k1' }, body.vehicleId)).toBe('/companies/k1?entity=v2')
  })

  it('names no entity on the aggregate sheet', async () => {
    h.vehicleIdByName.mockClear()
    expect(await get()).toMatchObject({ vehicles: ['Fund I', 'Fund II'], vehicleId: null })
    expect(h.vehicleIdByName).not.toHaveBeenCalled()
  })

  it("still serves the sheet when the entity's id cannot be read", async () => {
    h.vehicleIdByName.mockRejectedValue(new Error('boom'))
    expect(await get('?group=Fund%20II')).toMatchObject({ vehicles: ['Fund II'], vehicleId: null })
  })
})
