import { describe, it, expect } from 'vitest'
import { buildSoiPositions, txnsForVehicle, withFundHoldingFigures, withChainBalances, type SoiCompany } from './soi'

const co = (over: Partial<SoiCompany> = {}): SoiCompany => ({
  id: 'c1', name: 'Acme Labs, Inc.', status: 'active',
  industry: ['Software'], stage: 'Series B', portfolio_group: ['Acme SPV LP'],
  ...over,
})

// Minimal shape of an investment_transactions row; computeSummary ignores the rest.
const txn = (o: any) => ({
  id: o.id ?? Math.random().toString(36).slice(2),
  company_id: o.company_id ?? 'c1',
  transaction_type: o.transaction_type,
  transaction_date: o.transaction_date ?? '2026-02-02',
  round_name: o.round_name ?? 'Series B',
  investment_cost: o.investment_cost ?? null,
  shares_acquired: o.shares_acquired ?? null,
  share_price: o.share_price ?? null,
  current_share_price: o.current_share_price ?? null,
  unrealized_value_change: o.unrealized_value_change ?? null,
  cost_basis_exited: o.cost_basis_exited ?? null,
  proceeds_received: o.proceeds_received ?? null,
  proceeds_escrow: o.proceeds_escrow ?? null,
  proceeds_written_off: o.proceeds_written_off ?? null,
  interest_converted: o.interest_converted ?? null,
  converts_from_txn_id: o.converts_from_txn_id ?? null,
  fee_amount: o.fee_amount ?? null,
  portfolio_group: o.portfolio_group ?? null,
}) as any

/** An investment into the default company, in the vehicle `co()` belongs to. */
const inv = (o: any = {}) => txn({ ...o, transaction_type: 'investment', portfolio_group: 'Acme SPV LP' })

describe('txnsForVehicle', () => {
  it('matches the vehicle EXACTLY — never as a substring', () => {
    // The bug this guards: "Acme SPV II".includes("Acme SPV") is true.
    const txns = [
      txn({ transaction_type: 'investment', portfolio_group: 'Acme SPV', investment_cost: 100 }),
      txn({ transaction_type: 'investment', portfolio_group: 'Acme SPV II', investment_cost: 999 }),
    ]
    const got = txnsForVehicle(txns, 'Acme SPV')
    expect(got).toHaveLength(1)
    expect(got[0].investment_cost).toBe(100)
  })

  it('includes untagged company-wide price signals', () => {
    const txns = [
      txn({ transaction_type: 'investment', portfolio_group: 'Acme SPV LP', investment_cost: 100 }),
      txn({ transaction_type: 'round_info', portfolio_group: null, share_price: 12.5 }),
      txn({ transaction_type: 'investment', portfolio_group: null, investment_cost: 555 }), // untagged investment: NOT a price signal
    ]
    const got = txnsForVehicle(txns, 'Acme SPV LP')
    expect(got.map(t => t.transaction_type).sort()).toEqual(['investment', 'round_info'])
  })
})

describe('buildSoiPositions — holding type', () => {
  it('tags a fund holding so the view can render it separately', () => {
    const positions = buildSoiPositions(
      [{ id: 't1', company_id: 'c1', fund_id: 'f', transaction_type: 'investment',
         investment_cost: 1000, transaction_date: '2025-01-01', portfolio_group: 'Fund I' } as any],
      [co({ id: 'c1', name: 'Acme Ventures III', holding_type: 'fund' })],
      'Fund I',
    )
    expect(positions[0].holdingType).toBe('fund')
  })

  it('defaults to company when the column is absent or null', () => {
    const positions = buildSoiPositions(
      [{ id: 't2', company_id: 'c2', fund_id: 'f', transaction_type: 'investment',
         investment_cost: 1000, transaction_date: '2025-01-01', portfolio_group: 'Fund I' } as any],
      [co({ id: 'c2', name: 'Widget Co' })],
      'Fund I',
    )
    expect(positions[0].holdingType).toBe('company')
  })
})

describe('buildSoiPositions', () => {
  it('values priced equity at shares × the latest round price', () => {
    // A priced position marked up: 100,000 sh bought at $8.00, latest round at $12.50.
    const positions = buildSoiPositions(
      [
        txn({ transaction_type: 'investment', portfolio_group: 'Acme SPV LP', investment_cost: 800_000, shares_acquired: 100_000, share_price: 8 }),
        txn({ transaction_type: 'round_info', portfolio_group: null, share_price: 12.5 }),
      ],
      [co()],
      'Acme SPV LP',
    )
    expect(positions).toHaveLength(1)
    const p = positions[0]
    expect(p.name).toBe('Acme Labs, Inc.')
    expect(p.shares).toBe(100_000)
    expect(p.sharePrice).toBe(12.5)
    expect(p.cost).toBe(800_000)
    expect(p.fairValue).toBe(1_250_000) // 100,000 × 12.50
    expect(p.unrealized).toBe(450_000)
    expect(p.assetType).toBe('Priced equity')
    expect(p.industry).toBe('Software')
  })

  it('excludes a company the vehicle does not hold', () => {
    const positions = buildSoiPositions(
      [txn({ transaction_type: 'investment', portfolio_group: 'Some Other Fund, LP', investment_cost: 500_000, shares_acquired: 100, share_price: 5000 })],
      [co()],
      'Acme SPV LP',
    )
    expect(positions).toEqual([])
  })

  it('does not create a position from a price signal alone', () => {
    const positions = buildSoiPositions(
      [txn({ transaction_type: 'round_info', portfolio_group: null, share_price: 12.5 })],
      [co()],
      'Acme SPV LP',
    )
    expect(positions).toEqual([])
  })

  it('values an unpriced SAFE at cost plus its cumulative value change', () => {
    const positions = buildSoiPositions(
      [
        txn({ transaction_type: 'investment', portfolio_group: 'Acme SPV LP', investment_cost: 250_000, shares_acquired: 0, share_price: 0, round_name: 'SAFE' }),
        txn({ transaction_type: 'unrealized_gain_change', portfolio_group: 'Acme SPV LP', unrealized_value_change: 50_000, round_name: 'SAFE' }),
      ],
      [co()],
      'Acme SPV LP',
    )
    expect(positions[0].fairValue).toBe(300_000)
    expect(positions[0].assetType).toBe('Convertible / SAFE')
  })
})

describe('digital-asset holdings', () => {
  it('sections a crypto holding away from the company table', () => {
    // A token has a quantity and a price but no industry, stage or country. Reported under
    // "Direct investments" it would state three blank facts about itself.
    const txns = [
      {
        id: 't1', company_id: 'eth', fund_id: 'f', transaction_type: 'investment',
        transaction_date: '2026-01-15', round_name: 'Purchase', portfolio_group: 'Fund I',
        investment_cost: 30_000, shares_acquired: 10, share_price: 3_000,
      },
    ] as any[]
    const companies = [
      { id: 'eth', name: 'Ether', holding_type: 'crypto', status: 'active', industry: null, stage: null, portfolio_group: ['Fund I'] },
    ] as any[]

    const [position] = buildSoiPositions(txns, companies, 'Fund I')
    expect(position.holdingType).toBe('crypto')
    expect(position.shares).toBe(10)
    expect(position.cost).toBe(30_000)
  })

  it('still reads a holding with no discriminator as a company', () => {
    const txns = [
      {
        id: 't1', company_id: 'c1', fund_id: 'f', transaction_type: 'investment',
        transaction_date: '2026-01-15', round_name: 'Seed', portfolio_group: 'Fund I',
        investment_cost: 100, shares_acquired: 10, share_price: 10,
      },
    ] as any[]
    const companies = [
      { id: 'c1', name: 'Acme', status: 'active', industry: null, stage: null, portfolio_group: ['Fund I'] },
    ] as any[]
    expect(buildSoiPositions(txns, companies, 'Fund I')[0].holdingType).toBe('company')
  })
})

describe('new vs follow-on split', () => {
  it('the earliest investment is new capital, every later one is follow-on', () => {
    const txns = [
      inv({ transaction_date: '2024-03-01', investment_cost: 500_000 }),
      inv({ transaction_date: '2025-06-01', investment_cost: 250_000 }),
      inv({ transaction_date: '2026-01-15', investment_cost: 100_000 }),
    ]
    const [p] = buildSoiPositions(txns, [co()], 'Acme SPV LP')
    expect(p.investedNew).toBe(500_000)
    expect(p.investedFollowOn).toBe(350_000)
  })

  it('new + follow-on ties to invested exactly', () => {
    const txns = [
      inv({ transaction_date: '2024-03-01', investment_cost: 333_333.33 }),
      inv({ transaction_date: '2025-06-01', investment_cost: 166_666.67 }),
    ]
    const [p] = buildSoiPositions(txns, [co()], 'Acme SPV LP')
    expect(p.investedNew + p.investedFollowOn).toBeCloseTo(p.invested, 2)
  })

  it('a single-investment company is 100% new', () => {
    const [p] = buildSoiPositions([inv({ transaction_date: '2024-03-01', investment_cost: 400_000 })], [co()], 'Acme SPV LP')
    expect(p.investedNew).toBe(400_000)
    expect(p.investedFollowOn).toBe(0)
  })

  // DELIBERATE: a SAFE-to-equity conversion row is chronologically later, so its capitalized
  // interest classifies as follow-on though it is not new money. The timeseries chart already
  // behaves this way; pinning it here keeps the two charts agreeing.
  it('capitalized conversion interest classifies as follow-on', () => {
    const safe = inv({ id: 'safe1', transaction_date: '2024-03-01', investment_cost: 500_000, round_name: 'SAFE' })
    const conv = inv({
      transaction_date: '2025-06-01', investment_cost: 0, interest_converted: 25_000,
      round_name: 'Series A', converts_from_txn_id: 'safe1',
    })
    const [p] = buildSoiPositions([safe, conv], [co()], 'Acme SPV LP')
    expect(p.investedNew).toBe(500_000)
    expect(p.investedFollowOn).toBe(25_000)
  })
})

describe('includeRealized', () => {
  // A company sold in full: no remaining basis, no carrying value, but real invested capital
  // and real proceeds. The statutory schedule must not show it; the fund detail chart must.
  const exited = () => [
    inv({ transaction_date: '2023-01-10', investment_cost: 300_000 }),
    txn({
      transaction_type: 'proceeds', transaction_date: '2026-05-01', portfolio_group: 'Acme SPV LP',
      proceeds_received: 900_000, cost_basis_exited: 300_000,
    }),
  ]

  it('drops a fully-realized company by default', () => {
    expect(buildSoiPositions(exited(), [co({ status: 'exited' })], 'Acme SPV LP')).toHaveLength(0)
  })

  it('keeps it when includeRealized is set, with its invested and proceeds intact', () => {
    const rows = buildSoiPositions(exited(), [co({ status: 'exited' })], 'Acme SPV LP', undefined, { includeRealized: true })
    expect(rows).toHaveLength(1)
    expect(rows[0].invested).toBe(300_000)
    expect(rows[0].investedNew).toBe(300_000)
    expect(rows[0].distributions).toBe(900_000)
    expect(rows[0].fairValue).toBe(0)
    expect(rows[0].status).toBe('exited')
  })

  it('still drops a company with neither invested capital nor proceeds', () => {
    const nothing = [inv({ transaction_date: '2024-01-01', investment_cost: 0 })]
    const rows = buildSoiPositions(nothing, [co()], 'Acme SPV LP', undefined, { includeRealized: true })
    expect(rows).toHaveLength(0)
  })
})

describe('withFundHoldingFigures', () => {
  const position = {
    companyId: 'f1', commitment: 10_000_000, contributed: 6_000_000, unfunded: 4_500_000,
    pctCalled: 0.6, navAsOf: '2026-06-30', stalenessDays: 92,
  }
  it('puts commitment, called and unfunded on the fund row', () => {
    const [row] = withFundHoldingFigures(
      [{ companyId: 'f1', holdingType: 'fund' as const, name: 'Acme Growth II' }], [position])
    expect(row).toMatchObject({
      commitment: 10_000_000, called: 6_000_000, unfunded: 4_500_000,
      pctCalled: 0.6, navAsOf: '2026-06-30', stalenessDays: 92,
    })
    // Unfunded is the register's own figure, not commitment − called: a recallable distribution
    // puts capital back on the hook, so subtracting here would understate it.
    expect(row.unfunded).not.toBe(position.commitment - position.contributed)
  })
  it('leaves direct and crypto holdings untouched', () => {
    const rows = [
      { companyId: 'c1', holdingType: 'company' as const, name: 'Direct Co' },
      { companyId: 'f1', holdingType: 'crypto' as const, name: 'Token' },
      { holdingType: 'fund' as const, name: 'Ledger-sourced fund row with no company id' },
    ]
    expect(withFundHoldingFigures(rows, [position])).toEqual(rows)
  })
  it('leaves a fund the register does not know about untouched', () => {
    const rows = [{ companyId: 'other', holdingType: 'fund' as const, name: 'Unregistered' }]
    expect(withFundHoldingFigures(rows, [position])).toEqual(rows)
  })
  it('is a no-op when there is no register at all', () => {
    const rows = [{ companyId: 'f1', holdingType: 'fund' as const, name: 'Acme Growth II' }]
    expect(withFundHoldingFigures(rows, [])).toBe(rows)
  })
})

describe('withChainBalances', () => {
  const wallet = { id: 'w1', companyId: 'k1', chain: 'ethereum', address: '0x1', active: true }
  const rows = [
    { companyId: 'k1', holdingType: 'crypto' as const, shares: 10 },
    { companyId: 'c1', holdingType: 'company' as const, shares: 100 },
  ]

  it("puts what the chain says beside a digital asset's recorded units", () => {
    const out = withChainBalances(rows, [wallet], [{ walletId: 'w1', asOfDate: '2026-03-31', units: 12 }], '2026-03-31')
    expect(out[0].chain).toEqual({ observedUnits: 12, delta: 2, agrees: false, asOf: '2026-03-31' })
    expect(out[1]).toEqual(rows[1])
  })

  it('says the chain agrees inside the tolerance the close uses', () => {
    const out = withChainBalances(rows, [wallet], [{ walletId: 'w1', asOfDate: '2026-03-31', units: 10.0000001 }], '2026-03-31')
    expect(out[0].chain?.agrees).toBe(true)
  })

  it('says nothing for an asset with no wallet read by the date', () => {
    expect(withChainBalances(rows, [wallet], [], '2026-03-31')[0].chain).toBeNull()
    expect(withChainBalances(rows, [], [], '2026-03-31')[0].chain).toBeNull()
  })
})
