import { describe, expect, it } from 'vitest'
import { resolveCapitalEvidence } from './capital-evidence'
import { reportingIrr } from './reporting-irr'
import { computeCapitalAccounts, type CapitalPosting } from './capital-account'
import { lpIrr } from './live-report'
import { irrFlowPostings } from './irr-flows'

// An LP-to-LP transfer moves capital between two partners: it debits the seller's capital and
// credits the buyer's at the value moved. 'secondary_transfer' is a sale; 'transfer' is an
// assignment, where the new holder takes over the old holder's history.
const transferBooks = (sourceType: string, moved = 150_000) => [
  { lpEntityId: 'seller', entryDate: '2020-01-01', sourceType: 'contribution', amount: -100_000 },
  { lpEntityId: 'seller', entryDate: '2021-12-31', sourceType: 'valuation', amount: -50_000 },
  { lpEntityId: 'seller', entryDate: '2022-01-01', sourceType, amount: moved, entryId: 'xfer' },
  { lpEntityId: 'buyer', entryDate: '2022-01-01', sourceType, amount: -moved, entryId: 'xfer' },
  { lpEntityId: 'buyer', entryDate: '2022-12-31', sourceType: 'valuation', amount: -(moved / 10) },
  { lpEntityId: 'seller', entryDate: '2022-12-31', sourceType: 'valuation', amount: -((150_000 - moved) / 10) },
]

function irr(books: CapitalPosting[], lp: string, asOf: string) {
  const r = resolveCapitalEvidence(books, [], asOf)
  const ending = computeCapitalAccounts(r.postings).get(lp)!.ending
  return reportingIrr(irrFlowPostings(r.postings).filter(p => p.lpEntityId === lp), ending, r.evidenceByLp.get(lp))
}

describe('IRR across a secondary sale', () => {
  const books = transferBooks('secondary_transfer')

  it("counts it as the seller's exit at the value moved", () => {
    // 100,000 in on 2020-01-01 and 150,000 out on 2022-01-01: about 22.5% a year.
    const seller = irr(books, 'seller', '2022-12-31')
    expect(seller).not.toBeNull()
    expect(seller!).toBeGreaterThan(0.22)
    expect(seller!).toBeLessThan(0.23)
  })

  it("counts it as the buyer's purchase at the value moved", () => {
    // 150,000 in on 2022-01-01, worth 165,000 on 2022-12-31: about 10%.
    const buyer = irr(books, 'buyer', '2022-12-31')
    expect(buyer).not.toBeNull()
    expect(buyer!).toBeGreaterThan(0.095)
    expect(buyer!).toBeLessThan(0.105)
  })

  it('agrees with lpIrr', () => {
    const flows = irrFlowPostings(books)
    expect(lpIrr(flows.filter(p => p.lpEntityId === 'seller'), 0, '2022-12-31')).toBeCloseTo(irr(books, 'seller', '2022-12-31')!, 4)
    expect(lpIrr(flows.filter(p => p.lpEntityId === 'buyer'), 165_000, '2022-12-31')).toBeCloseTo(irr(books, 'buyer', '2022-12-31')!, 4)
  })
})

describe('IRR across an assignment', () => {
  it('hands the whole history to the new holder when the whole position moves', () => {
    const books = transferBooks('transfer')
    // Not a sale: the seller has no exit, and nothing is left with them.
    expect(irr(books, 'seller', '2022-12-31')).toBeNull()
    // The buyer holds the original 100,000 from 2020-01-01, worth 165,000 three years on: about 18.2%.
    const buyer = irr(books, 'buyer', '2022-12-31')
    expect(buyer!).toBeGreaterThan(0.18)
    expect(buyer!).toBeLessThan(0.185)
  })

  it('splits the history pro rata when part of the position moves', () => {
    // A third of 150,000 moves: each side keeps the original return from 2020-01-01.
    const books = transferBooks('transfer', 50_000)
    const flows = irrFlowPostings(books)
    const contributed = (lp: string) => flows.filter(p => p.lpEntityId === lp).reduce((s, p) => s - p.amount, 0)
    expect(contributed('seller')).toBeCloseTo(66_666.67, 1)
    expect(contributed('buyer')).toBeCloseTo(33_333.33, 1)
    expect(irr(books, 'seller', '2022-12-31')!).toBeCloseTo(irr(books, 'buyer', '2022-12-31')!, 6)
  })

  it('passes inherited history on through a second assignment', () => {
    const books = [
      { lpEntityId: 'a', entryDate: '2020-01-01', sourceType: 'contribution', amount: -100 },
      { lpEntityId: 'a', entryDate: '2021-01-01', sourceType: 'transfer', amount: 100, entryId: 'x1' },
      { lpEntityId: 'b', entryDate: '2021-01-01', sourceType: 'transfer', amount: -100, entryId: 'x1' },
      { lpEntityId: 'b', entryDate: '2022-01-01', sourceType: 'transfer', amount: 100, entryId: 'x2' },
      { lpEntityId: 'c', entryDate: '2022-01-01', sourceType: 'transfer', amount: -100, entryId: 'x2' },
    ]
    const flows = irrFlowPostings(books)
    expect(flows).toEqual([expect.objectContaining({ lpEntityId: 'c', entryDate: '2020-01-01', amount: -100 })])
  })

  it('leaves the fund-wide flows unchanged', () => {
    const books = transferBooks('transfer', 50_000)
    const total = (ps: CapitalPosting[]) => ps.reduce((s, p) => s + p.amount, 0)
    expect(total(irrFlowPostings(books))).toBeCloseTo(-100_000, 6)
  })

  it('leaves out a transfer whose other leg was never recorded', () => {
    const books = [
      { lpEntityId: 'a', entryDate: '2020-01-01', sourceType: 'contribution', amount: -100 },
      { lpEntityId: 'a', entryDate: '2021-01-01', sourceType: 'transfer', amount: 100 },
    ]
    expect(irrFlowPostings(books)).toEqual([books[0]])
  })
})
