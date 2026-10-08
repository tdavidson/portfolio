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

describe('reversing an owned entry as a draft', () => {
  it('leaves the transaction until the reversal posts', async () => {
    const res = await patch({ action: 'reverse', reverseDate: '2026-04-01' })
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body).toMatchObject({ status: 'draft', removedTransactions: [], unlinkedRegisterRows: [] })
    expect(s.m.tables.investment_transactions).toHaveLength(1)
    expect(s.m.tables.journal_entries[0]).toMatchObject({ source_ref: 'txn:t1', reversed_by: 'new-1' })
  })
  it('reports what was deleted when only the unlink fails after a posted reversal', async () => {
    s.m.failNext('journal_entries', 'update', 'unused')  // consumed by the reversed_by link, which the route does not check
    s.m.failNext('journal_entries', 'update', 'unlink failed')
    const body = await (await patch({ action: 'reverse', reverseDate: '2026-04-01', post: true })).json()
    expect(body.removedTransactions).toEqual([expect.objectContaining({ id: 't1' })])
    expect(body.warning).toMatch(/could not be unlinked: unlink failed/)
  })
})

describe('either half of a live reversal pair on investment accounts', () => {
  const O = '0a0a0a0a-0a0a-4a0a-8a0a-0a0a0a0a0a0a'
  const pair = (reversalStatus: string) => {
    const orig = s.m.tables.journal_entries[0]
    Object.assign(orig, { id: O, reversed_by: 'r1' })
    for (const p of s.m.tables.journal_postings) p.journal_entry_id = O
    s.m.tables.chart_of_accounts = [
      { id: 'cost', fund_id: 'f', vehicle_id: 'v', code: '1100-a', type: 'asset', subtype: 'investment', company_id: 'co-a' },
      { id: 'cash', fund_id: 'f', vehicle_id: 'v', code: '1000', type: 'asset', subtype: 'cash', company_id: null },
    ]
    s.m.tables.journal_entries.push({ id: 'r1', fund_id: 'f', vehicle_id: 'v', book: 'actual', status: reversalStatus, entry_date: '2026-04-01', source_ref: `reversal:${O}`, reversed_by: null })
  }
  const act = (id: string, action: string) => PATCH(new NextRequest('http://localhost/api/accounting/journal', { method: 'PATCH', body: JSON.stringify({ group: 'Fund I', id, action }) }))

  for (const action of ['void', 'unpost']) {
    it(`${action} of the original is refused`, async () => {
      pair('posted')
      const res = await act(O, action)
      expect(res.status).toBe(400)
      expect((await res.json()).error).toBe('This entry is half of a reversal pair — reverse the reversal instead.')
      expect(s.m.tables.journal_entries[0].status).toBe('posted')
    })
    it(`${action} of the posted reversal is refused`, async () => {
      pair('posted')
      const res = await act('r1', action)
      expect(res.status).toBe(400)
      expect((await res.json()).error).toMatch(/half of a reversal pair/)
      expect(s.m.tables.journal_entries.find((e: any) => e.id === 'r1').status).toBe('posted')
    })
  }
  it('the original is refused while its reversal is still a draft', async () => {
    pair('draft')
    expect((await act(O, 'void')).status).toBe(400)
  })
  it('a draft reversal can still be discarded', async () => {
    pair('draft')
    const res = await act('r1', 'void')
    expect(res.status).toBe(200)
    expect(s.m.tables.investment_transactions).toHaveLength(1)
  })
  it('an original whose reversal was voided can be voided', async () => {
    pair('void')
    expect((await act(O, 'void')).status).toBe(200)
  })
})
