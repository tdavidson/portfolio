import { describe, it, expect, vi } from 'vitest'
import { memoryAdmin } from '@/tests/helpers/memory-admin'
import { earliestPostingDate, computePayload, loadLedgerData, entityWalletsAsOf } from './statement-package'
import { loadWalletCloseInputs } from './close'

describe('earliestPostingDate', () => {
  it('returns the min entryDate, ignoring nulls', () => {
    expect(earliestPostingDate([
      { accountId: 'a', amount: 1, entryDate: '2026-03-01' } as any,
      { accountId: 'b', amount: -1, entryDate: '2025-11-15' } as any,
      { accountId: 'c', amount: 0, entryDate: null } as any,
    ])).toBe('2025-11-15')
  })
  it('returns null when there are no dated postings', () => {
    expect(earliestPostingDate([])).toBeNull()
    expect(earliestPostingDate([{ accountId: 'a', amount: 1, entryDate: null } as any])).toBeNull()
  })
})

describe('computePayload — fund-of-funds exhibits', () => {
  // A minimal LedgerData: the FoF block is what is under test, and every other statement
  // tolerates an empty ledger.
  const base = (fofRaw: any) => ({
    accounts: [], postings: [], capitalPostings: [], sourcedPostings: [],
    names: new Map(), txns: [], companies: [], group: 'Fund I',
    cashAccount: undefined, gpAccount: undefined, earliest: null, fofRaw,
  }) as any

  const period = { start: '2025-01-01', end: '2025-12-31', label: '2025' } as any

  it('omits the fof block entirely for a fund that holds no funds', () => {
    // The whole point of making it optional: a non-FoF package must be unchanged.
    const payload = computePayload(base(null), period)
    expect('fof' in payload).toBe(false)
  })

  it('includes the exhibits once the fund holds a fund', () => {
    const payload = computePayload(base({
      holdings: [{ id: 'f1', name: 'Acme Ventures III' }],
      terms: [{ company_id: 'f1', commitment: 5_000_000, vintage_year: 2021 }],
      events: [{ company_id: 'f1', kind: 'call', event_date: '2025-06-30', amount: 3_000_000 }],
      navs: [{ company_id: 'f1', as_of_date: '2025-09-30', reported_nav: 4_000_000, basis: 'final' }],
    }), period)

    expect(payload.fof).toBeDefined()
    expect(payload.fof!.commitments.totals.commitment).toBe(5_000_000)
    expect(payload.fof!.commitments.totals.called).toBe(3_000_000)
    expect(payload.fof!.commitments.totals.unfunded).toBe(2_000_000)
    expect(payload.fof!.performance.rows[0].name).toBe('Acme Ventures III')
    expect(payload.fof!.valuationNote[0].navAsOf).toBe('2025-09-30')
  })

  it('scopes the exhibits to the period end, not to today', () => {
    // A call after the reporting date must not appear in a statement for that period.
    const payload = computePayload(base({
      holdings: [{ id: 'f1', name: 'Acme Ventures III' }],
      terms: [{ company_id: 'f1', commitment: 5_000_000 }],
      events: [
        { company_id: 'f1', kind: 'call', event_date: '2025-06-30', amount: 1_000_000 },
        { company_id: 'f1', kind: 'call', event_date: '2026-06-30', amount: 2_000_000 },
      ],
      navs: [],
    }), period)
    expect(payload.fof!.commitments.totals.called).toBe(1_000_000)
  })
})

describe('loadLedgerData — on-chain balances', () => {
  const seed = () => ({
    fund_vehicles: [
      { id: 'v1', fund_id: 'F', name: 'Fund I', kind: 'fund' },
      { id: 'v2', fund_id: 'F', name: 'Fund II', kind: 'fund' },
    ],
    investment_transactions: [
      { id: 't1', fund_id: 'F', company_id: 'k1', transaction_type: 'investment', portfolio_group: 'Fund I', transaction_date: '2026-01-01' },
      { id: 't2', fund_id: 'F', company_id: 'k2', transaction_type: 'investment', portfolio_group: 'Fund I', transaction_date: '2026-01-01' },
      { id: 't3', fund_id: 'F', company_id: 'k2', transaction_type: 'investment', portfolio_group: 'Fund II', transaction_date: '2026-01-01' },
    ],
    crypto_wallets: [
      { id: 'w1', fund_id: 'F', company_id: 'k1', chain: 'ethereum', address: '0x1', active: true, portfolio_group: null },
      { id: 'w2', fund_id: 'F', company_id: 'k1', chain: 'ethereum', address: '0x2', active: true, portfolio_group: 'Fund II' },
      { id: 'w3', fund_id: 'F', company_id: 'k2', chain: 'ethereum', address: '0x3', active: true, portfolio_group: null },
      { id: 'w4', fund_id: 'F', company_id: 'k2', chain: 'ethereum', address: '0x4', active: true, portfolio_group: 'Fund I' },
    ],
    crypto_wallet_balances: [
      { fund_id: 'F', wallet_id: 'w1', as_of_date: '2026-03-31', units: 5 },
      { fund_id: 'F', wallet_id: 'w2', as_of_date: '2026-03-31', units: 7 },
      { fund_id: 'F', wallet_id: 'w4', as_of_date: '2026-03-31', units: 9 },
    ],
  })

  it("keeps only this entity's wallets: tagged to it, or untagged on a holding it alone holds", async () => {
    const { admin } = memoryAdmin(seed())
    const data = await loadLedgerData(admin as any, 'F', 'Fund I')
    // w1: untagged, k1 held only by Fund I. w2: Fund II's. w3: untagged on k2 held by both, so neither's.
    expect(entityWalletsAsOf(data, '2026-03-31').map(w => w.id).sort()).toEqual(['w1', 'w4'])
    expect(data.chainWarning).toBeUndefined()
    const other = await loadLedgerData(admin as any, 'F', 'Fund II')
    expect(entityWalletsAsOf(other, '2026-03-31').map(w => w.id)).toEqual(['w2'])
  })

  it("reads balances by wallet id, for the wallets that could be this entity's only", async () => {
    const { admin } = memoryAdmin(seed())
    const seen: unknown[] = []
    const realFrom = admin.from.bind(admin)
    ;(admin as any).from = (t: string) => {
      const q = realFrom(t)
      if (t !== 'crypto_wallet_balances') return q
      const realIn = q.in.bind(q)
      q.in = (col: string, vals: unknown[]) => { seen.push([col, vals]); return realIn(col, vals) }
      return q
    }
    const data = await loadLedgerData(admin as any, 'F', 'Fund I')
    // Never Fund II's tagged w2; the untagged w3 is read because whose it is depends on the date.
    expect(seen.length).toBeGreaterThan(0)
    for (const call of seen) expect(call).toEqual(['wallet_id', ['w1', 'w3', 'w4']])
    expect(data.balances!.map(b => b.walletId).sort()).toEqual(['w1', 'w4'])
  })

  it('keeps every reading when more exist than the API row cap returns per request', async () => {
    const base = seed()
    // 1,200 daily readings for w1, the latest (the one a period end needs) last.
    const readings = Array.from({ length: 1200 }, (_, i) => ({
      fund_id: 'F', wallet_id: 'w1', as_of_date: new Date(Date.UTC(2023, 0, 1) + i * 86_400_000).toISOString().slice(0, 10), units: i,
    }))
    const { admin } = memoryAdmin({ ...base, crypto_wallet_balances: readings }, { maxRows: 500 })
    const data = await loadLedgerData(admin as any, 'F', 'Fund I')
    expect(data.chainWarning).toBeUndefined()
    expect(data.balances).toHaveLength(1200)
    expect(Math.max(...data.balances!.map(b => b.units))).toBe(1199)
  })

  it('degrades with a warning when the wallet read fails, rather than failing the package', async () => {
    const { admin } = memoryAdmin(seed())
    const realFrom = admin.from.bind(admin)
    ;(admin as any).from = (t: string) => t === 'crypto_wallets'
      ? { select: () => ({ eq: async () => ({ data: null, error: { message: 'boom' } }) }) }
      : realFrom(t)
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const data = await loadLedgerData(admin as any, 'F', 'Fund I')
    spy.mockRestore()
    expect(data.walletRows).toEqual([])
    expect(data.balances).toEqual([])
    expect(data.chainWarning).toBe('On-chain balances could not be read.')
    const payload = computePayload(data, { start: '2026-01-01', end: '2026-03-31', label: 'Q1' } as any)
    expect(payload.scheduleOfInvestments.chainWarning).toBe('On-chain balances could not be read.')
  })
})

describe('whose an untagged wallet is — the close and the schedule agree', () => {
  // Fund I bought the coin in January; Fund II bought in May. On 31 March the untagged wallet is
  // Fund I's alone — for the close of Q1 AND on Q1's schedule — and nobody's on 30 June.
  const seed = () => ({
    fund_vehicles: [
      { id: 'v1', fund_id: 'F', name: 'Fund I', kind: 'fund' },
      { id: 'v2', fund_id: 'F', name: 'Fund II', kind: 'fund' },
    ],
    companies: [{ id: 'k', fund_id: 'F', name: 'Coin', holding_type: 'crypto', status: 'active', portfolio_group: ['Fund I', 'Fund II'] }],
    investment_transactions: [
      { id: 't1', fund_id: 'F', company_id: 'k', transaction_type: 'investment', portfolio_group: 'Fund I', transaction_date: '2026-01-05', shares_acquired: 10, investment_cost: 100, share_price: 10 },
      { id: 't2', fund_id: 'F', company_id: 'k', transaction_type: 'investment', portfolio_group: 'Fund II', transaction_date: '2026-05-05', shares_acquired: 10, investment_cost: 100, share_price: 10 },
    ],
    crypto_wallets: [{ id: 'w', fund_id: 'F', company_id: 'k', chain: 'ethereum', address: '0xw', active: true, portfolio_group: null }],
    crypto_wallet_balances: [{ fund_id: 'F', wallet_id: 'w', as_of_date: '2026-03-30', units: 10 }],
  })

  it('counts the wallet for the first holder on a date before the second bought in, on both surfaces', async () => {
    const { admin } = memoryAdmin(seed())
    const close = await loadWalletCloseInputs(admin as any, 'F', 'Fund I', '2026-03-31')
    const data = await loadLedgerData(admin as any, 'F', 'Fund I')
    expect(close!.wallets.map(w => w.id)).toEqual(['w'])
    expect(entityWalletsAsOf(data, '2026-03-31').map(w => w.id)).toEqual(close!.wallets.map(w => w.id))
    // And the schedule's chain column reads it.
    const q1 = computePayload(data, { start: '2026-01-01', end: '2026-03-31', label: 'Q1' } as any)
    const row = q1.scheduleOfInvestments.rows.find((r: any) => r.companyId === 'k') as any
    expect(row.chain).toMatchObject({ observedUnits: 10 })
  })

  it('counts it for neither once the second holder has bought in, on both surfaces', async () => {
    const { admin } = memoryAdmin(seed())
    expect(await loadWalletCloseInputs(admin as any, 'F', 'Fund I', '2026-06-30')).toBeNull()
    expect(await loadWalletCloseInputs(admin as any, 'F', 'Fund II', '2026-06-30')).toBeNull()
    const one = await loadLedgerData(admin as any, 'F', 'Fund I')
    const two = await loadLedgerData(admin as any, 'F', 'Fund II')
    expect(entityWalletsAsOf(one, '2026-06-30')).toEqual([])
    expect(entityWalletsAsOf(two, '2026-06-30')).toEqual([])
  })
})

describe('loadLedgerData — quotes', () => {
  const seed = (n: number) => ({
    fund_vehicles: [{ id: 'v1', fund_id: 'F', name: 'Fund I', kind: 'fund' }],
    price_feeds: [{ id: 'pf', fund_id: 'F', company_id: 'k', kind: 'listed_equity', symbol: 'ACME', quote_currency: 'USD', quote_scale: 1, active_from: '2020-01-01' }],
    // Oldest first, as a table that only ever grows returns them unordered.
    price_observations: Array.from({ length: n }, (_, i) => ({
      fund_id: 'F', feed_id: 'pf', as_of_date: new Date(Date.UTC(2020, 0, 1) + i * 86_400_000).toISOString().slice(0, 10), price: i, basis: 'close',
    })),
  })

  it('reads every quote of a feed past the row cap, so the latest price is there', async () => {
    const { admin } = memoryAdmin(seed(2500), { maxRows: 1000 })
    const data = await loadLedgerData(admin as any, 'F', 'Fund I')
    expect(data.observations).toHaveLength(2500)
    expect(data.observations.at(-1)!.price).toBe(2499)
    expect(data.levelWarning).toBeUndefined()
  })

  it('says the levels are not real when the quotes cannot be read, rather than levelling at 3 silently', async () => {
    const m = memoryAdmin(seed(3))
    m.failNext('price_observations', 'select', 'boom')
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const data = await loadLedgerData(m.admin as any, 'F', 'Fund I')
    spy.mockRestore()
    expect(data.observations).toEqual([])
    expect(data.levelWarning).toMatch(/could not be read/)
    const payload = computePayload(data, { start: '2026-01-01', end: '2026-03-31', label: 'Q1' } as any)
    expect(payload.scheduleOfInvestments.levelWarning).toBe(data.levelWarning)
  })

  it('degrades the same way when the feeds read fails', async () => {
    const m = memoryAdmin(seed(3))
    m.failNext('price_feeds', 'select', 'boom')
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const data = await loadLedgerData(m.admin as any, 'F', 'Fund I')
    spy.mockRestore()
    expect(data.feeds).toEqual([])
    expect(data.levelWarning).toMatch(/could not be read/)
  })
})
