// tests/investment-txn-fund-register.test.ts
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { NextRequest } from 'next/server'
import { memoryAdmin } from '@/tests/helpers/memory-admin'

const s = vi.hoisted(() => ({ m: null as any, retract: vi.fn(), redraft: vi.fn() }))
vi.mock('@/lib/supabase/server', () => ({ createClient: async () => ({ auth: { getUser: async () => ({ data: { user: { id: 'u' } } }) } }) }))
vi.mock('@/lib/supabase/admin', () => ({ createAdminClient: () => s.m.admin }))
vi.mock('@/lib/api-helpers', async (orig) => ({ ...(await orig<any>()), assertWriteAccess: async () => ({ fundId: 'f', userId: 'u', role: 'admin' }) }))
vi.mock('@/lib/access/entity-scope', () => ({ loadEntityScope: async () => ({ vehicleNames: null, companyIds: null, access: {} }) }))
vi.mock('@/lib/accounting/from-portfolio', () => ({ retractEntriesForTransaction: s.retract, draftEntryForTransaction: s.redraft }))
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

describe('editing a transaction retracts the ledger side first', () => {
  const row = () => s.m.tables.investment_transactions.find((t: any) => t.id === 't-free')
  it('a refused retract (closed period) leaves the transaction unchanged and derives nothing', async () => {
    s.retract.mockResolvedValue({ retracted: 0, reason: 'Its journal entry is dated 2026-03-01, inside a closed period. Reopen the period to change it — the tracker and the ledger would otherwise disagree.' })
    const res = await patch('t-free')
    expect(res.status).toBe(409)
    expect((await res.json()).error).toMatch(/Can't change this transaction\. .*closed period/)
    expect(row().unrealized_value_change).toBe(200)
    expect(s.redraft).not.toHaveBeenCalled()
  })
  it('an adopted entry that cannot be split leaves the transaction unchanged too', async () => {
    s.retract.mockResolvedValue({ retracted: 0, reason: "This journal entry records several investments in a way that can't be split automatically." })
    expect((await patch('t-free')).status).toBe(409)
    expect(row().unrealized_value_change).toBe(200)
  })
  it('the retract is handed the PRE-edit row, and the edited row is derived after the update', async () => {
    const res = await patch('t-free')
    expect(res.status).toBe(200)
    expect(s.retract).toHaveBeenCalledWith(expect.anything(), 'f', 't-free', expect.objectContaining({ original: expect.objectContaining({ unrealized_value_change: 200 }) }))
    expect(s.redraft).toHaveBeenCalledWith(expect.anything(), 'f', 'u', expect.objectContaining({ id: 't-free', unrealized_value_change: 999 }), 'Acme Ventures III')
    expect(row().unrealized_value_change).toBe(999)
  })
  it('a failed update puts the unchanged transaction back on the ledger', async () => {
    s.m.failNext('investment_transactions', 'update', 'update failed')
    const res = await patch('t-free')
    expect(res.status).toBe(500)
    expect(row().unrealized_value_change).toBe(200)
    expect(s.redraft).toHaveBeenCalledTimes(1)
    expect(s.redraft).toHaveBeenCalledWith(expect.anything(), 'f', 'u', expect.objectContaining({ id: 't-free', unrealized_value_change: 200 }), 'Acme Ventures III')
  })
  it('when the update fails AND the unchanged row cannot be re-derived, the response says the entry is gone', async () => {
    s.m.failNext('investment_transactions', 'update', 'update failed')
    s.redraft.mockResolvedValue({ drafted: false, reason: 'The period is closed.' })
    const res = await patch('t-free')
    expect(res.status).toBe(500)
    expect((await res.json()).error).toBe("The transaction's journal entry was removed and could not be re-derived: The period is closed. Re-save the transaction to post it again.")
  })
})

describe('an edit the database would refuse is refused BEFORE anything is retracted', () => {
  const edit = (body: Record<string, unknown>) => PATCH(new NextRequest('http://localhost/api/companies/h1/investments/t-free', {
    method: 'PATCH', body: JSON.stringify(body),
  }), props('t-free'))
  const row = () => s.m.tables.investment_transactions.find((t: any) => t.id === 't-free')
  it.each([
    [{ transaction_type: 'split' }, /split_ratio/],
    [{ transaction_type: 'split', split_ratio: 2, transaction_date: null }, /transaction_date/],
    [{ split_ratio: -1 }, /split_ratio/],
    [{ transaction_type: 'income', income_kind: 'staking', income_settlement: 'in_kind', income_amount: 10, transaction_date: '2025-01-02' }, /units/],
    [{ transaction_type: 'income', income_kind: 'gift', income_settlement: 'cash', income_amount: 10, transaction_date: '2025-01-02' }, /income_kind/],
    [{ transaction_date: '2025-02-30' }, /date/],
    [{ unrealized_value_change: 'lots' }, /number/],
    [{ fee_amount: -5 }, /fee_amount/],
    [{ fx_rate: 0 }, /fx_rate/],
    [{ valuation_change_source: 'guess' }, /valuation_change_source/],
  ])('%j', async (body, message) => {
    const res = await edit(body)
    expect(res.status).toBe(400)
    expect((await res.json()).error).toMatch(message)
    expect(s.retract).not.toHaveBeenCalled()
    expect(s.redraft).not.toHaveBeenCalled()
    expect(row().unrealized_value_change).toBe(200)
  })
  it('a valid edit still goes through, numeric strings included', async () => {
    expect((await edit({ unrealized_value_change: '250', transaction_date: '2025-01-02' })).status).toBe(200)
  })
})
