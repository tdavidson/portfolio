import { beforeEach, describe, expect, it, vi } from 'vitest'

const getSeries = vi.fn()
const listPlans = vi.fn()
vi.mock('@/lib/forecast/service', () => ({ getSeries: (...a: unknown[]) => getSeries(...a), listPlans: (...a: unknown[]) => listPlans(...a) }))
vi.mock('@/lib/accounting/vehicle-resolver', () => ({ resolveVehicle: vi.fn(async (_a: unknown, _f: unknown, v?: string) => v ?? 'Example Fund I') }))
vi.mock('@/lib/agent/portfolio-tools', () => ({
  PORTFOLIO_HANDLERS: {
    list_investments: vi.fn(async () => [
      { id: 't1', company_id: 'h1', transaction_type: 'investment', transaction_date: '2025-03-01', investment_cost: 250_000, portfolio_group: 'Example Fund I' },
      { id: 't2', company_id: 'h1', transaction_type: 'unrealized_gain_change', transaction_date: '2026-06-30', unrealized_value_change: 15_000, portfolio_group: 'Example Fund I' },
      { id: 't3', company_id: 'h1', transaction_type: 'unrealized_gain_change', transaction_date: '2026-09-30', unrealized_value_change: -5_000, valuation_change_source: 'nav', portfolio_group: 'Example Fund I' },
      { id: 't4', company_id: 'h2', transaction_type: 'unrealized_gain_change', transaction_date: '2026-09-30', unrealized_value_change: 900, valuation_change_source: 'fx', portfolio_group: 'Example Fund I' },
    ]),
    fund_performance: vi.fn(async () => [{
      vehicle: 'Example Fund I', basis: 'From the books.', committed: 1_000_000, called: 600_000, unfunded: 400_000, distributed: 100_000,
      nav: 800_000, dpi: 0.17, rvpi: 1.33, tvpi: 1.5, net_lp_irr: 0.1234, carry_accrued: 20_000, whole_fund: { nav: 820_000, tvpi: 1.53 },
    }]),
  },
}))
vi.mock('@/lib/accounting/load', () => ({
  fetchAllRows: vi.fn(),
  loadEntityNames: vi.fn(async () => new Map([['e1', 'Jane Doe'], ['e2', 'GP Carry LLC']])),
  loadPostedLedger: vi.fn(async () => ({
    capitalPostings: [
      { lpEntityId: 'e1', amount: -500_000, sourceType: 'capital_call', entryDate: '2026-01-15' },
      { lpEntityId: 'e2', amount: -10_000, sourceType: 'carried_interest', entryDate: '2026-06-30' },
    ],
  })),
}))
vi.mock('@/lib/access/carry-visibility', async (orig) => ({
  ...(await orig<typeof import('@/lib/access/carry-visibility')>()),
  seesIndividualCarry: () => false,
  carryRecipientIds: async () => new Set(['e2']),
}))

import { QUERY_LOADERS } from './datasets'
import { fetchAllRows } from '@/lib/accounting/load'
import { QUERY_CATALOG } from './catalog'

const ctx = { admin: {}, fundId: 'f1', userId: 'u1', portfolioGroup: '', access: { vehicles: { all: true, ids: [] } } } as never

const series = (status: string[]) => ({
  periods: status.map((s, i) => ({ key: `2026-0${i + 1}`, status: s })),
  lines: [
    { code: '4000', name: 'Fee income', type: 'income', values: [1_000, 0] },
    { code: '6000', name: 'Legal', type: 'expense', values: [300, 200] },
  ],
  cash: [{ opening: 0, movement: 700, ending: 700 }, { opening: 700, movement: -200, ending: 500 }],
  cashFlows: { operating: [700, -200], invested: [0, 0], proceeds: [0, 0], called: [0, 0], distributed: [0, 0], borrowed: [0, 0], repaid: [0, 0] },
})

beforeEach(() => { getSeries.mockReset(); listPlans.mockReset() })

describe('new datasets', () => {
  it('every catalog dataset has a loader', () => {
    for (const sets of Object.values(QUERY_CATALOG)) for (const d of sets) expect(QUERY_LOADERS[d.name], d.name).toBeTypeOf('function')
  })

  it('fund_performance: net LP figures with IRR in percent and the gross NAV', async () => {
    const [r] = await QUERY_LOADERS.fund_performance(ctx, {})
    expect(r).toMatchObject({ vehicle: 'Example Fund I', tvpi: 1.5, net_lp_irr: 12.34, carry_accrued: 20_000, gross_nav: 820_000, basis: 'books' })
  })

  it('capital_accounts: combines carry recipients for a member without GP economics', async () => {
    const rows = await QUERY_LOADERS.capital_accounts(ctx, { as_of: '2026-09-30' })
    expect(rows.map(r => r.partner)).toEqual(['Jane Doe', 'Carry recipients (combined)'])
    expect(rows[0]).toMatchObject({ contributions: 500_000, ending: 500_000 })
  })

  it('pnl_by_month: one row per account per month with a signed net, skipping zeros', async () => {
    getSeries.mockResolvedValue(series(['actual', 'actual_unclosed']))
    const rows = await QUERY_LOADERS.pnl_by_month(ctx, { as_of: '2026-02-28' })
    expect(getSeries.mock.calls[0][1]).toMatchObject({ vehicle: 'Example Fund I', view: 'actual', start: '2023-03', end: '2026-02', interval: 'month' })
    expect(rows).toEqual([
      { month: '2026-01-01', account_code: '4000', account_name: 'Fee income', type: 'income', amount: 1_000, net: 1_000, status: 'actual' },
      { month: '2026-01-01', account_code: '6000', account_name: 'Legal', type: 'expense', amount: 300, net: -300, status: 'actual' },
      { month: '2026-02-01', account_code: '6000', account_name: 'Legal', type: 'expense', amount: 200, net: -200, status: 'actual_unclosed' },
    ])
  })

  it('cash_by_month: opening, movement, ending and flows per month', async () => {
    getSeries.mockResolvedValue(series(['actual', 'actual']))
    const rows = await QUERY_LOADERS.cash_by_month(ctx, { vehicle: 'Example Fund II' })
    expect(getSeries.mock.calls[0][1].vehicle).toBe('Example Fund II')
    expect(rows[1]).toMatchObject({ month: '2026-02-01', opening: 700, movement: -200, ending: 500, operating: -200 })
  })

  it('forecast_by_month: prefers a rolling forecast, and says when there is no plan', async () => {
    listPlans.mockResolvedValue({ plans: [{ id: 'b', name: 'Budget 2027', kind: 'budget' }, { id: 'r', name: 'Rolling', kind: 'rolling_forecast' }] })
    getSeries.mockResolvedValue(series(['actual', 'forecast']))
    const rows = await QUERY_LOADERS.forecast_by_month(ctx, { as_of: '2026-11-20' })
    expect(getSeries.mock.calls[0][1]).toMatchObject({ planId: 'r', view: 'combined', start: '2025-11', end: '2028-11' })
    expect(rows[0]).toMatchObject({ plan: 'Rolling', status: 'actual' })
    listPlans.mockResolvedValue({ plans: [] })
    await expect(QUERY_LOADERS.forecast_by_month(ctx, {})).rejects.toThrow(/no forecast plan/)
  })
})

describe('transactions', () => {
  it('names fund holdings and digital assets, and labels each mark with its change', async () => {
    const data: Record<string, unknown[]> = {
      companies: [{ id: 'h1', name: 'Example Partners Fund III', holding_type: 'fund' }, { id: 'h2', name: 'Example Coin', holding_type: 'crypto' }],
      fund_nav_statements: [{ investment_transaction_id: 't2' }],
    }
    // The loaders build their query on ctx.admin; record which table each asks for.
    let asked = ''
    const admin = { from: (t: string) => { asked = t; const chain: any = new Proxy({}, { get: () => () => chain }); return chain } }
    vi.mocked(fetchAllRows).mockImplementation(async (build: any) => { build(0, 999); return (data[asked] ?? []) as never })
    const rows = await QUERY_LOADERS.transactions({ ...(ctx as object), admin } as never, {})
    expect(rows.map(r => [r.company, r.holding_type, r.mark_source, r.mark_change])).toEqual([
      ['Example Partners Fund III', 'fund', null, null],
      ['Example Partners Fund III', 'fund', 'nav_statement', 15_000],
      ['Example Partners Fund III', 'fund', 'nav', -5_000],
      ['Example Coin', 'digital_asset', null, 900],
    ])
  })
})
