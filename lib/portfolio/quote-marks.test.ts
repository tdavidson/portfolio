// lib/portfolio/quote-marks.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { memoryAdmin } from '@/tests/helpers/memory-admin'

const h = vi.hoisted(() => ({
  vehicleIdByName: vi.fn(), ensureVehiclesByName: vi.fn(), vehicleKindByName: vi.fn(),
  accountIdByCode: vi.fn(), ensureVehicleAccounts: vi.fn(), persistEntry: vi.fn(),
  carrying: { 'Fund I': 1000, 'Fund II': 2000 } as Record<string, number>,
}))
// The layers under derivation, as lib/accounting/from-portfolio.posting.test.ts mocks them, so the
// real draftEntryForTransaction builds the entry and we see what it posts.
vi.mock('@/lib/accounting/vehicle-id', () => ({ vehicleIdByName: h.vehicleIdByName, ensureVehiclesByName: h.ensureVehiclesByName }))
vi.mock('@/lib/accounting/vehicle-domain', () => ({ vehicleKindByName: h.vehicleKindByName }))
vi.mock('@/lib/accounting/provision-accounts', () => ({ ensureVehicleAccounts: h.ensureVehicleAccounts }))
vi.mock('@/lib/accounting/persist', () => ({ accountIdByCode: h.accountIdByCode, persistEntry: h.persistEntry }))
vi.mock('@/lib/accounting/investments', () => ({ ensureInvestmentAccounts: async () => new Map([['co', { costId: 'cost', unrealizedId: 'unr', fxId: 'fx', realizedId: 'gain' }]]) }))
vi.mock('@/lib/accounting/load', () => ({
  // What each entity's ledger carries for the holding: its 1100-<id> cost, nothing marked yet.
  loadPostedLedger: async (_a: unknown, _f: string, group: string) => ({
    accounts: [{ id: 'cost', companyId: 'co', subtype: 'investment' }],
    postings: [{ accountId: 'cost', amount: h.carrying[group] ?? 0 }],
  }),
}))
vi.mock('@/lib/accounting/periods', () => ({ closedPeriodRanges: async () => [], dateInAnyClosedPeriod: () => false }))
vi.mock('@/lib/accounting/investment-bank-match', () => ({ linkOpenBankRow: vi.fn(async () => null) }))
import { bookQuoteMark, quoteMarkForHolding } from './quote-marks'

const seed = (o: { currency?: string; quoteCurrency?: string; observations?: any[]; maxRows?: number } = {}) => memoryAdmin({
  fund_settings: [{ fund_id: 'f', currency: o.currency ?? 'USD' }],
  companies: [{ id: 'co', fund_id: 'f', name: 'Ether', holding_type: 'crypto', status: 'active', industry: null, stage: null, portfolio_group: ['Fund I', 'Fund II'] }],
  price_feeds: [{ id: 'pf', fund_id: 'f', company_id: 'co', kind: 'digital_asset', symbol: 'ETH', quote_currency: o.quoteCurrency ?? 'USD', quote_scale: 1, active_from: '2026-01-01', created_at: '2026-01-01T00:00:00Z' }],
  price_observations: o.observations ?? [{ id: 'o1', fund_id: 'f', feed_id: 'pf', as_of_date: '2026-03-31', price: 150, basis: 'close' }],
  investment_transactions: [
    { id: 'i1', fund_id: 'f', company_id: 'co', transaction_type: 'investment', transaction_date: '2026-01-15', portfolio_group: 'Fund I', investment_cost: 1000, shares_acquired: 10, share_price: 100, round_name: null },
    { id: 'i2', fund_id: 'f', company_id: 'co', transaction_type: 'investment', transaction_date: '2026-01-15', portfolio_group: 'Fund II', investment_cost: 2000, shares_acquired: 20, share_price: 100, round_name: null },
  ],
}, { maxRows: o.maxRows })
const quoteMarks = (m: ReturnType<typeof seed>) =>
  m.tables.investment_transactions.filter((t: any) => t.transaction_type === 'unrealized_gain_change')

/** The memory admin, but one table's reads fail — as a dropped connection or a revoked grant would. */
const failingReads = (m: ReturnType<typeof seed>, table: string) => ({
  ...m.admin,
  from: (t: string) => {
    const q = m.admin.from(t)
    if (t !== table) return q
    const err = { data: null, error: { message: 'connection reset' } }
    const failing: any = new Proxy(q, {
      get: (target, prop) => {
        if (prop === 'then') return (res: any, rej: any) => Promise.resolve(err).then(res, rej)
        if (prop === 'maybeSingle' || prop === 'single') return async () => err
        const v = target[prop]
        return typeof v === 'function' ? (...a: unknown[]) => { v(...a); return failing } : v
      },
    })
    return failing
  },
})

beforeEach(() => {
  for (const f of [h.vehicleIdByName, h.ensureVehiclesByName, h.vehicleKindByName, h.accountIdByCode, h.ensureVehicleAccounts, h.persistEntry]) f.mockReset()
  h.vehicleIdByName.mockResolvedValue('v1')
  h.vehicleKindByName.mockResolvedValue('fund')
  h.accountIdByCode.mockResolvedValue(new Map([['1000', 'cash'], ['4200', 'inc4200']]))
  h.persistEntry.mockResolvedValue({ entryId: 'e1' })
  h.carrying['Fund I'] = 1000
})

describe('quoteMarkForHolding', () => {
  it("values one entity's units at the quote against what that entity's ledger carries", async () => {
    const { mark } = await quoteMarkForHolding(seed().admin, 'f', 'co', 'Fund I', '2026-03-31')
    expect(mark).toMatchObject({ shares: 10, price: 150, derivedCarrying: 1500, ledgerCarrying: 1000, delta: 500 })
  })

  it('refuses rather than computing a mark from a read that failed', async () => {
    const m = seed()
    expect(await quoteMarkForHolding(failingReads(m, 'investment_transactions') as any, 'f', 'co', 'Fund I', '2026-03-31'))
      .toEqual({ mark: null, problem: expect.stringMatching(/^Could not read .*connection reset/) })
  })

  it('prices from the latest quote on or before the date even when the feed holds more quotes than the row cap', async () => {
    // A daily feed since 2020, stored oldest first: an unordered read would stop at the 1000th
    // row (late 2022) and mark at that price.
    const observations = Array.from({ length: 2400 }, (_, i) => ({
      fund_id: 'f', feed_id: 'pf', as_of_date: new Date(Date.UTC(2020, 0, 1) + i * 86_400_000).toISOString().slice(0, 10),
      price: i < 2000 ? 100 : 150, basis: 'close',
    }))
    const { mark } = await quoteMarkForHolding(seed({ observations, maxRows: 1000 }).admin, 'f', 'co', 'Fund I', '2026-03-31')
    expect(mark).toMatchObject({ price: 150, quoteDate: '2026-03-31' })
  })

  it('refuses rather than marking when the quotes cannot be read', async () => {
    const m = seed()
    m.failNext('price_observations', 'select', 'boom')
    expect(await quoteMarkForHolding(m.admin, 'f', 'co', 'Fund I', '2026-03-31'))
      .toEqual({ mark: null, problem: expect.stringMatching(/^Could not read the ETH quotes.*boom/) })
  })

  it('refuses an entity that is not one of the fund\'s', async () => {
    h.vehicleIdByName.mockResolvedValue(null)
    expect(await quoteMarkForHolding(seed().admin, 'f', 'co', 'Fund IX', '2026-03-31'))
      .toEqual({ mark: null, problem: expect.stringMatching(/Fund IX/) })
  })
})

describe('bookQuoteMark', () => {
  it('records a quote mark for that entity alone, and derives and posts it', async () => {
    const m = seed()
    expect(await bookQuoteMark(m.admin, 'f', 'u', 'co', 'Fund I', '2026-03-31'))
      .toMatchObject({ booked: true, ledger: { drafted: true, posted: true, entryId: 'e1' } })
    const marks = quoteMarks(m)
    expect(marks).toHaveLength(1)
    expect(marks[0]).toMatchObject({ portfolio_group: 'Fund I', valuation_change_source: 'quote', unrealized_value_change: 500, current_share_price: 150, transaction_date: '2026-03-31' })
    expect(h.persistEntry).toHaveBeenCalledTimes(1)
    expect(h.persistEntry).toHaveBeenCalledWith(m.admin, 'f', 'Fund I', 'u', expect.objectContaining({
      sourceRef: `txn:${marks[0].id}`,
      postings: [expect.objectContaining({ accountId: 'unr', amount: 500 }), expect.objectContaining({ accountId: 'inc4200', amount: -500 })],
    }), 'posted')
  })

  it('removes the mark again when the ledger refuses it, so the tracker never runs ahead of the books', async () => {
    h.persistEntry.mockResolvedValue({ error: 'That date is in a closed period.' })
    const m = seed()
    expect(await bookQuoteMark(m.admin, 'f', 'u', 'co', 'Fund I', '2026-03-31')).toEqual({ booked: false, reason: 'That date is in a closed period.' })
    expect(quoteMarks(m)).toEqual([])
  })

  it('says so when the refused mark cannot be removed from the tracker', async () => {
    h.persistEntry.mockResolvedValue({ error: 'That date is in a closed period.' })
    const m = seed()
    m.failNext('investment_transactions', 'delete', 'permission denied')
    expect(await bookQuoteMark(m.admin, 'f', 'u', 'co', 'Fund I', '2026-03-31')).toEqual({
      booked: false,
      reason: expect.stringMatching(/That date is in a closed period\..*could not be removed.*permission denied/),
    })
  })

  it('refuses a second mark for the same entity and date, even when the first stayed a draft', async () => {
    // No partner participates yet: the entry is kept as a draft, which the posted ledger does not see.
    h.persistEntry
      .mockResolvedValueOnce({ error: 'No partner participates yet.', allocationFailed: true })
      .mockResolvedValueOnce({ entryId: 'd1' })
    const m = seed()
    expect(await bookQuoteMark(m.admin, 'f', 'u', 'co', 'Fund I', '2026-03-31'))
      .toMatchObject({ booked: true, ledger: { drafted: true, posted: false, entryId: 'd1' } })
    expect(await bookQuoteMark(m.admin, 'f', 'u', 'co', 'Fund I', '2026-03-31'))
      .toEqual({ booked: false, reason: 'A quoted mark is already booked for Fund I on 2026-03-31.' })
    expect(quoteMarks(m)).toHaveLength(1)
    expect(h.persistEntry).toHaveBeenCalledTimes(2)
  })

  it('refuses a mark dated before one already booked, which would count the later change twice', async () => {
    const observations = [
      { fund_id: 'f', feed_id: 'pf', as_of_date: '2026-03-31', price: 150, basis: 'close' },
      { fund_id: 'f', feed_id: 'pf', as_of_date: '2026-06-30', price: 200, basis: 'close' },
    ]
    const m = seed({ observations })
    expect(await bookQuoteMark(m.admin, 'f', 'u', 'co', 'Fund I', '2026-06-30')).toMatchObject({ booked: true })
    expect(await bookQuoteMark(m.admin, 'f', 'u', 'co', 'Fund I', '2026-03-31')).toEqual({
      booked: false, reason: 'Fund I already has a quoted mark dated after 2026-03-31. Reverse the 2026-06-30 mark first.',
    })
    expect(quoteMarks(m)).toHaveLength(1)
    // Another entity's later mark is its own: Fund II may still book March.
    expect(await bookQuoteMark(m.admin, 'f', 'u', 'co', 'Fund II', '2026-03-31')).toMatchObject({ booked: true })
  })

  it('refuses a quote in another currency rather than booking pence as pounds', async () => {
    const m = seed({ currency: 'USD', quoteCurrency: 'GBP' })
    expect(await bookQuoteMark(m.admin, 'f', 'u', 'co', 'Fund I', '2026-03-31'))
      .toEqual({ booked: false, reason: expect.stringMatching(/quoted in GBP/) })
    expect(h.persistEntry).not.toHaveBeenCalled()
    expect(quoteMarks(m)).toEqual([])
  })

  it('books nothing when the ledger already carries the quoted value', async () => {
    h.carrying['Fund I'] = 1500
    expect(await bookQuoteMark(seed().admin, 'f', 'u', 'co', 'Fund I', '2026-03-31'))
      .toEqual({ booked: false, reason: expect.stringMatching(/already carries/) })
  })
})
