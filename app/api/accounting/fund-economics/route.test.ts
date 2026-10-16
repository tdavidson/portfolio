import { beforeEach, expect, it, vi } from 'vitest'
import { NextRequest, NextResponse } from 'next/server'
const m = vi.hoisted(() => ({ economics: vi.fn(), group: vi.fn(), list: vi.fn(), access: vi.fn() }))
vi.mock('@/lib/supabase/server', () => ({ createClient: async () => ({ auth: { getUser: async () => ({ data: { user: { id: 'user-a' } } }) } }) }))
vi.mock('@/lib/supabase/admin', () => ({ createAdminClient: () => ({}) }))
vi.mock('@/lib/api-helpers', () => ({ assertReadAccess: async () => ({ fundId: 'fund-a', role: 'member' }) }))
vi.mock('@/lib/access/effective', () => ({ loadAccessContext: m.access, hasAccess: () => false }))
vi.mock('@/lib/accounting/fund-economics', () => ({ fundEconomics: m.economics }))
vi.mock('@/lib/accounting/http-vehicle', () => ({ resolveGroupOr400: m.group }))
vi.mock('@/lib/accounting/load', () => ({ listVehiclesWithId: m.list }))
import { GET } from './route'
beforeEach(() => {
  vi.clearAllMocks()
  m.access.mockResolvedValue({ vehicles: { all: false, ids: ['visible'] } })
  m.list.mockResolvedValue([{ id: 'visible', name: 'Visible' }, { id: 'hidden', name: 'Hidden' }])
  m.economics.mockResolvedValue([{ id: 'visible', vehicle: 'Visible', gp: { nav: 5 }, carryAccrued: 10, fund: { nav: 50 } }])
})
it('scopes computation before loading and retains GP redaction', async () => {
  const res = await GET(new NextRequest('https://synthetic.invalid/api/accounting/fund-economics'))
  expect(m.economics).toHaveBeenCalledWith({}, 'fund-a', undefined, ['Visible'])
  const body = await res.json()
  expect(body.vehicles[0]).not.toHaveProperty('gp')
  expect(body.vehicles[0]).not.toHaveProperty('carryAccrued')
  expect(body.vehicles[0].fund.nav).toBe(50)
})
it('denies a requested vehicle before computing anything', async () => {
  m.group.mockResolvedValue(NextResponse.json({ error: 'Forbidden' }, { status: 403 }))
  expect((await GET(new NextRequest('https://synthetic.invalid/api/accounting/fund-economics?group=Hidden'))).status).toBe(403)
  expect(m.economics).not.toHaveBeenCalled()
})
it('uses the canonical authorised vehicle name for a single-vehicle report', async () => {
  m.group.mockResolvedValue('Visible')
  await GET(new NextRequest('https://synthetic.invalid/api/accounting/fund-economics?group=alias'))
  expect(m.economics).toHaveBeenCalledWith({}, 'fund-a', undefined, ['Visible'])
  expect(m.list).not.toHaveBeenCalled()
})
