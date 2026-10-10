import { describe, it, expect, vi, beforeEach } from 'vitest'

// A mark recorded as a share price books the change in value it implies — the records' value of the
// position on the mark's date, less what the books carried for it then (not counting its own entry).
const h = vi.hoisted(() => ({
  persistEntry: vi.fn(), postings: [] as any[], txns: [] as any[],
}))
vi.mock('./vehicle-id', () => ({ vehicleIdByName: async () => 'v', ensureVehiclesByName: vi.fn() }))
vi.mock('./vehicle-domain', () => ({ vehicleKindByName: async () => 'fund' }))
vi.mock('./provision-accounts', () => ({ ensureVehicleAccounts: vi.fn() }))
vi.mock('./persist', () => ({ accountIdByCode: async () => new Map([['1000', 'cash'], ['4200', 'inc4200']]), persistEntry: h.persistEntry }))
vi.mock('./investments', () => ({ ensureInvestmentAccounts: async () => new Map([['co', { costId: 'cost', unrealizedId: 'unr', fxId: 'fx', realizedId: 'gain' }]]) }))
vi.mock('./load', () => ({ loadPostedLedger: async () => ({ postings: h.postings, sourcedPostings: h.postings }) }))
vi.mock('./periods', () => ({ closedPeriodRanges: async () => [], dateInAnyClosedPeriod: () => false }))
vi.mock('./investment-bank-match', () => ({ linkOpenBankRow: vi.fn(async () => null) }))
import { draftEntryForTransaction } from './from-portfolio'
import { impliesNoEntry } from './investment-backfill'

const admin = {
  from: (table: string) => {
    const q: any = { select: () => q, eq: () => q, like: () => q, then: (r: any) => r({ data: table === 'investment_transactions' ? h.txns : [], error: null }) }
    return q
  },
} as any

const seed = { id: 'a', company_id: 'co', transaction_type: 'investment', transaction_date: '2018-02-06', portfolio_group: 'Fund II', round_name: 'Seed', investment_cost: 500000, shares_acquired: 1082719, share_price: 0.4618 }
const seriesA = { id: 'b', company_id: 'co', transaction_type: 'investment', transaction_date: '2019-05-15', portfolio_group: 'Fund II', round_name: 'Series A', investment_cost: 500001, shares_acquired: 254754, share_price: 1.9627 }
const mark = { id: 'm', company_id: 'co', transaction_type: 'unrealized_gain_change', transaction_date: '2019-05-15', portfolio_group: 'Fund II', round_name: 'Series A', current_share_price: 1.9627, unrealized_value_change: null }

beforeEach(() => {
  h.persistEntry.mockReset().mockResolvedValue({ entryId: 'e1' })
  h.txns = [seed, seriesA, mark]
  // Both purchases are on the books at cost.
  h.postings = [
    { entryId: 'p1', accountId: 'cost', amount: 500000, entryDate: '2018-02-06' },
    { entryId: 'p2', accountId: 'cost', amount: 500001, entryDate: '2019-05-15' },
    // A later entry must not count against a 2019 mark.
    { entryId: 'p3', accountId: 'cost', amount: 649993, entryDate: '2023-02-10' },
  ]
})

describe('a share-price mark', () => {
  it('books the value the price implies over what the books carried on that date', async () => {
    const r = await draftEntryForTransaction(admin, 'f', 'u', mark, 'Ocrolus')
    expect(r).toMatchObject({ drafted: true, posted: true, kind: 'valuation' })
    const entry = h.persistEntry.mock.calls[0][4]
    // (1,082,719 + 254,754) × 1.9627 = 2,625,058.26, less 1,000,001 of cost.
    expect(entry.postings).toEqual([
      expect.objectContaining({ accountId: 'unr', amount: 1625057.26 }),
      expect.objectContaining({ accountId: 'inc4200', amount: -1625057.26 }),
    ])
  })

  it('books nothing once the books already carry that value', async () => {
    h.postings.push({ entryId: 'old', accountId: 'unr', amount: 1625057.26, entryDate: '2019-05-15' })
    expect(await draftEntryForTransaction(admin, 'f', 'u', mark, 'Ocrolus')).toMatchObject({ drafted: false })
    expect(h.persistEntry).not.toHaveBeenCalled()
  })

  it('is waiting for the books in a backfill, where a price-less, value-less mark is not', () => {
    expect(impliesNoEntry(mark)).toBe(false)
    expect(impliesNoEntry({ ...mark, current_share_price: null })).toBe(true)
  })
})

const sum = (postings: any[], account: string) => postings.filter(p => p.accountId === account).reduce((s, p) => s + p.amount, 0)

describe('every derived entry keeps the books at the records', () => {
  it('a purchase at a new round price revalues the shares already held (Yuvo)', async () => {
    const seed1 = { id: 'y1', company_id: 'co', transaction_type: 'investment', transaction_date: '2022-01-14', portfolio_group: 'Fund III', round_name: 'Seed-1', investment_cost: 300000, shares_acquired: 13036, share_price: 23.013194 }
    const a2 = { id: 'y2', company_id: 'co', transaction_type: 'investment', transaction_date: '2024-11-25', portfolio_group: 'Fund III', round_name: 'A-2', investment_cost: 249985, shares_acquired: 6727, share_price: 37.1614 }
    h.txns = [seed1, a2]
    h.postings = [{ entryId: 'p1', accountId: 'cost', amount: 300000, entryDate: '2022-01-14' }]
    await draftEntryForTransaction(admin, 'f', 'u', a2, 'Yuvo')
    const postings = h.persistEntry.mock.calls[0][4].postings
    expect(sum(postings, 'cost')).toBe(249985)
    // 13,036 Seed-1 shares from $23.01 to $37.16.
    expect(sum(postings, 'unr')).toBeCloseTo(13036 * (37.1614 - 23.013194), 0)
    expect(sum(postings, 'inc4200')).toBeCloseTo(-13036 * (37.1614 - 23.013194), 0)
  })

  it('a purchase into a new company books cost and nothing else', async () => {
    h.txns = [seed]
    h.postings = []
    await draftEntryForTransaction(admin, 'f', 'u', seed, 'Ocrolus')
    expect(sum(h.persistEntry.mock.calls[0][4].postings, 'unr')).toBe(0)
  })

  it("an exit reverses only the marks that left with it — not other rounds' (AutoFi)", async () => {
    const seedPref = { id: 'x1', company_id: 'co', transaction_type: 'investment', transaction_date: '2015-11-04', portfolio_group: 'Fund I', round_name: 'Seed Preferred', investment_cost: 187500, shares_acquired: 386614 }
    const common = { id: 'x2', company_id: 'co', transaction_type: 'investment', transaction_date: '2016-10-07', portfolio_group: 'Fund I', round_name: 'Common', investment_cost: 300001, shares_acquired: 705360 }
    const markCommon = { id: 'x3', company_id: 'co', transaction_type: 'unrealized_gain_change', transaction_date: '2022-04-30', portfolio_group: 'Fund I', round_name: 'Common', unrealized_value_change: 3325550 }
    const exit = { id: 'x4', company_id: 'co', transaction_type: 'proceeds', transaction_date: '2022-05-02', portfolio_group: 'Fund I', round_name: 'Seed Preferred', cost_basis_exited: 117917, proceeds_received: 3369126 }
    h.txns = [seedPref, common, markCommon, exit]
    h.postings = [
      { entryId: 'a', accountId: 'cost', amount: 187500, entryDate: '2015-11-04' },
      { entryId: 'b', accountId: 'cost', amount: 300001, entryDate: '2016-10-07' },
      { entryId: 'c', accountId: 'unr', amount: 3325550, entryDate: '2022-04-30' },
    ]
    await draftEntryForTransaction(admin, 'f', 'u', exit, 'AutoFi')
    const postings = h.persistEntry.mock.calls[0][4].postings
    expect(sum(postings, 'cost')).toBe(-117917)
    // The Common mark stays whole: the exit sold Seed Preferred, which had none.
    expect(sum(postings, 'unr')).toBeCloseTo(0, 2)
  })

  it('a company-wide share price revalues every vehicle that holds the company, each under the same record', async () => {
    const inI = { ...seed, id: 'i1', portfolio_group: 'Fund I' }
    const inIII = { ...seed, id: 'i3', portfolio_group: 'Fund III' }
    const wide = { id: 'w', company_id: 'co', transaction_type: 'unrealized_gain_change', transaction_date: '2026-02-02', portfolio_group: null, current_share_price: 2 }
    h.txns = [inI, inIII, wide]
    h.postings = [{ entryId: 'p', accountId: 'cost', amount: 500000, entryDate: '2018-02-06' }]
    await draftEntryForTransaction(admin, 'f', 'u', wide, 'Ocrolus')
    const groups = h.persistEntry.mock.calls.map(c => c[2]).sort()
    expect(groups).toEqual(['Fund I', 'Fund III'])
    for (const c of h.persistEntry.mock.calls) {
      expect(c[4].sourceRef).toBe('txn:w')
      // 1,082,719 shares at $2, over $500,000 of cost.
      expect(sum(c[4].postings, 'unr')).toBeCloseTo(1082719 * 2 - 500000, 2)
    }
  })
})
