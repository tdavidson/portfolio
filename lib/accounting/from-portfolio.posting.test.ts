import { describe, it, expect, vi, beforeEach } from 'vitest'

const h = vi.hoisted(() => ({
  vehicleIdByName: vi.fn(), ensureVehiclesByName: vi.fn(), vehicleKindByName: vi.fn(),
  accountIdByCode: vi.fn(), ensureVehicleAccounts: vi.fn(), persistEntry: vi.fn(),
}))
vi.mock('./vehicle-id', () => ({ vehicleIdByName: h.vehicleIdByName, ensureVehiclesByName: h.ensureVehiclesByName }))
vi.mock('./vehicle-domain', () => ({ vehicleKindByName: h.vehicleKindByName }))
vi.mock('./provision-accounts', () => ({ ensureVehicleAccounts: h.ensureVehicleAccounts }))
vi.mock('./persist', () => ({ accountIdByCode: h.accountIdByCode, persistEntry: h.persistEntry }))
vi.mock('./investments', () => ({ ensureInvestmentAccounts: async () => new Map([['co', { costId: 'cost', unrealizedId: 'unr', fxId: 'fx', realizedId: 'gain' }]]) }))
vi.mock('./load', () => ({ loadPostedLedger: async () => ({ postings: [] }) }))
vi.mock('./periods', () => ({ closedPeriodRanges: async () => [], dateInAnyClosedPeriod: () => false }))
vi.mock('./investment-bank-match', () => ({ linkOpenBankRow: vi.fn(async () => null) }))
import { draftEntryForTransaction } from './from-portfolio'

const admin = { from: () => { const q: any = { select: () => q, eq: () => q, like: () => q, then: (r: any) => r({ data: [], error: null }) }; return q } } as any
const codes = new Map([['1000', 'cash'], ['4200', 'inc4200']])
const purchase = { id: 't1', company_id: 'co', transaction_type: 'investment', transaction_date: '2026-03-01', portfolio_group: 'Fund I', investment_cost: 1000 }

beforeEach(() => {
  for (const f of Object.values(h)) f.mockReset()
  h.vehicleIdByName.mockResolvedValue('v')
  h.vehicleKindByName.mockResolvedValue('fund')
  h.accountIdByCode.mockResolvedValue(codes)
  h.persistEntry.mockResolvedValue({ entryId: 'e1' })
})

describe('draftEntryForTransaction posts every entry', () => {
  it('posts a purchase on record', async () => {
    expect(await draftEntryForTransaction(admin, 'f', 'u', purchase, 'Acme')).toMatchObject({ drafted: true, posted: true, entryId: 'e1', kind: 'investment' })
    expect(h.persistEntry).toHaveBeenCalledWith(admin, 'f', 'Fund I', 'u', expect.objectContaining({ sourceRef: 'txn:t1' }), 'posted')
  })
  it('keeps a draft, and says why, only when the partner allocation fails', async () => {
    h.persistEntry.mockResolvedValueOnce({ error: 'No partner participates', allocationFailed: true }).mockResolvedValueOnce({ entryId: 'd1' })
    expect(await draftEntryForTransaction(admin, 'f', 'u', purchase, 'Acme')).toMatchObject({ drafted: true, posted: false, entryId: 'd1', reason: 'No partner participates' })
  })
  it('creates an entity it has never seen, then books to it', async () => {
    h.vehicleIdByName.mockResolvedValueOnce(null).mockResolvedValue('v')
    await draftEntryForTransaction(admin, 'f', 'u', { ...purchase, portfolio_group: 'New Fund' }, 'Acme')
    expect(h.ensureVehiclesByName).toHaveBeenCalledWith(admin, 'f', ['New Fund'])
    expect(h.persistEntry).toHaveBeenCalled()
  })
  it('seeds a chart for an entity that has none, then books', async () => {
    h.accountIdByCode.mockResolvedValueOnce(new Map()).mockResolvedValue(codes)
    expect(await draftEntryForTransaction(admin, 'f', 'u', purchase, 'Acme')).toMatchObject({ posted: true })
    expect(h.ensureVehicleAccounts).toHaveBeenCalledWith(admin, 'f', 'Fund I')
  })
  it('refuses a management company and a GP entity, writing nothing', async () => {
    h.vehicleKindByName.mockResolvedValueOnce('manco')
    expect(await draftEntryForTransaction(admin, 'f', 'u', purchase, 'Acme')).toEqual({ drafted: false, reason: expect.stringMatching(/management company/) })
    h.vehicleKindByName.mockResolvedValueOnce('associate')
    expect(await draftEntryForTransaction(admin, 'f', 'u', purchase, 'Acme')).toEqual({ drafted: false, reason: expect.stringMatching(/GP entity/) })
    expect(h.persistEntry).not.toHaveBeenCalled()
  })
})
