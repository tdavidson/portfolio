import { describe, it, expect } from 'vitest'
import {
  buildLots, buildDisposals, computeDisposalBasis, disposalBasis,
  proposeBasisForNewDisposal, lotIssues, basisOf, isLotMethod, LOT_METHODS,
} from './lots'
import type { InvestmentTransaction } from '@/lib/types/database'

const BASE = {
  company_id: 'c', fund_id: 'f', round_name: null, transaction_date: null, notes: null,
  investment_cost: null, interest_converted: 0, shares_acquired: null, share_price: null,
  cost_basis_exited: null, proceeds_received: null, proceeds_escrow: 0, proceeds_written_off: 0,
  proceeds_per_share: null, unrealized_value_change: null, current_share_price: null,
  postmoney_valuation: null, latest_postmoney_valuation: null, exit_valuation: null,
  ownership_pct: null, portfolio_group: null, original_currency: null,
  original_investment_cost: null, original_share_price: null, original_postmoney_valuation: null,
  original_proceeds_received: null, original_proceeds_per_share: null, original_exit_valuation: null,
  original_unrealized_value_change: null, original_current_share_price: null,
  original_latest_postmoney_valuation: null, valuation_change_source: null, fx_rate: null,
  prior_fx_rate: null, fx_value_change: null, original_position_value: null,
  created_at: null, updated_at: null,
}
const txn = (o: Partial<InvestmentTransaction> & Record<string, any>) =>
  ({ ...BASE, ...o }) as InvestmentTransaction

const buy = (id: string, date: string, units: number, cost: number, extra: Record<string, any> = {}) =>
  txn({ id, transaction_type: 'investment', transaction_date: date, shares_acquired: units, investment_cost: cost, ...extra })

const sell = (id: string, date: string, units: number, basis: number | null = null) =>
  txn({ id, transaction_type: 'proceeds', transaction_date: date, shares_acquired: units, cost_basis_exited: basis, proceeds_received: 1 })

// 100 units at $10, then 100 at $30. Total 200 units, $4,000.
const HISTORY = [buy('a', '2026-01-01', 100, 1_000), buy('b', '2026-02-01', 100, 3_000)]

describe('basisOf', () => {
  it('capitalises acquisition costs into the lot', () => {
    expect(basisOf(buy('a', '2026-01-01', 100, 1_000, { fee_amount: 50 }))).toBe(1_050)
  })

  it('counts converted interest only on a conversion row', () => {
    expect(basisOf(buy('a', '2026-01-01', 10, 100, { interest_converted: 25 }))).toBe(100)
    expect(basisOf(buy('a', '2026-01-01', 10, 100, { interest_converted: 25, converts_from_txn_id: 'x' })))
      .toBe(125)
  })

  it('takes an in-kind income row at its fair value on receipt', () => {
    // That value is exactly what stops it being recognised again as gain on sale.
    const airdrop = txn({
      id: 'd', transaction_type: 'income', transaction_date: '2026-03-01',
      income_kind: 'airdrop', income_settlement: 'in_kind', income_amount: 500, shares_acquired: 10,
    })
    expect(basisOf(airdrop)).toBe(500)
  })
})

describe('buildLots', () => {
  it('builds one lot per unit-bearing purchase, oldest first', () => {
    const lots = buildLots(HISTORY)
    expect(lots.map(l => l.txnId)).toEqual(['a', 'b'])
    expect(lots[0].unitCost).toBe(10)
    expect(lots[1].unitCost).toBe(30)
  })

  it('includes in-kind income as a lot at its recognised value', () => {
    const airdrop = txn({
      id: 'd', transaction_type: 'income', transaction_date: '2026-03-01',
      income_kind: 'airdrop', income_settlement: 'in_kind', income_amount: 500, shares_acquired: 10,
    })
    const lots = buildLots([...HISTORY, airdrop])
    expect(lots.map(l => l.txnId)).toEqual(['a', 'b', 'd'])
    expect(lots[2].unitCost).toBe(50)
  })

  it('excludes cash income — it buys no units', () => {
    const dividend = txn({
      id: 'd', transaction_type: 'income', transaction_date: '2026-03-01',
      income_kind: 'dividend', income_settlement: 'cash', income_amount: 500,
    })
    expect(buildLots([...HISTORY, dividend]).map(l => l.txnId)).toEqual(['a', 'b'])
  })

  it('skips a position with cost but no units — a SAFE has no lot', () => {
    const safe = txn({ id: 's', transaction_type: 'investment', transaction_date: '2026-01-01', investment_cost: 5_000 })
    expect(buildLots([safe])).toEqual([])
  })

  it('restates lots through a split', () => {
    // 100 units at $10 becomes 200 at $5 — same total cost, and a post-split disposal of 100
    // units must therefore consume half the lot, not all of it.
    const split = txn({ id: 's', transaction_type: 'split', transaction_date: '2026-06-01', split_ratio: 2 })
    const [lot] = buildLots([buy('a', '2026-01-01', 100, 1_000), split])
    expect(lot.units).toBe(200)
    expect(lot.unitCost).toBe(5)
    expect(lot.cost).toBe(1_000)
  })
})

describe('buildDisposals', () => {
  it('reads units and recorded basis, oldest first', () => {
    const d = buildDisposals([sell('x', '2026-05-01', 50, 500), sell('y', '2026-03-01', 25, null)])
    expect(d.map(x => x.txnId)).toEqual(['y', 'x'])
    expect(d[1].recordedBasis).toBe(500)
    expect(d[0].recordedBasis).toBeNull()
  })

  it('skips a disposal that states no unit count', () => {
    expect(buildDisposals([txn({ id: 'x', transaction_type: 'proceeds', transaction_date: '2026-05-01', proceeds_received: 100 })]))
      .toEqual([])
  })
})

describe('computeDisposalBasis', () => {
  it('fifo takes the oldest lot first', () => {
    const [d] = disposalBasis([...HISTORY, sell('x', '2026-05-01', 100)], 'fifo')
    expect(d.computedBasis).toBe(1_000)
    expect(d.allocations.map(a => a.lotTxnId)).toEqual(['a'])
  })

  it('lifo takes the newest lot first', () => {
    const [d] = disposalBasis([...HISTORY, sell('x', '2026-05-01', 100)], 'lifo')
    expect(d.computedBasis).toBe(3_000)
    expect(d.allocations.map(a => a.lotTxnId)).toEqual(['b'])
  })

  it('hifo takes the dearest lot first', () => {
    const [d] = disposalBasis([...HISTORY, sell('x', '2026-05-01', 100)], 'hifo')
    expect(d.computedBasis).toBe(3_000)
  })

  it('average pools every open lot', () => {
    // 200 units, $4,000 → $20 each.
    const [d] = disposalBasis([...HISTORY, sell('x', '2026-05-01', 100)], 'average')
    expect(d.computedBasis).toBe(2_000)
    expect(d.allocations).toEqual([])
  })

  it('spans lots when one is not enough', () => {
    const [d] = disposalBasis([...HISTORY, sell('x', '2026-05-01', 150)], 'fifo')
    expect(d.computedBasis).toBe(2_500) // all of lot a, then 50 of lot b at $30
    expect(d.allocations).toHaveLength(2)
  })

  it('consumes lots across successive disposals rather than reusing them', () => {
    const rows = [...HISTORY, sell('x', '2026-05-01', 100), sell('y', '2026-06-01', 100)]
    const [first, second] = disposalBasis(rows, 'fifo')
    expect(first.computedBasis).toBe(1_000)
    expect(second.computedBasis).toBe(3_000)
  })

  it('never draws basis from a lot bought after the disposal', () => {
    // A March sale cannot use a June purchase under any method.
    const rows = [buy('a', '2026-01-01', 100, 1_000), buy('late', '2026-06-01', 100, 9_999), sell('x', '2026-03-01', 100)]
    const [d] = disposalBasis(rows, 'hifo')
    expect(d.computedBasis).toBe(1_000)
  })

  it('reports unmatched units instead of inventing basis', () => {
    const [d] = disposalBasis([buy('a', '2026-01-01', 100, 1_000), sell('x', '2026-05-01', 150)], 'fifo')
    expect(d.computedBasis).toBe(1_000)
    expect(d.unmatchedUnits).toBe(50)
  })

  it('processes disposals in date order whatever order they arrive in', () => {
    const rows = [...HISTORY, sell('later', '2026-06-01', 100), sell('earlier', '2026-05-01', 100)]
    const byId = Object.fromEntries(disposalBasis(rows, 'fifo').map(d => [d.txnId, d.computedBasis]))
    expect(byId.earlier).toBe(1_000)
    expect(byId.later).toBe(3_000)
  })

  it('leaves the caller\'s lots untouched', () => {
    const lots = buildLots(HISTORY)
    computeDisposalBasis(lots, buildDisposals([sell('x', '2026-05-01', 100)]), 'fifo')
    expect(lots[0].units).toBe(100)
  })

  it('handles a disposal against no lots at all', () => {
    const [d] = disposalBasis([sell('x', '2026-05-01', 100)], 'fifo')
    expect(d.computedBasis).toBe(0)
    expect(d.unmatchedUnits).toBe(100)
  })
})

describe('proposeBasisForNewDisposal', () => {
  it('proposes from what is still open, not the full lot set', () => {
    const rows = [...HISTORY, sell('x', '2026-05-01', 100)]
    // Lot a is already consumed, so the next 100 units come from lot b at $30.
    expect(proposeBasisForNewDisposal(rows, 'fifo', 100, '2026-06-01').basis).toBe(3_000)
  })

  it('proposes the oldest lot when nothing has been sold', () => {
    expect(proposeBasisForNewDisposal(HISTORY, 'fifo', 100, '2026-06-01').basis).toBe(1_000)
  })

  it('flags units no lot can supply', () => {
    expect(proposeBasisForNewDisposal(HISTORY, 'fifo', 300, '2026-06-01').unmatchedUnits).toBe(100)
  })

  it('proposes nothing for a zero or negative size', () => {
    expect(proposeBasisForNewDisposal(HISTORY, 'fifo', 0, '2026-06-01')).toEqual({ basis: 0, unmatchedUnits: 0 })
  })
})

describe('lotIssues', () => {
  it('is silent when the recorded basis matches the policy', () => {
    expect(lotIssues([...HISTORY, sell('x', '2026-05-01', 100, 1_000)], 'fifo', 'Ether')).toEqual([])
  })

  it('flags a disposal recording no basis at all', () => {
    // The damaging case: full proceeds report as gain and the position keeps cost it sold.
    const [issue] = lotIssues([...HISTORY, sell('x', '2026-05-01', 100)], 'fifo', 'Ether')
    expect(issue.kind).toBe('missing')
    expect(issue.message).toContain('full proceeds report as gain')
    expect(issue.message).toContain('1000.00')
  })

  it('reports a mismatch with both numbers and does not call it wrong', () => {
    const [issue] = lotIssues([...HISTORY, sell('x', '2026-05-01', 100, 2_500)], 'fifo', 'Ether')
    expect(issue.kind).toBe('mismatch')
    expect(issue.message).toContain('2500.00')
    expect(issue.message).toContain('1000.00')
    expect(issue.message).toContain('Deliberate is fine')
  })

  it('flags a disposal larger than anything ever bought', () => {
    const issues = lotIssues([buy('a', '2026-01-01', 100, 1_000), sell('x', '2026-05-01', 150, 1_000)], 'fifo', 'Ether')
    expect(issues.some(i => i.kind === 'unmatched_units')).toBe(true)
  })

  it('says nothing about a fully-written-off position with no units', () => {
    expect(lotIssues([txn({ id: 's', transaction_type: 'investment', transaction_date: '2026-01-01', investment_cost: 5_000 })], 'fifo', 'X'))
      .toEqual([])
  })
})

describe('isLotMethod', () => {
  it('accepts every offered method and nothing else', () => {
    for (const m of LOT_METHODS) expect(isLotMethod(m)).toBe(true)
    // 'specific' is deliberately not offered: it needs a per-disposal lot selection the schema
    // does not carry, and electing a method the software cannot apply is worse than not offering it.
    expect(isLotMethod('specific')).toBe(false)
    expect(isLotMethod(null)).toBe(false)
  })
})

describe('holding period through a conversion', () => {
  const txn = (o: Record<string, unknown>) => ({ fund_id: 'f', company_id: 'c', portfolio_group: 'Fund I', ...o }) as any

  it("tacks the converted units to the SAFE's purchase date, and starts capitalised interest fresh", () => {
    const txns = [
      txn({ id: 'safe', transaction_type: 'investment', transaction_date: '2022-03-01', investment_cost: 100_000, shares_acquired: 0 }),
      txn({ id: 'pref', transaction_type: 'investment', transaction_date: '2024-06-01', investment_cost: 100_000, interest_converted: 25_000, shares_acquired: 125_000, converts_from_txn_id: 'safe' }),
      txn({ id: 'sale', transaction_type: 'proceeds', transaction_date: '2024-09-01', shares_acquired: 125_000, proceeds_received: 250_000 }),
    ]
    const [basis] = disposalBasis(txns, 'fifo')
    expect(basis.allocations.map(a => [a.lotDate, Math.round(a.units), a.cost])).toEqual([
      ['2022-03-01', 100_000, 100_000],
      ['2024-06-01', 25_000, 25_000],
    ])
  })
})
