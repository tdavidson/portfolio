import { describe, it, expect, vi, beforeEach } from 'vitest'
import { buildEntryForTransaction } from './from-portfolio'
import { accountIdByCode } from './persist'
import { loadPostedLedger } from './load'

/**
 * A distribution credited to cost after the records say the cost is already back. The records
 * value the holding at 0; the books, once this exit is in, carry it below 0. A normal derive books
 * that gap to 1200/4200. Splitting an ADOPTED entry asks for the entry without it
 * (recordsTrueUp: false), so the split compares like with like instead of refusing the edit.
 */
vi.mock('./persist', () => ({ accountIdByCode: vi.fn(), persistEntry: vi.fn() }))
vi.mock('./load', () => ({ loadPostedLedger: vi.fn() }))
vi.mock('./vehicle-id', () => ({ vehicleIdByName: vi.fn(async () => 'veh-1'), ensureVehiclesByName: vi.fn() }))
vi.mock('./vehicle-domain', () => ({ vehicleKindByName: vi.fn(async () => 'fund') }))
vi.mock('./provision-accounts', () => ({ ensureVehicleAccounts: vi.fn() }))
vi.mock('./investments', () => ({
  ensureInvestmentAccounts: vi.fn(async () => new Map([['co-1', { costId: 'cost', unrealizedId: 'unreal', fxId: 'fx', realizedId: 'gain-co' }]])),
}))

const purchase = {
  id: 'b1', company_id: 'co-1', portfolio_group: 'Fund I', transaction_date: '2021-03-01',
  transaction_type: 'investment', round_name: null, investment_cost: 100_000,
}
const returned = {
  id: 'x1', company_id: 'co-1', portfolio_group: 'Fund I', transaction_date: '2023-06-30',
  transaction_type: 'proceeds', round_name: null, cost_basis_exited: 100_000, proceeds_received: 100_000,
}
const excess = {
  id: 'x2', company_id: 'co-1', portfolio_group: 'Fund I', transaction_date: '2024-03-31',
  transaction_type: 'proceeds', round_name: null, cost_basis_exited: 40_000, proceeds_received: 40_000,
}

const rows: Record<string, any[]> = { investment_transactions: [purchase, returned, excess] }
const chainFor = (table: string): any => new Proxy({}, {
  get: (_t, prop) => prop === 'then'
    ? (resolve: any) => resolve({ data: rows[table] ?? [], error: null })
    : () => chainFor(table),
})
const admin = { from: (table: string) => chainFor(table) } as any

const lines = (r: any, id: string) => r.entry.postings.filter((p: any) => p.accountId === id).map((p: any) => p.amount)

beforeEach(() => {
  vi.mocked(accountIdByCode).mockResolvedValue(new Map([['1000', 'cash'], ['4000', 'gain'], ['4200', 'unreal-income']]))
  // Bought for 100k, all of it returned: the books carry nothing for the holding.
  vi.mocked(loadPostedLedger).mockResolvedValue({
    accounts: [], capitalPostings: [],
    postings: [
      { accountId: 'cost', amount: 100_000, entryDate: '2021-03-01' }, { accountId: 'cash', amount: -100_000, entryDate: '2021-03-01' },
      { accountId: 'cost', amount: -100_000, entryDate: '2023-06-30' }, { accountId: 'cash', amount: 100_000, entryDate: '2023-06-30' },
    ],
  } as any)
})

describe('buildEntryForTransaction: recordsTrueUp', () => {
  it('books the gap to the records by default', async () => {
    const r: any = await buildEntryForTransaction(admin, 'f1', excess, 'Acme')
    expect(lines(r, 'cost')).toEqual([-40_000])
    expect(lines(r, 'unreal')).toEqual([40_000])
  })
  it('leaves the gap out when asked, so an adopted split sees only what the row itself implies', async () => {
    const r: any = await buildEntryForTransaction(admin, 'f1', excess, 'Acme', { recordsTrueUp: false })
    expect(lines(r, 'cost')).toEqual([-40_000])
    expect(lines(r, 'cash')).toEqual([40_000])
    expect(lines(r, 'unreal')).toEqual([])
  })
  it('re-derived as gain, the excess needs no true-up either way', async () => {
    const r: any = await buildEntryForTransaction(admin, 'f1', { ...excess, cost_basis_exited: 0 }, 'Acme')
    expect(lines(r, 'cash')).toEqual([40_000])
    expect(lines(r, 'gain-co')).toEqual([-40_000])
    expect(lines(r, 'unreal')).toEqual([])
  })
})
