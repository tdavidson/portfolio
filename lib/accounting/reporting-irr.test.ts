import { describe, expect, it } from 'vitest'
import { resolveCapitalEvidence } from './capital-evidence'
import { reportingIrr } from './reporting-irr'
import { computeCapitalAccounts } from './capital-account'
import { lpIrr } from './live-report'

// An LP-to-LP transfer (a secondary sale or an assignment) moves capital between two partners: it
// debits the seller's capital and credits the buyer's, source_type 'transfer', at the value moved.
const books = [
  { lpEntityId: 'seller', entryDate: '2020-01-01', sourceType: 'contribution', amount: -100_000 },
  { lpEntityId: 'seller', entryDate: '2021-12-31', sourceType: 'valuation', amount: -50_000 },
  { lpEntityId: 'seller', entryDate: '2022-01-01', sourceType: 'transfer', amount: 150_000 },
  { lpEntityId: 'buyer', entryDate: '2022-01-01', sourceType: 'transfer', amount: -150_000 },
  { lpEntityId: 'buyer', entryDate: '2022-12-31', sourceType: 'valuation', amount: -15_000 },
]

function irr(lp: string, asOf: string) {
  const r = resolveCapitalEvidence(books, [], asOf)
  const ending = computeCapitalAccounts(r.postings).get(lp)!.ending
  return reportingIrr(r.postings.filter(p => p.lpEntityId === lp), ending, r.evidenceByLp.get(lp))
}

describe('IRR across an LP-to-LP transfer', () => {
  it("counts the transfer as the seller's exit at the value moved", () => {
    // 100,000 in on 2020-01-01 and 150,000 out on 2022-01-01: about 22.5% a year. Without the
    // transfer the seller has money in and nothing back, so there is no IRR at all.
    const seller = irr('seller', '2022-12-31')
    expect(seller).not.toBeNull()
    expect(seller!).toBeGreaterThan(0.22)
    expect(seller!).toBeLessThan(0.23)
  })

  it("counts it as the buyer's purchase at the value moved", () => {
    // 150,000 in on 2022-01-01, worth 165,000 on 2022-12-31: about 10%. Without the transfer the
    // buyer has a value and no cost, so there is no IRR (or, with later calls, an inflated one).
    const buyer = irr('buyer', '2022-12-31')
    expect(buyer).not.toBeNull()
    expect(buyer!).toBeGreaterThan(0.095)
    expect(buyer!).toBeLessThan(0.105)
  })

  it('agrees with lpIrr', () => {
    const seller = books.filter(p => p.lpEntityId === 'seller')
    expect(lpIrr(seller, 0, '2022-12-31')).toBeCloseTo(irr('seller', '2022-12-31')!, 4)
    const buyer = books.filter(p => p.lpEntityId === 'buyer')
    expect(lpIrr(buyer, 165_000, '2022-12-31')).toBeCloseTo(irr('buyer', '2022-12-31')!, 4)
  })
})
