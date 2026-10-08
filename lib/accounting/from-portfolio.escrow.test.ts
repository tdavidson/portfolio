import { describe, it, expect, vi, beforeEach } from 'vitest'
import { buildEntryForTransaction } from './from-portfolio'
import { accountIdByCode } from './persist'
import { impliesNoEntry } from './investment-backfill'

/**
 * An escrow receipt clears the receivable the exit recognized: cash in, 1350 down by the same
 * amount. A chart without 1350 never recognized the escrow, so the receipt is gain on the exit.
 */
vi.mock('./persist', () => ({ accountIdByCode: vi.fn(), persistEntry: vi.fn() }))
vi.mock('./vehicle-id', () => ({ vehicleIdByName: vi.fn(async () => 'veh-1'), ensureVehiclesByName: vi.fn() }))
vi.mock('./vehicle-domain', () => ({ vehicleKindByName: vi.fn(async () => 'fund') }))
vi.mock('./provision-accounts', () => ({ ensureVehicleAccounts: vi.fn() }))
vi.mock('./investments', () => ({
  ensureInvestmentAccounts: vi.fn(async () => new Map([['co-1', { costId: 'cost', unrealizedId: 'unreal', fxId: 'fx', realizedId: 'gain-co' }]])),
}))

const admin = {} as any
const receipt = {
  id: 't1', company_id: 'co-1', portfolio_group: 'Fund I', transaction_date: '2026-07-31',
  transaction_type: 'escrow_receipt', proceeds_received: 12500, round_name: 'Seed',
}

describe('buildEntryForTransaction — escrow receipt', () => {
  beforeEach(() => {
    vi.mocked(accountIdByCode).mockResolvedValue(new Map([['1000', 'cash'], ['1350', 'escrow'], ['4000', 'gain']]))
  })

  it('debits cash and credits the escrow receivable by the amount received', async () => {
    const r: any = await buildEntryForTransaction(admin, 'f1', receipt, 'Acme')
    expect(r.entry.postings).toEqual([
      expect.objectContaining({ accountId: 'cash', amount: 12500 }),
      expect.objectContaining({ accountId: 'escrow', amount: -12500 }),
    ])
    expect(r.entry.memo).toBe('Escrow received — Acme (Seed)')
    expect(r.entry.sourceRef).toBe('txn:t1')
    expect(r).toMatchObject({ kind: 'proceeds', amount: 12500 })
  })

  it('books the receipt as gain when the chart has no escrow receivable (the exit never recognized it)', async () => {
    vi.mocked(accountIdByCode).mockResolvedValue(new Map([['1000', 'cash'], ['4000', 'gain']]))
    const r: any = await buildEntryForTransaction(admin, 'f1', receipt, 'Acme')
    expect(r.entry.postings[1]).toMatchObject({ accountId: 'gain-co', amount: -12500 })
  })

  it('books nothing when nothing was received', async () => {
    const r: any = await buildEntryForTransaction(admin, 'f1', { ...receipt, proceeds_received: 0 }, 'Acme')
    expect(r.skip).toBeTruthy()
    expect(impliesNoEntry({ ...receipt, proceeds_received: 0 })).toBe(true)
    expect(impliesNoEntry(receipt)).toBe(false)
  })
})
