// tests/holding-price-feed-route.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextRequest } from 'next/server'
import { memoryAdmin } from '@/tests/helpers/memory-admin'

const s = vi.hoisted(() => ({ m: null as any, booked: [] as any[], scope: null as any }))
vi.mock('@/lib/supabase/server', () => ({ createClient: async () => ({ auth: { getUser: async () => ({ data: { user: { id: 'u' } } }) } }) }))
vi.mock('@/lib/supabase/admin', () => ({ createAdminClient: () => s.m.admin }))
vi.mock('@/lib/api-helpers', async (orig) => ({
  ...(await orig<any>()),
  assertReadAccess: async () => ({ fundId: 'f', userId: 'u', role: 'member', need: 'read' }),
  assertWriteAccess: async () => ({ fundId: 'f', userId: 'u', role: 'member', need: 'write' }),
}))
vi.mock('@/lib/access/entity-scope', () => ({ loadEntityScope: async () => s.scope }))
vi.mock('@/lib/accounting/http-vehicle', () => ({ resolveGroupOr400: async (_a: unknown, _g: unknown, group: string) => group }))
vi.mock('@/lib/activity', () => ({ logActivity: vi.fn() }))
vi.mock('@/lib/portfolio/quote-marks', () => ({
  quoteMarkForHolding: vi.fn(async () => ({ mark: { delta: 500 }, problem: null })),
  bookQuoteMark: vi.fn(async (_a: unknown, _f: string, _u: string, companyId: string, group: string, asOf: string) => {
    if (asOf === '2026-03-30') return { booked: false, reason: 'Already booked for 2026-03-30.' }
    s.booked.push({ companyId, group, asOf })
    return { booked: true, transactionId: 't9', mark: { delta: 500 }, ledger: { drafted: true, posted: true } }
  }),
}))
import { GET, POST, DELETE } from '@/app/api/companies/[id]/price-feed/route'

const ctx = { params: Promise.resolve({ id: 'k1' }) }
const req = (method: string, body?: object, qs = '') =>
  new NextRequest(`http://x/api/companies/k1/price-feed${qs}`, { method, ...(body ? { body: JSON.stringify(body) } : {}) })
const setFeed = (o: object = {}) => POST(req('POST', { action: 'set', symbol: 'ETH', activeFrom: '2026-01-01', ...o }), ctx)

beforeEach(() => {
  s.booked = []
  s.scope = { access: { vehicles: { all: false, ids: ['v1'] } }, vehicleNames: ['Fund I'], companyIds: ['k1'] }
  s.m = memoryAdmin({
    companies: [{ id: 'k1', fund_id: 'f', name: 'Ether', holding_type: 'crypto', status: 'active', industry: null, stage: null, portfolio_group: ['Fund I', 'Fund II'] }],
    company_vehicles: [{ fund_id: 'f', company_id: 'k1', vehicle_id: 'v1' }, { fund_id: 'f', company_id: 'k1', vehicle_id: 'v2' }],
    fund_vehicles: [{ id: 'v1', fund_id: 'f', name: 'Fund I' }, { id: 'v2', fund_id: 'f', name: 'Fund II' }],
    price_feeds: [],
    price_observations: [],
  })
})

describe('the price feed on a holding', () => {
  it('sets one feed for the holding, and replaces it rather than adding a second', async () => {
    expect((await setFeed()).status).toBe(200)
    expect((await setFeed({ activeFrom: '2026-02-01', quoteCurrency: 'usd' })).status).toBe(200)
    expect(s.m.tables.price_feeds).toHaveLength(1)
    expect(s.m.tables.price_feeds[0]).toMatchObject({ company_id: 'k1', kind: 'digital_asset', symbol: 'ETH', active_from: '2026-02-01', quote_currency: 'USD' })
  })

  it('refuses a feed with no start date', async () => {
    expect((await POST(req('POST', { action: 'set', symbol: 'ETH' }), ctx)).status).toBe(400)
  })

  it('records a quote against that feed', async () => {
    await setFeed()
    expect((await POST(req('POST', { action: 'record-quote', asOfDate: '2026-03-31', price: 150 }), ctx)).status).toBe(200)
    expect(s.m.tables.price_observations[0]).toMatchObject({ feed_id: s.m.tables.price_feeds[0].id, as_of_date: '2026-03-31', price: 150, basis: 'close' })
  })

  it("books a quoted mark for one of the caller's entities", async () => {
    expect((await POST(req('POST', { action: 'book', group: 'Fund I', asOf: '2026-03-31' }), ctx)).status).toBe(200)
    expect(s.booked).toEqual([{ companyId: 'k1', group: 'Fund I', asOf: '2026-03-31' }])
  })

  it('will not book for an entity the caller does not have', async () => {
    expect((await POST(req('POST', { action: 'book', group: 'Fund II', asOf: '2026-03-31' }), ctx)).status).toBe(404)
    expect(s.booked).toEqual([])
  })

  it("lists the marks owed by the caller's entities only", async () => {
    await setFeed()
    const body = await (await GET(req('GET', undefined, '?asOf=2026-03-31'), ctx)).json()
    expect(body.feed.symbol).toBe('ETH')
    expect(body.marks.map((m: any) => m.entity)).toEqual(['Fund I'])
  })

  it('removes the feed', async () => {
    await setFeed()
    expect((await DELETE(req('DELETE'), ctx)).status).toBe(200)
    expect(s.m.tables.price_feeds).toEqual([])
  })

  it("is not found for a holding none of the caller's entities hold", async () => {
    s.scope = { ...s.scope, companyIds: ['other'] }
    expect((await GET(req('GET'), ctx)).status).toBe(404)
  })
})

describe('validation and failed reads', () => {
  it('refuses a quote currency that is not a 3-letter code', async () => {
    for (const quoteCurrency of ['US', 'DOLLAR', 'U1D', 'us$']) {
      expect((await setFeed({ quoteCurrency })).status).toBe(400)
    }
    expect(s.m.tables.price_feeds).toEqual([])
  })

  it('refuses dates that are not real calendar dates', async () => {
    expect((await setFeed({ activeFrom: '2026-02-30' })).status).toBe(400)
    expect((await setFeed({ activeFrom: 'soon' })).status).toBe(400)
    expect((await setFeed({ activeUntil: '2026-13-01' })).status).toBe(400)
    expect((await setFeed({ restrictionUntil: '2026-2-1', restrictionDiscount: 0.2 })).status).toBe(400)
    await setFeed()
    expect((await POST(req('POST', { action: 'record-quote', asOfDate: '2026-02-30', price: 1 }), ctx)).status).toBe(400)
    expect((await POST(req('POST', { action: 'book', group: 'Fund I', asOf: '2026-02-30' }), ctx)).status).toBe(400)
    expect((await GET(req('GET', undefined, '?asOf=2026-02-30'), ctx)).status).toBe(400)
    expect(s.m.tables.price_observations).toEqual([])
    expect(s.booked).toEqual([])
  })

  it('refuses to book a mark dated after today', async () => {
    const tomorrow = new Date(Date.now() + 2 * 86_400_000).toISOString().slice(0, 10)
    expect((await POST(req('POST', { action: 'book', group: 'Fund I', asOf: tomorrow }), ctx)).status).toBe(400)
    expect(s.booked).toEqual([])
  })

  it('passes the reason through when the mark is not booked', async () => {
    const res = await POST(req('POST', { action: 'book', group: 'Fund I', asOf: '2026-03-30' }), ctx)
    expect(res.status).toBe(400)
    expect((await res.json()).error).toBe('Already booked for 2026-03-30.')
  })

  const failRead = (table: string) => {
    const from = s.m.admin.from.bind(s.m.admin)
    s.m.admin.from = (t: string) => {
      if (t !== table) return from(t)
      const fail: any = { select: () => fail, eq: () => fail, in: () => fail, order: () => fail, limit: () => fail,
        maybeSingle: async () => ({ data: null, error: { message: 'boom' } }),
        then: (r: any) => r({ data: null, error: { message: 'boom' } }) }
      return fail
    }
  }

  it('answers 500, not empty, when the holding cannot be read', async () => {
    failRead('companies')
    const res = await GET(req('GET'), ctx)
    expect(res.status).toBe(500)
    expect((await res.json()).error).toMatch(/^Could not read/)
  })

  it("answers 500 when the holding's entities cannot be read", async () => {
    failRead('company_vehicles')
    expect((await GET(req('GET'), ctx)).status).toBe(500)
  })

  it('answers 500 when the price feed cannot be read', async () => {
    failRead('price_feeds')
    expect((await GET(req('GET'), ctx)).status).toBe(500)
    expect((await setFeed()).status).toBe(500)
  })

  it('answers 500 when the recorded quotes cannot be read', async () => {
    await setFeed()
    failRead('price_observations')
    expect((await GET(req('GET'), ctx)).status).toBe(500)
  })
})
