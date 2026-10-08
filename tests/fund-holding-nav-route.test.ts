import { beforeEach, describe, expect, it, vi } from 'vitest'
import { NextRequest } from 'next/server'
import { memoryAdmin } from '@/tests/helpers/memory-admin'

const s = vi.hoisted(() => ({
  m: null as any,
  access: { vehicles: { all: true, ids: [] as string[] } } as any,
  save: vi.fn(), edit: vi.fn(), del: vi.fn(),
}))
vi.mock('@/lib/supabase/server', () => ({ createClient: async () => ({ auth: { getUser: async () => ({ data: { user: { id: 'u' } } }) } }) }))
vi.mock('@/lib/supabase/admin', () => ({ createAdminClient: () => s.m.admin }))
vi.mock('@/lib/api-helpers', async (orig) => ({
  ...(await orig<any>()),
  assertWriteAccess: async () => ({ fundId: 'f', userId: 'u', role: 'member' }),
  assertReadAccess: async () => ({ fundId: 'f', userId: 'u', role: 'member' }),
}))
vi.mock('@/lib/access/effective', async (orig) => ({ ...(await orig<any>()), loadAccessContext: async () => s.access }))
vi.mock('@/lib/portfolio/fof-nav', () => ({ saveNavStatement: s.save, editNavStatement: s.edit, deleteNavStatement: s.del }))
import { DELETE, PATCH, POST } from '@/app/api/portfolio/fund-holdings/[id]/nav/route'

const LATER = [
  { status: 'booked', delta: 50, message: 'Re-booked the Sep 30 mark.' },
  { status: 'no_change', message: 'Dec 31 needs no change.' },
]
const BOOKED = { ok: true, navId: 'n1', booking: { status: 'booked', delta: 200, message: 'Saved, and its mark posted to the ledger.' }, later: LATER }
beforeEach(() => {
  s.access = { vehicles: { all: true, ids: [] } }
  s.save.mockReset().mockResolvedValue(BOOKED)
  s.edit.mockReset().mockResolvedValue(BOOKED)
  s.del.mockReset().mockResolvedValue({ ok: true, later: LATER })
  s.m = memoryAdmin({
    companies: [
      { id: 'h1', fund_id: 'f', name: 'Acme Ventures III', holding_type: 'fund' },
      { id: 'co', fund_id: 'f', name: 'Beta', holding_type: 'company' },
    ],
    fund_vehicles: [{ id: 'v1', fund_id: 'f', name: 'Fund I' }, { id: 'v2', fund_id: 'f', name: 'Fund II' }],
    fund_capital_events: [{ fund_id: 'f', company_id: 'h1', vehicle_id: 'v1' }],
    fund_nav_statements: [
      { id: 'n1', fund_id: 'f', company_id: 'h1', vehicle_id: 'v1', as_of_date: '2026-03-31', reported_nav: 1200 },
      { id: 'n2', fund_id: 'f', company_id: 'h1', vehicle_id: 'v2', as_of_date: '2026-03-31', reported_nav: 900 },
    ],
    chart_of_accounts: [],
  })
})
const props = (id = 'h1') => ({ params: Promise.resolve({ id }) })
const req = (method: string, body?: object, qs = '') =>
  new NextRequest(`http://localhost/api/portfolio/fund-holdings/h1/nav${qs}`, { method, ...(body ? { body: JSON.stringify(body) } : {}) })

describe('the NAV route', () => {
  it('POST saves through saveNavStatement for the named entity and says what it booked, with every later statement as an array', async () => {
    const res = await POST(req('POST', { asOfDate: '2026-06-30', reportedNav: 1500, vehicleId: 'v1' }), props())
    expect(res.status).toBe(200)
    const json = await res.json()
    expect(json.booking).toMatchObject({ status: 'booked', delta: 200 })
    expect(Array.isArray(json.later)).toBe(true)
    expect(json.later).toEqual(LATER)
    expect(s.save).toHaveBeenCalledWith(s.m.admin, 'f', 'u', expect.objectContaining({
      companyId: 'h1', vehicleId: 'v1', asOfDate: '2026-06-30', reportedNav: 1500, source: 'manual',
    }))
  })

  it('POST refuses a holding that is not a fund', async () => {
    const res = await POST(req('POST', { asOfDate: '2026-06-30', reportedNav: 1500, vehicleId: 'v1' }), props('co'))
    expect(res.status).toBe(404)
    expect(s.save).not.toHaveBeenCalled()
  })

  it('PATCH edits the figures through editNavStatement, and refuses a new valuation date', async () => {
    const ok = await PATCH(req('PATCH', { navId: 'n1', reportedNav: 1100 }), props())
    expect(ok.status).toBe(200)
    expect((await ok.json()).later).toEqual(LATER)
    expect(s.edit).toHaveBeenCalledWith(s.m.admin, 'f', 'u', 'n1', { reportedNav: 1100 })
    const moved = await PATCH(req('PATCH', { navId: 'n1', asOfDate: '2026-04-01' }), props())
    expect(moved.status).toBe(400)
  })

  it('DELETE returns the re-booked later statements as an array', async () => {
    const res = await DELETE(req('DELETE', undefined, '?navId=n1'), props())
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true, later: LATER })
    expect(s.del).toHaveBeenCalledWith(s.m.admin, 'f', 'u', 'n1')
  })

  it('PATCH and DELETE do not reach another entity\'s statement', async () => {
    s.access = { vehicles: { all: false, ids: ['v1'] } }
    expect((await PATCH(req('PATCH', { navId: 'n2', reportedNav: 1 }), props())).status).toBe(404)
    expect((await DELETE(req('DELETE', undefined, '?navId=n2'), props())).status).toBe(404)
    expect(s.edit).not.toHaveBeenCalled()
    expect(s.del).not.toHaveBeenCalled()
  })

  it('DELETE passes a refusal back in words', async () => {
    s.del.mockResolvedValue({ ok: false, error: 'Its earlier mark could not be taken back. Inside a closed period.' })
    const res = await DELETE(req('DELETE', undefined, '?navId=n1'), props())
    expect(res.status).toBe(400)
    expect((await res.json()).error).toMatch(/closed period/)
  })
})
