// tests/investments-list-kinds.test.ts
import { describe, it, expect, vi } from 'vitest'
import { NextRequest } from 'next/server'
import { memoryAdmin } from '@/tests/helpers/memory-admin'

const s = vi.hoisted(() => ({ m: null as any, scope: null as any }))
vi.mock('@/lib/supabase/server', () => ({ createClient: async () => ({ auth: { getUser: async () => ({ data: { user: { id: 'u' } } }) } }) }))
vi.mock('@/lib/supabase/admin', () => ({ createAdminClient: () => s.m.admin }))
vi.mock('@/lib/access/entity-scope', () => ({ loadEntityScopeForUser: async () => s.scope }))
import { GET } from '@/app/api/portfolio/investments/route'

const t = (o: Record<string, unknown>) => ({ fund_id: 'f', portfolio_group: 'Fund I', transaction_date: '2026-01-15', round_name: null, ...o })
const co = (id: string, name: string, holding_type: string, portfolio_group = ['Fund I']) => ({ id, fund_id: 'f', name, status: 'active', portfolio_group, holding_type })
const open = { access: {}, vehicleNames: null, companyIds: null }

describe('GET /api/portfolio/investments', () => {
  it('lists companies, fund holdings and digital assets, each with its kind and its value', async () => {
    s.scope = open
    s.m = memoryAdmin({
      fund_members: [{ user_id: 'u', fund_id: 'f', role: 'admin' }],
      companies: [co('c1', 'Acme', 'company'), co('f1', 'Acme Ventures III', 'fund'), co('k1', 'Ether', 'crypto')],
      investment_transactions: [
        t({ id: 'a', company_id: 'c1', transaction_type: 'investment', investment_cost: 1000, round_name: 'Seed' }),
        t({ id: 'b', company_id: 'f1', transaction_type: 'investment', investment_cost: 500 }),
        t({ id: 'c', company_id: 'f1', transaction_type: 'unrealized_gain_change', unrealized_value_change: 200, valuation_change_source: 'nav', transaction_date: '2026-03-31' }),
        t({ id: 'd', company_id: 'k1', transaction_type: 'investment', investment_cost: 1000, shares_acquired: 10, share_price: 100 }),
        t({ id: 'e', company_id: 'k1', transaction_type: 'unrealized_gain_change', unrealized_value_change: 500, current_share_price: 150, valuation_change_source: 'quote', transaction_date: '2026-03-31' }),
      ],
    })
    const body = await (await GET(new NextRequest('http://x/api/portfolio/investments?asOf=2026-06-30'))).json()
    const byId = Object.fromEntries(body.companies.map((c: any) => [c.companyId, c]))
    expect(byId.c1.holdingType).toBe('company')
    expect(byId.f1.holdingType).toBe('fund')
    expect(byId.k1.holdingType).toBe('crypto')
    expect(byId.c1.unrealizedValue).toBe(1000)
    // A fund holding carries its manager NAV — cost 500 plus the 200 mark — not its cost.
    expect(byId.f1.unrealizedValue).toBe(700)
    // A digital asset is its units at the latest quoted price.
    expect(byId.k1.unrealizedValue).toBe(1500)
  })

  it('lists a fund holding or digital asset with no transactions yet as an empty entry, within entity scope', async () => {
    s.scope = { access: {}, vehicleNames: ['Fund I'], companyIds: ['f1', 'k1', 'c2'] }
    s.m = memoryAdmin({
      fund_members: [{ user_id: 'u', fund_id: 'f', role: 'member' }],
      companies: [
        co('f1', 'New Fund Holding', 'fund'),
        co('k1', 'New Coin', 'crypto'),
        co('c2', 'No-deal Company', 'company'),
        co('f2', 'Hidden Fund', 'fund', ['Fund II']),
      ],
      investment_transactions: [],
    })
    const body = await (await GET(new NextRequest('http://x/api/portfolio/investments'))).json()
    const byId = Object.fromEntries(body.companies.map((c: any) => [c.companyId, c]))
    expect(byId.f1).toMatchObject({ holdingType: 'fund', totalInvested: 0, unrealizedValue: 0, fmv: 0 })
    expect(byId.k1).toMatchObject({ holdingType: 'crypto', totalInvested: 0, unrealizedValue: 0 })
    // A company with no transactions was never listed, and a holding of an entity the caller cannot see stays hidden.
    expect(byId.c2).toBeUndefined()
    expect(byId.f2).toBeUndefined()
  })
})
