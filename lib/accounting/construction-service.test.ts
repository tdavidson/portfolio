import { beforeEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_ASSUMPTIONS } from './construction'
import { applyLpWaterfall, constructionBaseline, forecastSchedule } from './construction-forecast'

const mocks = vi.hoisted(() => ({
  resolveVehicle: vi.fn(),
  fundEconomics: vi.fn(),
  loadPostedLedger: vi.fn(),
  loadCarryTerms: vi.fn(),
}))

vi.mock('./vehicle-resolver', () => ({ resolveVehicle: mocks.resolveVehicle }))
vi.mock('./fund-economics', () => ({ fundEconomics: mocks.fundEconomics }))
vi.mock('./load', () => ({ loadPostedLedger: mocks.loadPostedLedger }))
vi.mock('./carry', async importOriginal => {
  const actual = await importOriginal<typeof import('./carry')>()
  return { ...actual, loadCarryTerms: mocks.loadCarryTerms }
})

import {
  getConstructionModel,
  mapConstructionAssumptionsRow,
  updateConstructionAssumptions,
} from './construction-service'

function query(result: { data: unknown; error?: { message: string } | null }) {
  const chain: Record<string, any> = {
    select: () => chain,
    eq: () => chain,
    maybeSingle: async () => result,
    then: (resolve: (value: unknown) => unknown, reject: (reason: unknown) => unknown) =>
      Promise.resolve(result).then(resolve, reject),
  }
  return chain
}

function adminFixture(args: {
  transactions?: unknown[]
  companies?: unknown[]
  stored?: Record<string, unknown> | null
}) {
  const upsert = vi.fn(async () => ({ error: null }))
  const admin = {
    from(table: string) {
      if (table === 'investment_transactions') return query({ data: args.transactions ?? [] })
      if (table === 'companies') return query({ data: args.companies ?? [] })
      if (table === 'fund_construction_models') {
        const chain = query({ data: args.stored ?? null, error: null })
        chain.upsert = upsert
        return chain
      }
      throw new Error(`Unexpected table ${table}`)
    },
  }
  return { admin: admin as any, upsert }
}

const economics = {
  vehicle: 'Fund II',
  id: 'vehicle-2',
  vintageYear: 2024,
  fund: { committed: 10_000_000, paidIn: 4_000_000, uncalled: 6_000_000, nav: 1_500_000 },
}

describe('construction service', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.resolveVehicle.mockResolvedValue('Fund II')
    mocks.fundEconomics.mockResolvedValue([economics])
    mocks.loadCarryTerms.mockResolvedValue({ kind: 'none', carryRate: 0, prefRate: 0, catchupRate: 1, prefCompounds: true, gpEntityId: null, recipients: [] })
  })

  it('uses reported capital for forecasts with or without unrelated ledger activity', async () => {
    mocks.fundEconomics.mockResolvedValue([{ ...economics, fund: { ...economics.fund, distributions: 0 } }])
    const { admin } = adminFixture({})
    mocks.loadPostedLedger.mockResolvedValue({ accounts: [], postings: [], capitalPostings: [] })
    const before = await getConstructionModel({ admin, fundId: 'fund-1', access: { vehicles: { all: true, ids: [] } } }, { vehicle: 'Fund II' })
    mocks.loadPostedLedger.mockResolvedValue({ accounts: [], postings: [{ accountId: 'unrelated', amount: 1 }], capitalPostings: [] })
    const after = await getConstructionModel({ admin, fundId: 'fund-1', access: { vehicles: { all: true, ids: [] } } }, { vehicle: 'Fund II' })
    expect(before.actuals.capitalAvailable).toBe(true)
    expect(after.actuals.capitalAvailable).toBe(true)
    expect(after.actuals.nav).toBe(before.actuals.nav)
    expect(after.actuals.calledCapital).toBe(before.actuals.calledCapital)
  })

  it('does not present incomplete capital as a supported net forecast', async () => {
    mocks.fundEconomics.mockResolvedValue([{ ...economics, fund: { ...economics.fund, distributions: 0, nav: null } }])
    mocks.loadPostedLedger.mockResolvedValue({ accounts: [], postings: [{ accountId: 'unrelated', amount: 1 }], capitalPostings: [] })
    const { admin } = adminFixture({})
    const model = await getConstructionModel({ admin, fundId: 'fund-1', access: { vehicles: { all: true, ids: [] } } }, { vehicle: 'Fund II' })
    expect(model.actuals.capitalAvailable).toBe(false)
    expect(model.actuals.waterfall).toBeUndefined()
  })

  it('headlines the same net-of-carry schedule the construction page does', async () => {
    // forecast-section.tsx applies the vehicle's waterfall whenever capital figures are supported
    // and carry is configured, and shows the LP-only schedule. The service returned the gross one,
    // so the Analyst reported a fund-level figure in a field named netIrr while the page showed
    // the net-of-carry number for the same fund and date.
    mocks.fundEconomics.mockResolvedValue([{ ...economics, fund: { ...economics.fund, distributions: 500_000 } }])
    mocks.loadCarryTerms.mockResolvedValue({ kind: 'european', carryRate: 0.2, prefRate: 0.08, catchupRate: 1, prefCompounds: true, gpEntityId: null, recipients: [] })
    mocks.loadPostedLedger.mockResolvedValue({ accounts: [], postings: [], capitalPostings: [] })
    // A held position, so the forecast actually produces proceeds for the waterfall to split.
    const held = '33333333-3333-4333-8333-333333333333'
    const { admin } = adminFixture({
      companies: [{ id: held, name: 'Held Co', status: 'active', stage: 'Seed', industry: [], portfolio_group: ['Fund II'] }],
      transactions: [{ id: 't1', fund_id: 'fund-1', company_id: held, portfolio_group: 'Fund II', transaction_type: 'investment', transaction_date: '2024-01-01', investment_cost: 1_000_000, round_name: 'Seed', ownership_pct: 10, postmoney_valuation: 10_000_000 }],
    })
    const model = await getConstructionModel({ admin, fundId: 'fund-1', access: { vehicles: { all: true, ids: [] } } }, { vehicle: 'Fund II' })

    expect(model.actuals.capitalAvailable).toBe(true)
    expect(model.actuals.waterfall).toBeDefined()
    expect(model.timelineNetOfCarry).toBe(true)
    expect(model.timeline).not.toBeNull()
    expect(model.grossTimeline).not.toBeNull()
    // The page's own composition, reproduced from the same inputs.
    const gross = forecastSchedule(model.forecast, model.assumptions, model.assumptions.pacing,
      constructionBaseline(model.actuals, model.forecast, model.asOf.slice(0, 10)))
    expect(model.timeline).toEqual(applyLpWaterfall(gross, model.actuals.waterfall))
    expect(model.grossTimeline).toEqual(gross)
    // And it is a different measure, not a relabelling of the same one: the LP's TVPI is lower
    // than the fund's because the GP's share of the terminal NAV is not the LP's.
    const net = model.timeline!.years.at(-1)!
    const fund = model.grossTimeline!.years.at(-1)!
    expect(net.tvpi).toBeLessThan(fund.tvpi!)
    expect(net.nav).toBeLessThan(fund.nav)
  })

  it('headlines the gross schedule, flagged as such, when no carry is configured', async () => {
    mocks.fundEconomics.mockResolvedValue([{ ...economics, fund: { ...economics.fund, distributions: 500_000 } }])
    mocks.loadPostedLedger.mockResolvedValue({ accounts: [], postings: [], capitalPostings: [] })
    const { admin } = adminFixture({})
    const model = await getConstructionModel({ admin, fundId: 'fund-1', access: { vehicles: { all: true, ids: [] } } }, { vehicle: 'Fund II' })
    expect(model.timelineNetOfCarry).toBe(false)
    expect(model.grossTimeline).toBeNull()
    expect(model.timeline).not.toBeNull()
  })

  it('maps stored snake_case assumptions to the canonical camelCase shape', () => {
    expect(mapConstructionAssumptionsRow({
      fee_annual_rate: '0.02',
      fee_basis: 'committed',
      fee_term_years: '8',
      fee_start_date: '2024-01-01',
      fee_step_down_year: '5',
      fee_step_down_rate: '0.01',
      annual_partnership_expense: '25000',
      remaining_org_costs: '10000',
      stages: [],
      position_forecasts: [],
    })).toEqual(expect.objectContaining({
      feeAnnualRate: 0.02,
      feeBasis: 'committed',
      feeTermYears: 8,
      feeStartDate: '2024-01-01',
      feeStepDownYear: 5,
      feeStepDownRate: 0.01,
      annualPartnershipExpense: 25_000,
      remainingOrgCosts: 10_000,
      positionForecasts: [],
    }))
  })

  it('flags a vehicle with no ledger instead of presenting expense zeroes as known', async () => {
    mocks.loadPostedLedger.mockRejectedValue(new Error('not on accounting'))
    const { admin } = adminFixture({})
    const model = await getConstructionModel({ admin, fundId: 'fund-1', access: { vehicles: { all: true, ids: [] } } }, { vehicle: ' fund ii ' })

    expect(model.vehicle).toBe('Fund II')
    expect(model.ledgerAvailable).toBe(false)
    expect(model.actuals.ledgerAvailable).toBe(false)
    expect(model.warnings.join(' ')).toMatch(/not on the ledger/i)
    expect(model.asOf).toMatch(/^\d{4}-\d{2}-\d{2}T/)
  })

  it('loads ledger expenses and keeps active and exited positions in the canonical model', async () => {
    mocks.loadPostedLedger.mockResolvedValue({
      accounts: [
        { id: 'fees', fundId: 'fund-1', code: '1', name: 'Fees', type: 'expense', subtype: 'management_fee' },
        { id: 'org', fundId: 'fund-1', code: '2', name: 'Org', type: 'expense', subtype: 'organizational_expense' },
        { id: 'partnership', fundId: 'fund-1', code: '3', name: 'Partnership', type: 'expense', subtype: 'partnership_expense' },
      ],
      postings: [
        { accountId: 'fees', amount: 100_000, currency: 'USD' },
        { accountId: 'org', amount: 20_000, currency: 'USD' },
        { accountId: 'partnership', amount: 30_000, currency: 'USD' },
      ],
    })
    const activeId = '11111111-1111-4111-8111-111111111111'
    const exitedId = '22222222-2222-4222-8222-222222222222'
    const { admin } = adminFixture({
      companies: [
        { id: activeId, name: 'Active Co', status: 'active', stage: 'Seed', industry: [], portfolio_group: ['Fund II'] },
        { id: exitedId, name: 'Exited Co', status: 'exited', stage: 'Series A', industry: [], portfolio_group: ['Fund II'] },
      ],
      transactions: [
        { id: 't1', fund_id: 'fund-1', company_id: activeId, portfolio_group: 'Fund II', transaction_type: 'investment', transaction_date: '2024-01-01', investment_cost: 500_000, round_name: 'Seed', ownership_pct: 10, postmoney_valuation: 5_000_000 },
        // Untagged pricing row is company-wide and should update this vehicle's value/post-money.
        { id: 't2', fund_id: 'fund-1', company_id: activeId, portfolio_group: null, transaction_type: 'round_info', transaction_date: '2025-01-01', current_share_price: 2, latest_postmoney_valuation: 12_000_000, ownership_pct: 8 },
        { id: 't3', fund_id: 'fund-1', company_id: exitedId, portfolio_group: 'Fund II', transaction_type: 'investment', transaction_date: '2023-01-01', investment_cost: 250_000, shares_acquired: 100, share_price: 2500 },
        { id: 't4', fund_id: 'fund-1', company_id: exitedId, portfolio_group: 'Fund II', transaction_type: 'proceeds', transaction_date: '2025-01-01', cost_basis_exited: 250_000, proceeds_received: 750_000 },
      ],
    })
    const model = await getConstructionModel({ admin, fundId: 'fund-1', access: { vehicles: { all: true, ids: [] } } }, { vehicle: 'Fund II' })

    expect(model.actuals).toMatchObject({
      managementFeesIncurred: 100_000,
      orgCostsIncurred: 20_000,
      partnershipExpensesIncurred: 30_000,
      ledgerAvailable: true,
      companyCount: 2,
    })
    expect(model.actuals.positions?.map(position => position.status).sort()).toEqual(['active', 'exited'])
    expect(model.actuals.positions?.find(position => position.companyId === activeId)?.currentPostMoney).toBe(12_000_000)
    expect(model.actuals.positions?.find(position => position.companyId === activeId)?.firstInvestmentDate).toBe('2024-01-01')
    expect(model.actuals.positions?.find(position => position.companyId === exitedId)?.currentValue).toBe(0)
  })

  it('rejects invalid assumptions before issuing an upsert', async () => {
    mocks.loadPostedLedger.mockRejectedValue(new Error('no ledger'))
    const { admin, upsert } = adminFixture({})
    await expect(updateConstructionAssumptions(
      { admin, fundId: 'fund-1', access: { vehicles: { all: true, ids: [] } } },
      { vehicle: 'Fund II', assumptions: { ...DEFAULT_ASSUMPTIONS, feeBasis: 'moon' as any } },
    )).rejects.toThrow(/feeBasis/)
    expect(upsert).not.toHaveBeenCalled()
  })
})
