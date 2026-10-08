import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextRequest } from 'next/server'
import { memoryAdmin } from '@/tests/helpers/memory-admin'

const s = vi.hoisted(() => ({ m: null as any, scope: null as any }))
vi.mock('@/lib/supabase/server', () => ({ createClient: async () => ({ auth: { getUser: async () => ({ data: { user: { id: 'u' } } }) } }) }))
vi.mock('@/lib/supabase/admin', () => ({ createAdminClient: () => s.m.admin }))
vi.mock('@/lib/api-helpers', async (orig) => ({
  ...(await orig<any>()),
  assertReadAccess: async () => ({ fundId: 'f', userId: 'u', role: 'member', need: 'read' }),
  assertWriteAccess: async () => ({ fundId: 'f', userId: 'u', role: 'member', need: 'write' }),
}))
vi.mock('@/lib/access/entity-scope', () => ({ loadEntityScope: async () => s.scope }))
vi.mock('@/lib/activity', () => ({ logActivity: vi.fn() }))
import { GET, POST, DELETE } from '@/app/api/companies/[id]/wallets/route'

const ctx = { params: Promise.resolve({ id: 'k1' }) }
const req = (method: string, body?: object, qs = '') =>
  new NextRequest(`http://x/api/companies/k1/wallets${qs}`, { method, ...(body ? { body: JSON.stringify(body) } : {}) })
const inv = (id: string, group: string, units: number) =>
  ({ id, fund_id: 'f', company_id: 'k1', transaction_type: 'investment', transaction_date: '2026-01-15', portfolio_group: group, investment_cost: units * 100, shares_acquired: units, share_price: 100, round_name: null })

// A member of Fund I only, on a token Fund I and Fund II both hold.
const fundIOnly = () => ({ access: { vehicles: { all: false, ids: ['v1'] } }, vehicleNames: ['Fund I'], companyIds: ['k1'] })
// A scoped member who sees both entities.
const bothScoped = () => ({ access: { vehicles: { all: false, ids: ['v1', 'v2'] } }, vehicleNames: ['Fund I', 'Fund II'], companyIds: ['k1'] })

const seed = (extra: Record<string, any[]> = {}) => memoryAdmin({
  companies: [{ id: 'k1', fund_id: 'f', name: 'Ether', holding_type: 'crypto', status: 'active', industry: null, stage: null, portfolio_group: ['Fund I', 'Fund II'] }],
  company_vehicles: [{ fund_id: 'f', company_id: 'k1', vehicle_id: 'v1' }, { fund_id: 'f', company_id: 'k1', vehicle_id: 'v2' }],
  fund_vehicles: [{ id: 'v1', fund_id: 'f', name: 'Fund I' }, { id: 'v2', fund_id: 'f', name: 'Fund II' }],
  crypto_wallets: [{ id: 'w2', fund_id: 'f', company_id: 'k1', chain: 'ethereum', address: '0xbbbb', label: null, portfolio_group: 'Fund II', active: true }],
  crypto_wallet_balances: [],
  investment_transactions: [inv('i1', 'Fund I', 10), inv('i2', 'Fund II', 20)],
  ...extra,
})

beforeEach(() => {
  s.scope = fundIOnly()
  s.m = seed()
})

const addMine = () => POST(req('POST', { action: 'add', vehicleId: 'v1', chain: 'Ethereum', address: ' 0xaaaa ', label: 'Treasury' }), ctx)
const untagged = { id: 'wu', fund_id: 'f', company_id: 'k1', chain: 'ethereum', address: '0xuuuu', label: null, portfolio_group: null, active: true }

describe('wallets on a holding', () => {
  it("adds a wallet in one of the caller's entities", async () => {
    expect((await addMine()).status).toBe(200)
    const added = s.m.tables.crypto_wallets.find((w: any) => w.id !== 'w2')
    expect(added).toMatchObject({ fund_id: 'f', company_id: 'k1', portfolio_group: 'Fund I', chain: 'ethereum', address: '0xaaaa', label: 'Treasury' })
  })

  it('will not add a wallet in an entity the caller does not have', async () => {
    const res = await POST(req('POST', { action: 'add', vehicleId: 'v2', chain: 'ethereum', address: '0xcccc' }), ctx)
    expect(res.status).toBe(400)
    expect(s.m.tables.crypto_wallets).toHaveLength(1)
  })

  it('rejects malformed wallets, balances and dates', async () => {
    const add = (o: object) => POST(req('POST', { action: 'add', vehicleId: 'v1', chain: 'ethereum', address: '0xaaaa', ...o }), ctx)
    expect((await add({ address: 'x'.repeat(201) })).status).toBe(400)
    expect((await add({ chain: 42 })).status).toBe(400)
    expect((await add({ label: 'x'.repeat(201) })).status).toBe(400)
    expect(s.m.tables.crypto_wallets).toHaveLength(1)
    await addMine()
    const mine = s.m.tables.crypto_wallets.find((w: any) => w.id !== 'w2')
    const rec = (o: object) => POST(req('POST', { action: 'record-balance', walletId: mine.id, asOfDate: '2026-03-31', units: 1, ...o }), ctx)
    expect((await rec({ units: -1 })).status).toBe(400)
    expect((await rec({ units: null })).status).toBe(400)
    expect((await rec({ units: 'abc' })).status).toBe(400)
    expect((await rec({ asOfDate: '2026-02-30' })).status).toBe(400)
    expect((await rec({ asOfDate: '2999-01-01' })).status).toBe(400)
    expect((await rec({ blockHeight: 1.5 })).status).toBe(400)
    expect(s.m.tables.crypto_wallet_balances).toHaveLength(0)
    expect((await GET(req('GET', undefined, '?asOf=nope'), ctx)).status).toBe(400)
  })

  it("lists only the caller's entities' wallets, and their chain-versus-books variance", async () => {
    await addMine()
    const mine = s.m.tables.crypto_wallets.find((w: any) => w.id !== 'w2')
    expect((await POST(req('POST', { action: 'record-balance', walletId: mine.id, asOfDate: '2026-03-31', units: 12 }), ctx)).status).toBe(200)
    const body = await (await GET(req('GET', undefined, '?asOf=2026-03-31'), ctx)).json()
    expect(body.wallets.map((w: any) => w.id)).toEqual([mine.id])
    expect(body.wallets[0]).toMatchObject({ entity: 'Fund I', latestBalance: { units: 12 } })
    expect(body.variances).toEqual([expect.objectContaining({ entity: 'Fund I', observedUnits: 12, recordedUnits: 10, delta: 2 })])
  })

  it("records proof of control on the caller's wallet", async () => {
    await addMine()
    const mine = s.m.tables.crypto_wallets.find((w: any) => w.id !== 'w2')
    expect((await POST(req('POST', { action: 'verify', walletId: mine.id, method: 'signed_message' }), ctx)).status).toBe(200)
    expect(mine).toMatchObject({ verification_method: 'signed_message' })
    expect(mine.verified_at).toBeTruthy()
  })

  it("will not touch another entity's wallet", async () => {
    expect((await DELETE(req('DELETE', undefined, '?walletId=w2'), ctx)).status).toBe(404)
    expect((await POST(req('POST', { action: 'verify', walletId: 'w2', method: 'signed_message' }), ctx)).status).toBe(404)
    expect((await POST(req('POST', { action: 'record-balance', walletId: 'w2', asOfDate: '2026-03-31', units: 1 }), ctx)).status).toBe(404)
    expect(s.m.tables.crypto_wallets.map((w: any) => w.id)).toEqual(['w2'])
    expect(s.m.tables.crypto_wallet_balances).toHaveLength(0)
  })

  it("stops watching the caller's wallet", async () => {
    await addMine()
    const mine = s.m.tables.crypto_wallets.find((w: any) => w.id !== 'w2')
    expect((await DELETE(req('DELETE', undefined, `?walletId=${mine.id}`), ctx)).status).toBe(200)
    expect(s.m.tables.crypto_wallets.map((w: any) => w.id)).toEqual(['w2'])
  })
})

describe('an untagged legacy wallet on a holding two entities hold', () => {
  beforeEach(() => { s.m = seed({ crypto_wallets: [{ ...untagged }] }) })

  it('is invisible to, and untouchable by, a caller who sees only one of the entities', async () => {
    const body = await (await GET(req('GET'), ctx)).json()
    expect(body.wallets).toEqual([])
    expect((await POST(req('POST', { action: 'verify', walletId: 'wu', method: 'signed_message' }), ctx)).status).toBe(404)
    expect((await POST(req('POST', { action: 'record-balance', walletId: 'wu', asOfDate: '2026-03-31', units: 1 }), ctx)).status).toBe(404)
    expect((await DELETE(req('DELETE', undefined, '?walletId=wu'), ctx)).status).toBe(404)
    expect(s.m.tables.crypto_wallets).toHaveLength(1)
  })

  it('is actionable by a scoped caller who sees every entity of the holding', async () => {
    s.scope = bothScoped()
    const body = await (await GET(req('GET'), ctx)).json()
    expect(body.wallets).toEqual([expect.objectContaining({ id: 'wu', entity: null })])
    expect((await POST(req('POST', { action: 'verify', walletId: 'wu', method: 'signed_message' }), ctx)).status).toBe(200)
    expect((await DELETE(req('DELETE', undefined, '?walletId=wu'), ctx)).status).toBe(200)
  })

  it('is actionable by a caller with unscoped access', async () => {
    s.scope = { access: { vehicles: { all: true, ids: [] } }, vehicleNames: null, companyIds: null }
    expect((await DELETE(req('DELETE', undefined, '?walletId=wu'), ctx)).status).toBe(200)
  })
})

describe('an untagged legacy wallet on a holding one entity holds', () => {
  it('belongs to that entity, whoever else exists on the holding', async () => {
    s.m = seed({ crypto_wallets: [{ ...untagged }], investment_transactions: [inv('i1', 'Fund I', 10)] })
    const body = await (await GET(req('GET'), ctx)).json()
    expect(body.wallets).toEqual([expect.objectContaining({ id: 'wu', entity: 'Fund I' })])
  })

  it("decides the holder from the whole fund's transactions, not the caller's", async () => {
    // Fund II's purchase is invisible to the caller; it must still make the wallet shared.
    s.m = seed({ crypto_wallets: [{ ...untagged }] })
    expect((await GET(req('GET'), ctx).then(r => r.json())).wallets).toEqual([])
  })
})

describe('a failed read is an error, not an empty list', () => {
  const breakReads = (table: string) => {
    const real = s.m.admin
    s.m = { ...s.m, admin: { ...real, from: (t: string) => t === table
      ? { select: () => { const q: any = { eq: () => q, lte: () => q, order: () => q, maybeSingle: async () => ({ data: null, error: { message: 'boom' } }), then: (r: any) => r({ data: null, error: { message: 'boom' } }) }; return q } }
      : real.from(t) } }
  }
  it.each(['crypto_wallets', 'crypto_wallet_balances', 'investment_transactions'])('answers 500 when %s cannot be read', async (table) => {
    breakReads(table)
    const res = await GET(req('GET'), ctx)
    expect(res.status).toBe(500)
    expect((await res.json()).error).toMatch(/^Could not read/)
  })
  it('answers 500, and deletes nothing, when the holding transactions cannot be read', async () => {
    breakReads('investment_transactions')
    expect((await DELETE(req('DELETE', undefined, '?walletId=w2'), ctx)).status).toBe(500)
    expect(s.m.tables.crypto_wallets).toHaveLength(1)
  })
})
