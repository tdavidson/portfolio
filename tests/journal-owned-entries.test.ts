import { beforeEach, describe, expect, it, vi } from 'vitest'
import { NextRequest } from 'next/server'
import { memoryAdmin } from '@/tests/helpers/memory-admin'

const s = vi.hoisted(() => ({ m: null as any, n: 0, persistFails: false }))
vi.mock('@/lib/supabase/server', () => ({ createClient: async () => ({ auth: { getUser: async () => ({ data: { user: { id: 'u' } } }) } }) }))
vi.mock('@/lib/supabase/admin', () => ({ createAdminClient: () => s.m.admin }))
vi.mock('@/lib/api-helpers', async (orig) => ({ ...(await orig<any>()), assertWriteAccess: async () => ({ fundId: 'f', userId: 'u', role: 'admin' }), assertReadAccess: async () => ({ fundId: 'f', userId: 'u', role: 'admin' }) }))
vi.mock('@/lib/accounting/http-vehicle', () => ({ resolveGroupOr400: async () => 'Fund I' }))
vi.mock('@/lib/accounting/vehicle-id', () => ({ vehicleIdByName: async () => 'v', vehicleNameById: async () => 'Fund I' }))
vi.mock('@/lib/accounting/periods', () => ({ closedPeriodRanges: async () => [], dateInAnyClosedPeriod: () => false }))
vi.mock('@/lib/accounting/continuous-allocation', () => ({ setGeneratedAllocationStatus: async () => ({}), postExistingEntryWithAllocation: async () => ({ allocationEntryIds: [] }) }))
vi.mock('@/lib/accounting/persist', () => ({
  persistEntry: async (_a: any, fundId: string, _g: string, _u: any, entry: any, status: string) => {
    if (s.persistFails) return { error: 'allocation failed' }
    const id = `new-${++s.n}`
    s.m.tables.journal_entries.push({ id, fund_id: fundId, vehicle_id: 'v', book: 'actual', status, source_ref: entry.sourceRef ?? null })
    return { entryId: id }
  },
}))
import { PATCH, PUT } from '@/app/api/accounting/journal/route'

beforeEach(() => {
  s.n = 0
  s.persistFails = false
  s.m = memoryAdmin({
    companies: [{ id: 'co-a', fund_id: 'f', name: 'Acme' }],
    investment_transactions: [{ id: 't1', fund_id: 'f', company_id: 'co-a', transaction_type: 'investment', transaction_date: '2026-03-01' }],
    journal_entries: [{ id: 'e1', fund_id: 'f', vehicle_id: 'v', book: 'actual', status: 'posted', entry_date: '2026-03-01', memo: 'Investment — Acme', source_type: 'investment', source_ref: 'txn:t1', reversed_by: null, adjusting: false }],
    journal_postings: [{ journal_entry_id: 'e1', book: 'actual', fund_id: 'f', account_id: 'cost', amount: 100, currency: 'USD', lp_entity_id: null }, { journal_entry_id: 'e1', book: 'actual', fund_id: 'f', account_id: 'cash', amount: -100, currency: 'USD', lp_entity_id: null }],
    bank_transactions: [], fund_capital_events: [], fund_nav_statements: [],
  })
})
const patch = (body: object) => PATCH(new NextRequest('http://localhost/api/accounting/journal', { method: 'PATCH', body: JSON.stringify({ group: 'Fund I', id: 'e1', ...body }) }))

describe('journal actions on an owned entry', () => {
  it('void deletes the transaction', async () => {
    const res = await patch({ action: 'void' })
    expect(res.status).toBe(200)
    expect((await res.json()).removedTransactions).toEqual([expect.objectContaining({ id: 't1', company: 'Acme' })])
    expect(s.m.tables.investment_transactions).toEqual([])
    expect(s.m.tables.journal_entries[0].status).toBe('void')
  })
  it('unpost deletes the transaction and frees the entry to be adopted again', async () => {
    await patch({ action: 'unpost' })
    expect(s.m.tables.investment_transactions).toEqual([])
    expect(s.m.tables.journal_entries[0]).toMatchObject({ status: 'draft', source_ref: null })
  })
  it('reverse deletes the transaction and posts a reversal pair', async () => {
    const res = await patch({ action: 'reverse', reverseDate: '2026-04-01', post: true })
    expect(res.status).toBe(200)
    expect(s.m.tables.investment_transactions).toEqual([])
    expect(s.m.tables.journal_entries.find((e: any) => e.id !== 'e1')).toMatchObject({ source_ref: 'reversal:e1', status: 'posted' })
  })
  it('reverse whose reversal fails to persist leaves the transaction in place', async () => {
    s.persistFails = true
    const res = await patch({ action: 'reverse', reverseDate: '2026-04-01', post: true })
    expect(res.status).toBe(400)
    expect(s.m.tables.investment_transactions).toHaveLength(1)
    expect(s.m.tables.journal_entries[0].source_ref).toBe('txn:t1')
  })
  it('reverse reports the register rows that lost their link', async () => {
    s.m.tables.fund_capital_events.push({ id: 'ev', fund_id: 'f', kind: 'call', event_date: '2026-03-01', investment_transaction_id: 't1' })
    const body = await (await patch({ action: 'reverse', reverseDate: '2026-04-01', post: true })).json()
    expect(body.unlinkedRegisterRows).toEqual(['the call of 2026-03-01'])
  })
  it('PUT on a derived draft deletes the transaction and says so', async () => {
    Object.assign(s.m.tables.journal_entries[0], { status: 'draft' })
    s.m.tables.journal_postings.splice(0)
    const res = await PUT(new NextRequest('http://localhost/api/accounting/journal', {
      method: 'PUT',
      body: JSON.stringify({ group: 'Fund I', id: 'e1', postings: [{ accountId: 'cost', amount: 50 }, { accountId: 'cash', amount: -50 }] }),
    }))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.removedTransactions).toEqual([expect.objectContaining({ id: 't1' })])
    expect(body.unlinkedRegisterRows).toEqual([])
    expect(s.m.tables.investment_transactions).toEqual([])
    expect(s.m.tables.journal_entries[0].source_ref).toBeNull()
  })
})
