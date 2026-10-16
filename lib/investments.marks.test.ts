import { describe, it, expect } from 'vitest'
import { computeSummary } from './investments'
import type { InvestmentTransaction, CompanyStatus } from '@/lib/types/database'

let n = 0
function txn(p: Partial<InvestmentTransaction>): InvestmentTransaction {
  n += 1
  return {
    id: `t${n}`, company_id: 'co', fund_id: 'f', transaction_type: 'investment', transaction_date: '2026-01-01',
    round_name: null, investment_cost: null, interest_converted: 0, shares_acquired: null, share_price: null,
    security_type: null, converts_from_txn_id: null, cost_basis_exited: null, proceeds_received: null,
    proceeds_escrow: null, proceeds_written_off: null, unrealized_value_change: null, current_share_price: null,
    ...p,
  } as InvestmentTransaction
}
const ACTIVE = 'active' as CompanyStatus
const mark = (round: string, change: number, date = '2022-06-01') =>
  txn({ transaction_type: 'unrealized_gain_change', round_name: round, unrealized_value_change: change, transaction_date: date })

describe('rounds with shares but no price anywhere are valued from their marks', () => {
  // A holding with share counts on every round, no share price on any investment or mark, a
  // partial secondary in the seed, and warrants received for nothing. It read as $0.
  const history = [
    txn({ round_name: 'Series Seed Preferred', investment_cost: 180000, shares_acquired: 360000, transaction_date: '2015-10-01' }),
    txn({ round_name: 'Series Seed-1 Preferred', investment_cost: 60000, shares_acquired: 200000, transaction_date: '2016-04-01' }),
    txn({ round_name: 'Common Stock', investment_cost: 280000, shares_acquired: 700000, transaction_date: '2016-09-01' }),
    txn({ round_name: 'Warrants-1', investment_cost: 0, shares_acquired: 120000, transaction_date: '2019-03-01' }),
    txn({ transaction_type: 'proceeds', round_name: 'Series Seed Preferred', cost_basis_exited: 110000, proceeds_received: 3200000, transaction_date: '2022-06-01' }),
    mark('Series Seed-1 Preferred', 1000000),
    mark('Warrants-1', 600000),
    mark('Common Stock', 3250000),
    mark('Series Seed Preferred', 1900000, '2026-03-31'),
  ]

  it('values each round at remaining cost plus its marks, the free warrants included', () => {
    const s = computeSummary(history, ACTIVE, new Date('2026-10-09'))
    const by = Object.fromEntries(s.rounds.map(r => [r.roundName, Math.round(r.currentValue)]))
    expect(by).toEqual({
      'Series Seed Preferred': 70000 + 1900000,
      'Series Seed-1 Preferred': 60000 + 1000000,
      'Common Stock': 280000 + 3250000,
      'Warrants-1': 600000,
    })
    expect(Math.round(s.unrealizedValue)).toBe(7160000)
  })

  it('still values by shares when a price is known, and a fully exited round at nothing', () => {
    const priced = computeSummary([
      txn({ round_name: 'A', investment_cost: 100, shares_acquired: 100, share_price: 1 }),
      txn({ transaction_type: 'unrealized_gain_change', current_share_price: 3, transaction_date: '2026-06-01' }),
      txn({ round_name: 'B', investment_cost: 50, shares_acquired: 50 }),
      txn({ transaction_type: 'proceeds', round_name: 'B', cost_basis_exited: 50, proceeds_received: 80, transaction_date: '2026-07-01' }),
    ], ACTIVE, new Date('2026-10-09'))
    expect(priced.rounds.find(r => r.roundName === 'A')!.currentValue).toBe(300)
    expect(priced.rounds.find(r => r.roundName === 'B')!.currentValue).toBe(0)
  })
})

describe('value-change marks on a priced position', () => {
  // RouteWise in the demo fund: priced rounds, marks recorded as value changes with no round.
  const history = [
    txn({ round_name: 'Seed', investment_cost: 400000, shares_acquired: 400000, share_price: 1, transaction_date: '2022-03-20' }),
    txn({ round_name: 'Series A', investment_cost: 1000000, shares_acquired: 333333, share_price: 3, transaction_date: '2023-07-15' }),
    txn({ transaction_type: 'unrealized_gain_change', unrealized_value_change: 799999, transaction_date: '2023-07-15' }),
    txn({ transaction_type: 'unrealized_gain_change', unrealized_value_change: 2933330, transaction_date: '2024-11-01' }),
    txn({ round_name: 'Series B', investment_cost: 2000000, shares_acquired: 285714, share_price: 7, transaction_date: '2024-11-01' }),
    txn({ transaction_type: 'unrealized_gain_change', unrealized_value_change: 5604758.5, transaction_date: '2025-12-31' }),
    txn({ transaction_type: 'unrealized_gain_change', unrealized_value_change: 425000, transaction_date: '2026-06-30' }),
  ]

  it('values at the latest price plus the marks after it — what the books hold: cost plus every mark', () => {
    const s = computeSummary(history, ACTIVE, new Date('2026-10-09'))
    // 1,019,047 shares at $7 = 7,133,329, plus 5,604,758.50 and 425,000 marked since.
    expect(s.unrealizedValue).toBeCloseTo(13163087.5, 2)
    expect(s.rounds.reduce((sum, r) => sum + r.currentValue, 0)).toBeCloseTo(13163087.5, 2)
  })

  it('a later price supersedes the marks before it', () => {
    const repriced = [...history, txn({ transaction_type: 'unrealized_gain_change', current_share_price: 10, transaction_date: '2026-09-30' })]
    expect(computeSummary(repriced, ACTIVE, new Date('2026-10-09')).unrealizedValue).toBeCloseTo(1019047 * 10, 2)
  })
})
