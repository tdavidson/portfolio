// The bank page's Unpost / Ignore / Restore on an entry investment transactions own (consistency
// review I-1). There, acting on the entry is deleting the transaction — which only the journal and
// the holding do. Ignore lets go of the bank row and leaves the entry as it is; the others refuse.
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { NextRequest } from 'next/server'
import { memoryAdmin } from '@/tests/helpers/memory-admin'

const s = vi.hoisted(() => ({ m: null as any, post: null as any, investments: true }))
vi.mock('@/lib/accounting/investment-access', async (orig) => ({ ...(await orig<any>()), loadMayTouchInvestments: async () => s.investments }))
vi.mock('@/lib/supabase/server', () => ({ createClient: async () => ({ auth: { getUser: async () => ({ data: { user: { id: 'u' } } }) } }) }))
vi.mock('@/lib/supabase/admin', () => ({ createAdminClient: () => s.m.admin }))
vi.mock('@/lib/api-helpers', async (orig) => ({ ...(await orig<any>()), assertWriteAccess: async () => ({ fundId: 'f', userId: 'u', role: 'admin' }), assertReadAccess: async () => ({ fundId: 'f', userId: 'u', role: 'admin' }) }))
vi.mock('@/lib/accounting/http-vehicle', () => ({ resolveGroupOr400: async () => 'Fund I' }))
vi.mock('@/lib/accounting/vehicle-id', () => ({ vehicleIdByName: async () => 'v', vehicleNameById: async () => 'Fund I' }))
vi.mock('@/lib/accounting/periods', () => ({ closedPeriodRanges: async () => [], dateInAnyClosedPeriod: () => false }))
vi.mock('@/lib/accounting/continuous-allocation', () => ({
  setGeneratedAllocationStatus: async () => ({}),
  postExistingEntryWithAllocation: (...a: any[]) => s.post(...a),
}))
import { POST } from '@/app/api/accounting/bank/route'

const T1 = '00000000-0000-4000-8000-0000000000a1'
const O = '00000000-0000-4000-8000-0000000000b1'
const chart = [
  { id: 'cost', fund_id: 'f', vehicle_id: 'v', code: '1100-a', type: 'asset', subtype: 'investment', company_id: 'co-a' },
  { id: 'cash', fund_id: 'f', vehicle_id: 'v', code: '1000', type: 'asset', subtype: 'cash', company_id: null },
  { id: 'fees', fund_id: 'f', vehicle_id: 'v', code: '5100', type: 'expense', subtype: 'fees', company_id: null },
]
const entry = (id: string, over: Record<string, any> = {}) => ({ id, fund_id: 'f', vehicle_id: 'v', book: 'actual', status: 'posted', entry_date: '2026-03-01', source_ref: null, reversed_by: null, ...over })
const bank = (id: string, journal_entry_id: string, status: string) => ({ id, fund_id: 'f', vehicle_id: 'v', journal_entry_id, status, raw: {} })

beforeEach(() => {
  s.investments = true
  s.post = vi.fn(async () => ({ allocationEntryIds: [] }))
  s.m = memoryAdmin({
    chart_of_accounts: chart,
    companies: [{ id: 'co-a', fund_id: 'f', name: 'Acme' }],
    investment_transactions: [
      { id: T1, fund_id: 'f', company_id: 'co-a', transaction_type: 'investment', adopted_entry_id: null },
      { id: 't-adopted', fund_id: 'f', company_id: 'co-a', transaction_type: 'investment', adopted_entry_id: 'e-adopted' },
    ],
    journal_entries: [
      entry('e-derived', { source_ref: `txn:${T1}` }),
      entry('e-adopted'),
      entry('e-fee'),
    ],
    journal_postings: [
      { journal_entry_id: 'e-derived', book: 'actual', fund_id: 'f', account_id: 'cost', amount: 100 },
      { journal_entry_id: 'e-derived', book: 'actual', fund_id: 'f', account_id: 'cash', amount: -100 },
    ],
    bank_transactions: [
      bank('b-derived', 'e-derived', 'reconciled'),
      bank('b-adopted', 'e-adopted', 'reconciled'),
      bank('b-fee', 'e-fee', 'reconciled'),
    ],
    journal_entry_allocations: [],
  })
})
const act = (action: string, id: string) => POST(new NextRequest('http://localhost/api/accounting/bank', { method: 'POST', body: JSON.stringify({ action, id }) }))
const entryOf = (id: string) => s.m.tables.journal_entries.find((e: any) => e.id === id)
const rowOf = (id: string) => s.m.tables.bank_transactions.find((r: any) => r.id === id)

describe('bank actions on an investment-owned entry', () => {
  for (const [row, ent] of [['b-derived', 'e-derived'], ['b-adopted', 'e-adopted']]) {
    it(`Unpost on ${ent} refuses and changes nothing`, async () => {
      const res = await act('unpost', row)
      expect(res.status).toBe(400)
      expect((await res.json()).error).toMatch(/investment's payment.*holding.*Journal/)
      expect(entryOf(ent).status).toBe('posted')
      expect(rowOf(row).status).toBe('reconciled')
      expect(s.m.tables.investment_transactions).toHaveLength(2)
    })
    it(`Ignore on ${ent} only lets go of the bank row`, async () => {
      const res = await act('ignore', row)
      expect(res.status).toBe(200)
      expect((await res.json()).note).toMatch(/left as it is/)
      expect(entryOf(ent).status).toBe('posted')
      expect(rowOf(row)).toMatchObject({ status: 'ignored', journal_entry_id: null })
      expect(s.m.tables.investment_transactions).toHaveLength(2)
    })
  }
  it('Restore refuses on a voided entry the transactions still own', async () => {
    Object.assign(entryOf('e-adopted'), { status: 'void' })
    Object.assign(rowOf('b-adopted'), { status: 'ignored' })
    const res = await act('restore', 'b-adopted')
    expect(res.status).toBe(400)
    expect(entryOf('e-adopted').status).toBe('void')
  })
  it('Re-pointing an owned draft\'s account is refused', async () => {
    Object.assign(entryOf('e-derived'), { status: 'draft' })
    Object.assign(rowOf('b-derived'), { status: 'drafted' })
    const res = await POST(new NextRequest('http://localhost/api/accounting/bank', { method: 'POST', body: JSON.stringify({ action: 'setAccount', id: 'b-derived', accountCode: '5100' }) }))
    expect(res.status).toBe(400)
    expect(s.m.tables.journal_postings.find((p: any) => p.amount === 100).account_id).toBe('cost')
  })
  it('Ignore on half of a live reversal pair (owners already gone) leaves both entries', async () => {
    s.m.tables.journal_entries.push(entry(O, { reversed_by: 'r1' }), entry('r1', { source_ref: `reversal:${O}`, entry_date: '2026-04-01' }))
    s.m.tables.journal_postings.push({ journal_entry_id: O, book: 'actual', fund_id: 'f', account_id: 'cost', amount: 100 })
    s.m.tables.bank_transactions.push(bank('b-orig', O, 'reconciled'))
    const res = await act('ignore', 'b-orig')
    expect(res.status).toBe(200)
    expect(entryOf(O).status).toBe('posted')
    expect(rowOf('b-orig')).toMatchObject({ status: 'ignored', journal_entry_id: null })
  })
  it('an ordinary entry is still voided by Ignore and drafted by Unpost', async () => {
    expect((await act('unpost', 'b-fee')).status).toBe(200)
    expect(entryOf('e-fee').status).toBe('draft')
    expect((await act('ignore', 'b-fee')).status).toBe(200)
    expect(entryOf('e-fee').status).toBe('void')
  })
  it('a failed ownership read refuses rather than voiding', async () => {
    s.m.failNext('investment_transactions', 'select', 'read failed')
    const res = await act('ignore', 'b-adopted')
    expect(res.status).toBe(500)
    expect(entryOf('e-adopted').status).toBe('posted')
    expect(rowOf('b-adopted').status).toBe('reconciled')
  })
})

describe('posting a reversal draft from the bank page', () => {
  it('says what it deleted, and carries the warning when the release failed part-way', async () => {
    Object.assign(entryOf('e-fee'), { status: 'draft' })
    Object.assign(rowOf('b-fee'), { status: 'drafted' })
    s.post = vi.fn(async () => ({ allocationEntryIds: [], removedTransactions: [{ id: T1, company: 'Acme' }], unlinkedRegisterRows: [], warning: 'The reversal was posted, but its transactions could not be deleted.' }))
    const body = await (await act('post', 'b-fee')).json()
    expect(body).toMatchObject({ ok: true, removedTransactions: [{ id: T1 }], warning: expect.stringMatching(/reversal was posted/) })
  })
  it('postMany collects them across entries', async () => {
    Object.assign(entryOf('e-fee'), { status: 'draft' })
    Object.assign(rowOf('b-fee'), { status: 'drafted' })
    s.post = vi.fn(async () => ({ allocationEntryIds: [], removedTransactions: [{ id: T1, company: 'Acme' }], unlinkedRegisterRows: ['the call of 2026-03-01'], warning: 'w' }))
    const body = await (await POST(new NextRequest('http://localhost/api/accounting/bank', { method: 'POST', body: JSON.stringify({ action: 'postMany', ids: ['b-fee'] }) }))).json()
    expect(body).toMatchObject({ ok: true, posted: 1, removedTransactions: [{ id: T1 }], unlinkedRegisterRows: ['the call of 2026-03-01'], warnings: ['w'] })
  })
})

describe('posting from the bank page without investments write (security M2)', () => {
  it('passes the caller\'s investments access to the posting choke point, and a refusal is a 403', async () => {
    s.investments = false
    Object.assign(entryOf('e-fee'), { status: 'draft' })
    Object.assign(rowOf('b-fee'), { status: 'drafted' })
    const { NEEDS_INVESTMENTS_WRITE } = await import('@/lib/accounting/investment-access')
    s.post = vi.fn(async () => ({ error: NEEDS_INVESTMENTS_WRITE }))
    const res = await act('post', 'b-fee')
    expect(res.status).toBe(403)
    expect(s.post).toHaveBeenCalledWith(expect.anything(), 'f', 'Fund I', 'u', 'e-fee', { investments: false })
    expect(rowOf('b-fee').status).toBe('drafted')
  })
})
