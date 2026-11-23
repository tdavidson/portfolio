import { describe, expect, it } from 'vitest'
import { calledAfterTransfers, irrFlowPostings } from './irr-flows'
import type { CapitalPosting } from './capital-account'

// Called capital is measured against the commitment, and the commitment moves with a transferred
// interest. So the buyer of an interest takes over the seller's called history, whether the
// interest was sold or given, and the seller is left with none.
const calls = (lp: string, ...rows: [string, number][]): CapitalPosting[] =>
  rows.map(([entryDate, amount]) => ({ lpEntityId: lp, entryDate, sourceType: 'capital_call', amount: -amount }))

const xfer = (sourceType: string, entryId: string, entryDate: string, from: string, moved: Record<string, number>): CapitalPosting[] => {
  const total = Object.values(moved).reduce((s, v) => s + v, 0)
  return [
    { lpEntityId: from, entryDate, sourceType, amount: total, entryId },
    ...Object.entries(moved).map(([lp, v]) => ({ lpEntityId: lp, entryDate, sourceType, amount: -v, entryId })),
  ]
}

describe('calledAfterTransfers', () => {
  it('moves the whole called history to two buyers who split a sale', () => {
    const books = [
      ...calls('seller', ['2020-01-01', 40_000], ['2021-01-01', 20_000]),
      ...calls('buyerA', ['2020-01-01', 40_000], ['2021-01-01', 20_000]),
      ...calls('buyerB', ['2020-01-01', 40_000], ['2021-01-01', 20_000]),
      { lpEntityId: 'seller', entryDate: '2021-12-31', sourceType: 'valuation', amount: -20_000 },
      ...xfer('secondary_transfer', 'sale', '2022-01-01', 'seller', { buyerA: 40_000, buyerB: 40_000 }),
      // A call after the sale lands on the buyers only.
      ...calls('buyerA', ['2023-01-01', 10_000]),
      ...calls('buyerB', ['2023-01-01', 10_000]),
    ]
    const called = calledAfterTransfers(books)
    expect(called.get('seller')).toBeCloseTo(0, 2)
    expect(called.get('buyerA')).toBeCloseTo(100_000, 2)
    expect(called.get('buyerB')).toBeCloseTo(100_000, 2)
  })

  it('carries an assignment the same way', () => {
    const books = [
      ...calls('estate', ['2020-01-01', 70_000]),
      ...xfer('transfer', 'gift', '2021-01-01', 'estate', { trust: 70_000 }),
      ...calls('trust', ['2022-01-01', 20_000]),
    ]
    const called = calledAfterTransfers(books)
    expect(called.get('estate')).toBeCloseTo(0, 2)
    expect(called.get('trust')).toBeCloseTo(90_000, 2)
  })

  it('passes inherited history on through a chain of transfers', () => {
    const books = [
      ...calls('first', ['2019-01-01', 50_000]),
      ...xfer('transfer', 'a', '2020-01-01', 'first', { second: 50_000 }),
      ...calls('second', ['2021-01-01', 30_000]),
      ...xfer('secondary_transfer', 'b', '2022-01-01', 'second', { third: 80_000 }),
    ]
    const called = calledAfterTransfers(books)
    expect(called.get('first')).toBeCloseTo(0, 2)
    expect(called.get('second')).toBeCloseTo(0, 2)
    expect(called.get('third')).toBeCloseTo(80_000, 2)
  })

  it('splits pro rata when part of an interest moves', () => {
    const books = [
      ...calls('seller', ['2020-01-01', 90_000]),
      ...xfer('secondary_transfer', 'part', '2021-01-01', 'seller', { buyer: 30_000 }),
    ]
    const called = calledAfterTransfers(books)
    expect(called.get('seller')).toBeCloseTo(60_000, 2)
    expect(called.get('buyer')).toBeCloseTo(30_000, 2)
  })

  it('leaves the fund total unchanged', () => {
    const books = [
      ...calls('seller', ['2020-01-01', 90_000]),
      ...calls('other', ['2020-01-01', 90_000]),
      ...xfer('secondary_transfer', 'sale', '2021-01-01', 'seller', { buyer: 90_000 }),
    ]
    const total = Array.from(calledAfterTransfers(books).values()).reduce((s, v) => s + v, 0)
    expect(total).toBeCloseTo(180_000, 2)
  })

  it('does not change how a sale reads for IRR', () => {
    const books = [
      ...calls('seller', ['2020-01-01', 90_000]),
      ...xfer('secondary_transfer', 'sale', '2021-01-01', 'seller', { buyer: 90_000 }),
    ]
    // The IRR flows still treat the sale as the seller's exit and the buyer's purchase.
    const flows = irrFlowPostings(books)
    expect(flows.filter(f => f.lpEntityId === 'seller')).toHaveLength(2)
    expect(flows.filter(f => f.lpEntityId === 'buyer')).toHaveLength(1)
  })
})
