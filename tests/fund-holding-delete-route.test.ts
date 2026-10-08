// tests/fund-holding-delete-route.test.ts
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { NextRequest } from 'next/server'
import { memoryAdmin } from '@/tests/helpers/memory-admin'

const s = vi.hoisted(() => ({ m: null as any }))
vi.mock('@/lib/supabase/server', () => ({ createClient: async () => ({ auth: { getUser: async () => ({ data: { user: { id: 'u' } } }) } }) }))
vi.mock('@/lib/supabase/admin', () => ({ createAdminClient: () => s.m.admin }))
vi.mock('@/lib/api-helpers', async (orig) => ({ ...(await orig<any>()), assertWriteAccess: async () => ({ fundId: 'f', userId: 'u', role: 'admin' }) }))
vi.mock('@/lib/access/entity-scope', () => ({ loadEntityScope: async () => ({ vehicleNames: null, companyIds: null, access: {} }) }))
vi.mock('@/lib/access/company-delete', () => ({ companyDeleteDenial: async () => null }))
import { DELETE } from '@/app/api/portfolio/fund-holdings/[id]/route'

beforeEach(() => {
  s.m = memoryAdmin({
    companies: [{ id: 'h1', fund_id: 'f', name: 'Acme Ventures III', holding_type: 'fund' }],
    fund_capital_events: [],
    fund_nav_statements: [{ id: 'n1', fund_id: 'f', company_id: 'h1', investment_transaction_id: 't1' }],
  })
})

describe('deleting a fund holding', () => {
  it('a holding whose NAV statements carry marks says to delete those statements first', async () => {
    const res = await DELETE(new NextRequest('http://localhost/api/portfolio/fund-holdings/h1', { method: 'DELETE' }), { params: Promise.resolve({ id: 'h1' }) })
    expect(res.status).toBe(409)
    expect((await res.json()).error).toMatch(/Delete its NAV statements first/)
    expect(s.m.tables.companies).toHaveLength(1)
  })

  const del = (id = 'h1') => DELETE(new NextRequest(`http://localhost/api/portfolio/fund-holdings/${id}`, { method: 'DELETE' }), { params: Promise.resolve({ id }) })
  const seed = (extra: Record<string, any[]> = {}) => {
    s.m = memoryAdmin({
      companies: [
        { id: 'h1', fund_id: 'f', name: 'Acme Ventures III', holding_type: 'fund' },
        { id: 'c1', fund_id: 'f', name: 'Acme Inc', holding_type: 'company' },
        { id: 'k1', fund_id: 'f', name: 'Bitcoin', holding_type: 'crypto' },
      ],
      fund_capital_events: [], fund_nav_statements: [], investment_transactions: [], chart_of_accounts: [], journal_postings: [],
      ...extra,
    })
  }

  it('deletes a fund holding with nothing on the ledger, and its accounts', async () => {
    seed({ chart_of_accounts: [{ id: 'a1', fund_id: 'f', company_id: 'h1', code: '1100-h1' }] })
    const res = await del()
    expect(res.status).toBe(200)
    expect(s.m.tables.companies.map((c: any) => c.id)).toEqual(['c1', 'k1'])
    expect(s.m.tables.chart_of_accounts).toEqual([])
  })

  it('deletes only a FUND holding: a company or a digital asset is not found here', async () => {
    seed()
    expect((await del('c1')).status).toBe(404)
    expect((await del('k1')).status).toBe(404)
    expect(s.m.tables.companies).toHaveLength(3)
  })

  it('refuses while the holding has any investment transaction', async () => {
    seed({ investment_transactions: [{ id: 't1', fund_id: 'f', company_id: 'h1', transaction_type: 'investment' }] })
    const res = await del()
    expect(res.status).toBe(409)
    expect((await res.json()).error).toMatch(/1 investment transaction/)
    expect(s.m.tables.companies).toHaveLength(3)
  })

  it('a posting in the TAX book pins the holding\'s accounts too', async () => {
    seed({
      chart_of_accounts: [{ id: 'a1', fund_id: 'f', company_id: 'h1', code: '1100-h1' }],
      journal_postings: [{ id: 'p1', fund_id: 'f', account_id: 'a1', book: 'tax' }],
    })
    const res = await del()
    expect(res.status).toBe(409)
    expect((await res.json()).error).toMatch(/ledger posting/)
    expect(s.m.tables.companies).toHaveLength(3)
  })

  it('a failed read refuses rather than reading as nothing there', async () => {
    for (const table of ['fund_capital_events', 'fund_nav_statements', 'investment_transactions', 'chart_of_accounts']) {
      seed()
      s.m.failNext(table, 'select', 'boom')
      expect((await del()).status, table).toBe(500)
      expect(s.m.tables.companies, table).toHaveLength(3)
    }
    seed({ chart_of_accounts: [{ id: 'a1', fund_id: 'f', company_id: 'h1', code: '1100-h1' }] })
    s.m.failNext('journal_postings', 'select', 'boom')
    expect((await del()).status).toBe(500)
    expect(s.m.tables.companies).toHaveLength(3)
  })
})
