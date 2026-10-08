// tests/investment-txn-fund-register.test.ts
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { NextRequest } from 'next/server'
import { memoryAdmin } from '@/tests/helpers/memory-admin'

const s = vi.hoisted(() => ({ m: null as any, retract: vi.fn(), redraft: vi.fn() }))
vi.mock('@/lib/supabase/server', () => ({ createClient: async () => ({ auth: { getUser: async () => ({ data: { user: { id: 'u' } } }) } }) }))
vi.mock('@/lib/supabase/admin', () => ({ createAdminClient: () => s.m.admin }))
vi.mock('@/lib/api-helpers', async (orig) => ({ ...(await orig<any>()), assertWriteAccess: async () => ({ fundId: 'f', userId: 'u', role: 'admin' }) }))
vi.mock('@/lib/access/entity-scope', () => ({ loadEntityScope: async () => ({ vehicleNames: null, companyIds: null, access: {} }) }))
vi.mock('@/lib/accounting/from-portfolio', () => ({ retractEntriesForTransaction: s.retract, redraftEntryForTransaction: s.redraft }))
vi.mock('@/lib/activity', () => ({ logActivity: () => {} }))
import { DELETE, PATCH } from '@/app/api/companies/[id]/investments/[txnId]/route'

const txn = (id: string) => ({ id, fund_id: 'f', company_id: 'h1', transaction_type: 'unrealized_gain_change', portfolio_group: 'Fund I', unrealized_value_change: 200 })
beforeEach(() => {
  s.retract.mockReset().mockResolvedValue({ retracted: 1 })
  s.redraft.mockReset().mockResolvedValue({ drafted: true })
  s.m = memoryAdmin({
    investment_transactions: [txn('t-nav'), txn('t-event'), txn('t-free')],
    fund_nav_statements: [{ id: 'n1', fund_id: 'f', company_id: 'h1', investment_transaction_id: 't-nav' }],
    fund_capital_events: [{ id: 'e1', fund_id: 'f', company_id: 'h1', investment_transaction_id: 't-event' }],
    companies: [{ id: 'h1', fund_id: 'f', name: 'Acme Ventures III', holding_type: 'fund' }],
  })
})
const props = (txnId: string) => ({ params: Promise.resolve({ id: 'h1', txnId }) })
const patch = (txnId: string) => PATCH(new NextRequest(`http://localhost/api/companies/h1/investments/${txnId}`, {
  method: 'PATCH', body: JSON.stringify({ unrealized_value_change: 999 }),
}), props(txnId))
const del = (txnId: string) => DELETE(new NextRequest(`http://localhost/api/companies/h1/investments/${txnId}`, { method: 'DELETE' }), props(txnId))

describe('a transaction the fund register booked', () => {
  it('a NAV statement\'s mark is not edited or deleted here — the message points to the register', async () => {
    for (const res of [await patch('t-nav'), await del('t-nav')]) {
      expect(res.status).toBe(409)
      expect((await res.json()).error).toMatch(/manager NAV statement.*fund register on the holding/)
    }
    expect(s.m.tables.investment_transactions.find((t: any) => t.id === 't-nav').unrealized_value_change).toBe(200)
    expect(s.retract).not.toHaveBeenCalled()
    expect(s.redraft).not.toHaveBeenCalled()
  })

  it('a capital notice\'s transaction is not edited or deleted here either', async () => {
    for (const res of [await patch('t-event'), await del('t-event')]) {
      expect(res.status).toBe(409)
      expect((await res.json()).error).toMatch(/capital notice in the fund register/)
    }
    expect(s.m.tables.investment_transactions).toHaveLength(3)
  })

  it('a transaction nothing in the register owns is still edited and deleted as before', async () => {
    expect((await patch('t-free')).status).toBe(200)
    expect((await del('t-free')).status).toBe(200)
    expect(s.m.tables.investment_transactions.map((t: any) => t.id)).toEqual(['t-nav', 't-event'])
  })

  it('another fund\'s link to the same id does not count', async () => {
    s.m.tables.fund_nav_statements = [{ id: 'n9', fund_id: 'g', company_id: 'h1', investment_transaction_id: 't-free' }]
    expect((await patch('t-free')).status).toBe(200)
  })
})
