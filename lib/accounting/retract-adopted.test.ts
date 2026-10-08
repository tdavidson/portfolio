// lib/accounting/retract-adopted.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { memoryAdmin } from '@/tests/helpers/memory-admin'

const s = vi.hoisted(() => ({ m: null as any, n: 0, closed: false }))
vi.mock('./periods', () => ({ closedPeriodRanges: async () => [], dateInAnyClosedPeriod: () => s.closed }))
vi.mock('./vehicle-id', () => ({ vehicleNameById: async () => 'Fund I' }))
vi.mock('./continuous-allocation', () => ({ setGeneratedAllocationStatus: vi.fn(async () => ({})) }))
vi.mock('./persist', () => ({
  persistEntry: vi.fn(async (_a: any, fundId: string, _g: string, _u: any, entry: any, status: string) => {
    const id = `new-${++s.n}`
    s.m.tables.journal_entries.push({ id, fund_id: fundId, book: 'actual', status, source_ref: entry.sourceRef ?? null, memo: entry.memo })
    for (const p of entry.postings) s.m.tables.journal_postings.push({ journal_entry_id: id, book: 'actual', fund_id: fundId, account_id: p.accountId, amount: p.amount, lp_entity_id: p.lpEntityId ?? null })
    return { entryId: id }
  }),
}))
// The builder is tested in from-portfolio; here it is the inverse of the reader for purchases.
const cost = vi.hoisted(() => ({ override: null as null | number }))
vi.mock('./from-portfolio', () => ({
  buildEntryForTransaction: vi.fn(async (_a: any, _f: string, t: any) => {
    const amount = t.company_id === 'co-a' && cost.override != null ? cost.override : Number(t.investment_cost)
    return {
      entry: { fundId: 'f', entryDate: '2026-03-01', sourceRef: `txn:${t.id}`, postings: [
        { accountId: t.company_id === 'co-a' ? 'a1100' : 'b1100', amount, currency: 'USD', lpEntityId: null },
        { accountId: 'cash', amount: -amount, currency: 'USD', lpEntityId: null },
      ] },
      group: 'Fund I', vehicleId: 'v', cashId: 'cash', kind: 'investment', amount,
    }
  }),
}))
import { retractAdoptedEntry } from './retract-adopted'
import { buildEntryForTransaction } from './from-portfolio'
import { persistEntry } from './persist'

const chart = [
  { id: 'cash', fund_id: 'f', vehicle_id: 'v', code: '1000', type: 'asset', subtype: 'cash', company_id: null },
  { id: 'ap', fund_id: 'f', vehicle_id: 'v', code: '2000', type: 'liability', subtype: 'payable', company_id: null },
  { id: 'a1100', fund_id: 'f', vehicle_id: 'v', code: '1100-a', type: 'asset', subtype: 'investment', company_id: 'co-a' },
  { id: 'b1100', fund_id: 'f', vehicle_id: 'v', code: '1100-b', type: 'asset', subtype: 'investment', company_id: 'co-b' },
]
const tA = { id: 'tA', fund_id: 'f', company_id: 'co-a', transaction_type: 'investment', investment_cost: 100, transaction_date: '2026-03-01', adopted_entry_id: 'e1' }
const tB = { id: 'tB', fund_id: 'f', company_id: 'co-b', transaction_type: 'investment', investment_cost: 200, transaction_date: '2026-03-01', adopted_entry_id: 'e1' }
const seed = (offset: string) => {
  s.m = memoryAdmin({
    chart_of_accounts: chart,
    companies: [{ id: 'co-a', fund_id: 'f', name: 'Acme' }, { id: 'co-b', fund_id: 'f', name: 'Beta' }],
    investment_transactions: [tA, tB],
    journal_entries: [{ id: 'e1', fund_id: 'f', book: 'actual', status: 'posted', entry_date: '2026-03-01', memo: 'QB 7', vehicle_id: 'v', portfolio_group: 'Fund I' }],
    journal_postings: [['a1100', 100], ['b1100', 200], [offset, -300]].map(([account_id, amount]) =>
      ({ journal_entry_id: 'e1', book: 'actual', fund_id: 'f', account_id, amount, lp_entity_id: null })),
    bank_transactions: [],
  })
  return s.m
}
/** Balances per account across posted entries. */
const books = (m: any) => {
  const posted = new Set(m.tables.journal_entries.filter((e: any) => e.status === 'posted').map((e: any) => e.id))
  const out: Record<string, number> = {}
  for (const p of m.tables.journal_postings) if (posted.has(p.journal_entry_id)) out[p.account_id] = (out[p.account_id] ?? 0) + Number(p.amount)
  return Object.fromEntries(Object.entries(out).filter(([, v]) => v !== 0))
}

beforeEach(() => { s.n = 0; s.closed = false; cost.override = null })

describe('retractAdoptedEntry', () => {
  it('re-derives the sibling and removes only this transaction\'s original effect', async () => {
    const m = seed('cash')
    expect(await retractAdoptedEntry(m.admin, 'f', { txnId: 'tA', entryId: 'e1', original: tA, userId: 'u' })).toEqual({ retracted: 1 })
    expect(books(m)).toEqual({ b1100: 200, cash: -200 })
    expect(m.tables.journal_entries.find((e: any) => e.id === 'e1').status).toBe('void')
    expect(m.tables.journal_entries.find((e: any) => e.source_ref === 'txn:tB').status).toBe('posted')
    expect(m.tables.investment_transactions.map((t: any) => t.adopted_entry_id)).toEqual([null, null])
  })
  it('keeps what the entry booked beyond its investments, as a remainder', async () => {
    const m = seed('ap')
    await retractAdoptedEntry(m.admin, 'f', { txnId: 'tA', entryId: 'e1', original: tA, userId: 'u' })
    // Before: a1100 100, b1100 200, ap -300. Removing tA's original (a1100 100 / cash -100) leaves:
    expect(books(m)).toEqual({ b1100: 200, cash: 100, ap: -300 })
    expect(m.tables.journal_entries.find((e: any) => e.source_ref === 'adopted-remainder:e1')).toMatchObject({ status: 'posted' })
  })
  it('refuses, touching nothing, when the split would leave investment value in the remainder', async () => {
    cost.override = 90
    const m = seed('cash')
    const r = await retractAdoptedEntry(m.admin, 'f', { txnId: 'tA', entryId: 'e1', original: tA, userId: 'u' })
    expect(r).toEqual({ retracted: 0, reason: expect.stringMatching(/split automatically/) })
    expect(books(m)).toEqual({ a1100: 100, b1100: 200, cash: -300 })
    expect(m.tables.investment_transactions.map((t: any) => t.adopted_entry_id)).toEqual(['e1', 'e1'])
  })
  it('refuses in a closed period', async () => {
    s.closed = true
    const m = seed('cash')
    expect(await retractAdoptedEntry(m.admin, 'f', { txnId: 'tA', entryId: 'e1', original: tA, userId: 'u' }))
      .toEqual({ retracted: 0, reason: expect.stringMatching(/closed period/) })
  })
  it('never throws: a builder that throws for a sibling refuses, touching nothing', async () => {
    const m = seed('cash')
    vi.mocked(buildEntryForTransaction).mockRejectedValueOnce(new Error('Unknown entity Beta'))
    const r = await retractAdoptedEntry(m.admin, 'f', { txnId: 'tA', entryId: 'e1', original: tA, userId: 'u' })
    expect(r).toEqual({ retracted: 0, reason: expect.stringMatching(/Unknown entity/) })
    expect(books(m)).toEqual({ a1100: 100, b1100: 200, cash: -300 })
    expect(m.tables.journal_entries.find((e: any) => e.id === 'e1').status).toBe('posted')
    expect(m.tables.investment_transactions.map((t: any) => t.adopted_entry_id)).toEqual(['e1', 'e1'])
  })
  it('subtracts the PRE-edit transaction, not the stored (already edited) row', async () => {
    const m = seed('cash')
    m.tables.investment_transactions.find((t: any) => t.id === 'tA').investment_cost = 150
    expect(await retractAdoptedEntry(m.admin, 'f', { txnId: 'tA', entryId: 'e1', original: tA, userId: 'u' })).toEqual({ retracted: 1 })
    expect(books(m)).toEqual({ b1100: 200, cash: -200 })
  })
  it('refuses when the entry changed under it, re-posting nothing', async () => {
    const m = seed('cash')
    const flaky = memoryAdmin({ ...m.tables }, {
      before: (table, op, _p, tables) => {
        if (table === 'journal_entries' && op === 'update') tables.journal_entries!.find((e: any) => e.id === 'e1')!.status = 'void'
      },
    })
    const r = await retractAdoptedEntry(flaky.admin, 'f', { txnId: 'tA', entryId: 'e1', original: tA, userId: 'u' })
    expect(r).toEqual({ retracted: 0, reason: expect.stringMatching(/changed while/) })
    expect(flaky.tables.journal_entries.filter((e: any) => e.source_ref)).toEqual([])
    expect(flaky.tables.investment_transactions.map((t: any) => t.adopted_entry_id)).toEqual(['e1', 'e1'])
  })
  it('names the voided entry when the remainder cannot be re-posted', async () => {
    const m = seed('ap')
    vi.mocked(persistEntry).mockImplementationOnce(async () => ({ entryId: 'ok' }) as any)
    vi.mocked(persistEntry).mockImplementationOnce(async () => ({ error: 'boom' }) as any)
    const r = await retractAdoptedEntry(m.admin, 'f', { txnId: 'tA', entryId: 'e1', original: tA, userId: 'u' })
    expect(r.retracted).toBe(1)
    expect(r.warning).toMatch(/voided entry "QB 7".*re-saving transactions will not restore/)
    expect(r.warning).not.toMatch(/Re-save those/)
  })
})
