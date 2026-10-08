import { describe, it, expect, vi, beforeEach } from 'vitest'

/**
 * Every derived entry posts (plans/spec-ledger-one-writer.md §2); the only draft left is the
 * allocation-failure fallback.
 */
// ---- Wiring: draftEntryForTransaction posts. ------------------
import { draftEntryForTransaction } from './from-portfolio'
import { persistEntry } from './persist'

vi.mock('./persist', () => ({
  accountIdByCode: vi.fn(async () => new Map([['1000', 'cash-1000'], ['4200', 'unreal-income'], ['4300', 'fx-income']])),
  persistEntry: vi.fn(async () => ({ entryId: 'e1' })),
}))
vi.mock('./vehicle-id', () => ({ vehicleIdByName: vi.fn(async () => 'veh-1'), ensureVehiclesByName: vi.fn() }))
vi.mock('./vehicle-domain', () => ({ vehicleKindByName: vi.fn(async () => 'fund') }))
vi.mock('./provision-accounts', () => ({ ensureVehicleAccounts: vi.fn() }))
vi.mock('./investments', () => ({
  ensureInvestmentAccounts: vi.fn(async () => new Map([['co-1', { costId: 'cost', unrealizedId: 'unreal', fxId: 'fx' }]])),
}))

const admin = {} as any
const base = { id: 't1', company_id: 'co-1', portfolio_group: 'Fund I', transaction_date: '2026-06-30' }

describe('draftEntryForTransaction — disposition', () => {
  beforeEach(() => { vi.mocked(persistEntry).mockClear() })

  it('posts a mark and says so', async () => {
    const r = await draftEntryForTransaction(admin, 'f1', 'u1', { ...base, transaction_type: 'unrealized_gain_change', unrealized_value_change: 250 }, 'Acme')
    expect(vi.mocked(persistEntry).mock.calls[0][5]).toBe('posted')
    expect(r).toMatchObject({ drafted: true, posted: true, entryId: 'e1' })
  })

  it('posts a purchase', async () => {
    const r = await draftEntryForTransaction(admin, 'f1', 'u1', { ...base, transaction_type: 'investment', investment_cost: 1000 }, 'Acme')
    expect(vi.mocked(persistEntry).mock.calls[0][5]).toBe('posted')
    expect(r).toMatchObject({ drafted: true, posted: true })
  })

  it('keeps a mark as a draft when its partner allocation fails, rather than losing it', async () => {
    vi.mocked(persistEntry)
      .mockResolvedValueOnce({ error: 'Entry was not posted because its partner allocation failed: No partner participates.', allocationFailed: true } as any)
      .mockResolvedValueOnce({ entryId: 'e2' })
    const r = await draftEntryForTransaction(admin, 'f1', 'u1', { ...base, transaction_type: 'unrealized_gain_change', unrealized_value_change: 250 }, 'Acme')
    expect(vi.mocked(persistEntry).mock.calls.map(c => c[5])).toEqual(['posted', 'draft'])
    expect(r).toMatchObject({ drafted: true, posted: false, entryId: 'e2', reason: expect.stringMatching(/No partner participates/) })
  })

  it('surfaces a closed-period refusal of a mark instead of swallowing it', async () => {
    vi.mocked(persistEntry).mockResolvedValueOnce({ error: 'Period closed through 2026-06-30.' })
    const r = await draftEntryForTransaction(admin, 'f1', 'u1', { ...base, transaction_type: 'unrealized_gain_change', unrealized_value_change: 250 }, 'Acme')
    expect(r).toMatchObject({ drafted: false, reason: 'Period closed through 2026-06-30.' })
  })
})
