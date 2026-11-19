import { describe, it, expect, vi, beforeEach } from 'vitest'
import { buildEntryForTransaction } from './from-portfolio'
import { accountIdByCode } from './persist'
import { inKindExceeds } from '@/lib/portfolio/proceeds'

/**
 * Shares received as consideration in an exit are bought with those shares, not cash: the
 * purchase credits 1360, where the exit put them.
 */
vi.mock('./persist', () => ({ accountIdByCode: vi.fn(), persistEntry: vi.fn() }))
vi.mock('./vehicle-id', () => ({ vehicleIdByName: vi.fn(async () => 'veh-1'), ensureVehiclesByName: vi.fn() }))
vi.mock('./vehicle-domain', () => ({ vehicleKindByName: vi.fn(async () => 'fund') }))
vi.mock('./provision-accounts', () => ({ ensureVehicleAccounts: vi.fn() }))
vi.mock('./investments', () => ({
  ensureInvestmentAccounts: vi.fn(async () => new Map([['co-1', { costId: 'cost', unrealizedId: 'unreal', fxId: 'fx', realizedId: 'gain-co' }]])),
}))

const inserted: any[] = []
const admin = {
  from: () => ({
    insert: (row: any) => { inserted.push(row); return { select: () => ({ single: async () => ({ data: { id: 'shares-new' }, error: null }) }) } },
  }),
} as any

const purchase = {
  id: 't2', company_id: 'co-1', portfolio_group: 'Fund I', transaction_date: '2026-07-31',
  transaction_type: 'investment', investment_cost: 600_000, consideration_in_kind: 600_000, round_name: 'Common',
}

describe('buildEntryForTransaction — a purchase paid in shares from an exit', () => {
  beforeEach(() => {
    inserted.length = 0
    vi.mocked(accountIdByCode).mockResolvedValue(new Map([['1000', 'cash'], ['1360', 'shares']]))
  })

  it('credits 1360 instead of cash', async () => {
    const r: any = await buildEntryForTransaction(admin, 'f1', purchase, 'Northwind')
    expect(r.entry.postings).toEqual([
      expect.objectContaining({ accountId: 'cost', amount: 600_000 }),
      expect.objectContaining({ accountId: 'shares', amount: -600_000 }),
    ])
    expect(r.amount).toBe(0)
  })

  it('splits a purchase paid partly in cash', async () => {
    const r: any = await buildEntryForTransaction(admin, 'f1', { ...purchase, consideration_in_kind: 450_000 }, 'Northwind')
    expect(r.entry.postings).toEqual([
      expect.objectContaining({ accountId: 'cost', amount: 600_000 }),
      expect.objectContaining({ accountId: 'cash', amount: -150_000 }),
      expect.objectContaining({ accountId: 'shares', amount: -450_000 }),
    ])
  })

  it('adds 1360 to a chart that predates it', async () => {
    vi.mocked(accountIdByCode).mockResolvedValue(new Map([['1000', 'cash']]))
    const r: any = await buildEntryForTransaction(admin, 'f1', purchase, 'Northwind')
    expect(inserted[0]).toMatchObject({ code: '1360', vehicle_id: 'veh-1', type: 'asset' })
    expect(r.entry.postings[1]).toMatchObject({ accountId: 'shares-new', amount: -600_000 })
  })
})

describe('inKindExceeds', () => {
  it('refuses shares plus escrow beyond the gross, and shares beyond a purchase cost', () => {
    expect(inKindExceeds({ transaction_type: 'proceeds', proceeds_received: 100, proceeds_escrow: 30, consideration_in_kind: 80 })).toMatch(/larger/)
    expect(inKindExceeds({ transaction_type: 'proceeds', proceeds_received: 100, proceeds_escrow: 20, consideration_in_kind: 80 })).toBeNull()
    expect(inKindExceeds({ transaction_type: 'investment', investment_cost: 50, consideration_in_kind: 60 })).toMatch(/larger/)
    expect(inKindExceeds({ transaction_type: 'unrealized_gain_change', consideration_in_kind: 1 })).toMatch(/applies only/)
  })
})
