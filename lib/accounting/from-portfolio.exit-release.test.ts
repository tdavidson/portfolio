import { describe, it, expect, vi, beforeEach } from 'vitest'

// A holding the fund no longer owns carries no marks. A write-off booked first and a mark-to-zero
// back-filled before it afterwards used to leave the markdown on 1200: the exit's entry was already
// frozen, and a closed holding has no later entry to true it up. The loss then counted twice, once
// as unrealized and again inside the realized loss on full cost.
const h = vi.hoisted(() => ({
  persistEntry: vi.fn(), postings: [] as any[], txns: [] as any[],
}))
vi.mock('./vehicle-id', () => ({ vehicleIdByName: async () => 'v', ensureVehiclesByName: vi.fn() }))
vi.mock('./vehicle-domain', () => ({ vehicleKindByName: async () => 'fund' }))
vi.mock('./provision-accounts', () => ({ ensureVehicleAccounts: vi.fn() }))
vi.mock('./persist', () => ({
  accountIdByCode: async () => new Map([['1000', 'cash'], ['4000', 'gain4000'], ['4200', 'inc4200'], ['4300', 'inc4300']]),
  persistEntry: h.persistEntry,
}))
vi.mock('./investments', () => ({ ensureInvestmentAccounts: async () => new Map([['co', { costId: 'cost', unrealizedId: 'unr', fxId: 'fx', realizedId: 'gain' }]]) }))
vi.mock('./load', () => ({ loadPostedLedger: async () => ({ postings: h.postings, sourcedPostings: h.postings }) }))
vi.mock('./periods', () => ({ closedPeriodRanges: async () => [], dateInAnyClosedPeriod: () => false }))
vi.mock('./investment-bank-match', () => ({ linkOpenBankRow: vi.fn(async () => null) }))
import { draftEntryForTransaction, releaseMarksAfterLastExit, exitReleaseRef } from './from-portfolio'

const admin = {
  from: (table: string) => {
    const q: any = { select: () => q, eq: () => q, like: () => q, then: (r: any) => r({ data: table === 'investment_transactions' ? h.txns : [], error: null }) }
    return q
  },
} as any

const G = 'Example Fund I'
const seed = { id: 's', company_id: 'co', transaction_type: 'investment', transaction_date: '2019-06-01', portfolio_group: G, round_name: 'Seed', investment_cost: 500_000 }
const seriesA = { id: 'a', company_id: 'co', transaction_type: 'investment', transaction_date: '2021-03-01', portfolio_group: G, round_name: 'Series A', investment_cost: 200_000 }
const writeOffSeed = { id: 'x', company_id: 'co', transaction_type: 'proceeds', transaction_date: '2025-12-31', portfolio_group: G, round_name: 'Seed', cost_basis_exited: 500_000, proceeds_received: 0 }
const markToZero = { id: 'm', company_id: 'co', transaction_type: 'unrealized_gain_change', transaction_date: '2025-05-09', portfolio_group: G, round_name: 'Seed', unrealized_value_change: -500_000, current_share_price: null }

const sum = (postings: any[], account: string) => postings.filter(p => p.accountId === account).reduce((s, p) => s + p.amount, 0)
const entries = () => h.persistEntry.mock.calls.map(c => c[4])
const balance = (account: string) => sum(h.postings, account)

let n = 0
beforeEach(() => {
  n = 0
  // Every persisted entry lands in the ledger the next read sees, as the real one does.
  h.persistEntry.mockReset().mockImplementation(async (_a: any, _f: any, _g: any, _u: any, entry: any) => {
    const entryId = `new${++n}`
    for (const p of entry.postings) h.postings.push({ entryId, accountId: p.accountId, amount: p.amount, entryDate: entry.entryDate })
    return { entryId }
  })
  h.txns = [seed, writeOffSeed, markToZero]
  // The Seed was bought, then written off on full cost before any mark was recorded.
  h.postings = [
    { entryId: 'buy', accountId: 'cost', amount: 500_000, entryDate: '2019-06-01' },
    { entryId: 'wo', accountId: 'cost', amount: -500_000, entryDate: '2025-12-31' },
    { entryId: 'wo', accountId: 'gain', amount: 500_000, entryDate: '2025-12-31' },
  ]
})

describe('a mark back-dated before a write-off already booked', () => {
  it('releases the markdown on the write-off date, so cost and unrealized both end at zero', async () => {
    const r = await draftEntryForTransaction(admin, 'f', 'u', markToZero, 'Acme')
    expect(r).toMatchObject({ drafted: true, posted: true, kind: 'valuation' })
    expect(r.warning).toBeUndefined()

    const [mark, release] = entries()
    expect(sum(mark.postings, 'unr')).toBe(-500_000)
    expect(release).toMatchObject({ entryDate: '2025-12-31', sourceType: 'valuation', sourceRef: exitReleaseRef('x') })
    // A reclassification: Cr the markdown off 1200, Dr it back out of 4200.
    expect(sum(release.postings, 'unr')).toBe(500_000)
    expect(sum(release.postings, 'inc4200')).toBe(-500_000)

    expect(balance('cost')).toBe(0)
    expect(balance('unr')).toBe(0)
    // The loss is counted once: realized on full cost, nothing left in unrealized.
    expect(balance('gain') + balance('inc4200')).toBe(500_000)
  })

  it('books the release back when the back-dated mark is removed', async () => {
    await draftEntryForTransaction(admin, 'f', 'u', markToZero, 'Acme')
    // The mark is deleted: its entry voided, the release left behind.
    h.postings = h.postings.filter(p => p.entryId !== 'new1')
    h.txns = [seed, writeOffSeed]
    h.persistEntry.mockClear()
    const r = await releaseMarksAfterLastExit(admin, 'f', 'u', { companyId: 'co', group: G, companyName: 'Acme' })
    expect(r).toMatchObject({ released: true, exitTxnId: 'x', amount: -500_000 })
    expect(balance('unr')).toBe(0)
    expect(balance('inc4200')).toBe(0)
  })

  it('also releases FX translation the books still carry', async () => {
    h.postings.push({ entryId: 'fxm', accountId: 'fx', amount: -1_000, entryDate: '2024-12-31' })
    await draftEntryForTransaction(admin, 'f', 'u', markToZero, 'Acme')
    const release = entries()[1]
    expect(sum(release.postings, 'fx')).toBe(1_000)
    expect(sum(release.postings, 'inc4300')).toBe(-1_000)
    expect(balance('fx')).toBe(0)
  })
})

describe('nothing is released', () => {
  it('when the exit leaves another round held: its marks are live', async () => {
    h.txns = [seed, seriesA, writeOffSeed, markToZero]
    h.postings.push({ entryId: 'buyA', accountId: 'cost', amount: 200_000, entryDate: '2021-03-01' })
    await draftEntryForTransaction(admin, 'f', 'u', { ...markToZero, round_name: 'Series A', unrealized_value_change: -150_000 }, 'Acme')
    expect(entries()).toHaveLength(1)
  })

  it('when the mark comes after the exit, or is the exit itself', async () => {
    const late = { ...markToZero, id: 'late', transaction_date: '2026-01-15' }
    h.txns = [seed, writeOffSeed, late]
    expect(await releaseMarksAfterLastExit(admin, 'f', 'u', { companyId: 'co', group: G, companyName: 'Acme', after: late })).toEqual({ released: false })
    expect(await releaseMarksAfterLastExit(admin, 'f', 'u', { companyId: 'co', group: G, companyName: 'Acme', after: writeOffSeed })).toEqual({ released: false })
  })

  it('when the books still carry cost for the holding', async () => {
    h.postings = h.postings.filter(p => p.entryId !== 'wo')
    await draftEntryForTransaction(admin, 'f', 'u', markToZero, 'Acme')
    expect(entries()).toHaveLength(1)
  })
})
