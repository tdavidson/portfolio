import { describe, it, expect, vi } from 'vitest'
import { draftEntryForTransaction } from './from-portfolio'
import { persistEntry } from './persist'

/**
 * An exit must see the purchase's cost, or a partial exit unwinds the whole accumulated mark
 * (fraction = basis / 0 → 1) and freezes that wrong figure into its entry. The purchase is posted;
 * a purchase kept as an allocation-failure draft still counts, so both cases are covered.
 */
vi.mock('./persist', () => ({
  accountIdByCode: vi.fn(async () => new Map([
    ['1000', 'cash'], ['4000', 'gain'], ['4200', 'unreal-income'], ['4300', 'fx-income'],
  ])),
  persistEntry: vi.fn(async () => ({ entryId: 'exit-1' })),
}))
vi.mock('./vehicle-id', () => ({ vehicleIdByName: vi.fn(async () => 'veh-1'), ensureVehiclesByName: vi.fn() }))
vi.mock('./vehicle-domain', () => ({ vehicleKindByName: vi.fn(async () => 'fund') }))
vi.mock('./provision-accounts', () => ({ ensureVehicleAccounts: vi.fn() }))
vi.mock('./investments', () => ({
  ensureInvestmentAccounts: vi.fn(async () => new Map([['acme', { costId: 'cost', unrealizedId: 'unreal', fxId: 'fx' }]])),
}))
const posted = vi.hoisted(() => ({ postings: [] as { accountId: string; amount: number }[] }))
vi.mock('./load', () => ({ loadPostedLedger: vi.fn(async () => ({ postings: posted.postings })) }))

const mark = [{ accountId: 'unreal', amount: 3_000_000 }, { accountId: 'unreal-income', amount: -3_000_000 }]
const purchase = [{ accountId: 'cost', amount: 1_000_000 }, { accountId: 'cash', amount: -1_000_000 }]
const draftPurchase = [{ id: 'buy', journal_postings: [{ account_id: 'cost', amount: 1_000_000 }, { account_id: 'cash', amount: -1_000_000 }] }]
let drafts: any[] = []
const admin = {
  from: () => {
    const chain: any = { select: () => chain, eq: () => chain, neq: () => chain, like: () => chain, in: () => chain,
      then: (res: any) => res({ data: drafts, error: null }) }
    return chain
  },
} as any

const exit = {
  id: 'sell', company_id: 'acme', portfolio_group: 'Fund I', transaction_date: '2026-09-30',
  transaction_type: 'proceeds', proceeds_received: 2_000_000, cost_basis_exited: 500_000,
}
const unwound = async () => {
  await draftEntryForTransaction(admin, 'f1', 'u1', exit, 'Acme')
  const entry = vi.mocked(persistEntry).mock.calls[0][4]
  return entry.postings.filter(p => p.accountId === 'unreal').reduce((s, p) => s + p.amount, 0)
}

describe('exit against a posted purchase', () => {
  it('unwinds the mark pro-rata to the cost the posted purchase carries', async () => {
    vi.mocked(persistEntry).mockClear()
    posted.postings = [...mark, ...purchase]; drafts = []
    expect(await unwound()).toBe(-1_500_000) // half the position -> half the 3m mark, not all of it
  })
})

describe('exit while a fallback draft purchase still waits', () => {
  it('counts the draft purchase too', async () => {
    vi.mocked(persistEntry).mockClear()
    posted.postings = [...mark]; drafts = draftPurchase
    expect(await unwound()).toBe(-1_500_000)
  })
})
