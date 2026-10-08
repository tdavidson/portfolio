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
})
