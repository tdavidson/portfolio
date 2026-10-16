import { describe, it, expect } from 'vitest'
import { positionsToPostings, type LpPosition } from './lp-positions'
import { computeCapitalAccounts } from './capital-account'

const pos = (p: Partial<LpPosition> & { lpEntityId: string; asOfDate: string }): LpPosition => ({
  commitment: null, calledCapital: null, distributions: null, nav: null, ...p,
})

// The producer's whole job: dated cumulative positions → delta postings that, summed, recover
// the cumulative position. If this is wrong, every tracking vehicle's capital is wrong.
describe('positionsToPostings', () => {
  it('a single position emits its full cumulative figures (delta from zero)', () => {
    const postings = positionsToPostings([
      pos({ lpEntityId: 'a', asOfDate: '2026-03-31', calledCapital: 400_000, distributions: 100_000, nav: 600_000 }),
    ])
    const acct = computeCapitalAccounts(postings).get('a')!
    expect(acct.contributions).toBe(400_000)
    expect(acct.distributions).toBe(-100_000)   // stored negative on the account
    expect(acct.ending).toBe(600_000)
  })

  it('two dated positions produce the CHANGE at the second date', () => {
    const postings = positionsToPostings([
      pos({ lpEntityId: 'a', asOfDate: '2026-03-31', calledCapital: 400_000, distributions: 0, nav: 400_000 }),
      pos({ lpEntityId: 'a', asOfDate: '2026-06-30', calledCapital: 500_000, distributions: 50_000, nav: 700_000 }),
    ])
    // Summing everything ≤ 6/30 recovers the 6/30 cumulative.
    const all = computeCapitalAccounts(postings).get('a')!
    expect(all.contributions).toBe(500_000)
    expect(all.distributions).toBe(-50_000)
    expect(all.ending).toBe(700_000)

    // The delta postings land on the actual dates, so a period slice works.
    const q2 = postings.filter(p => p.entryDate === '2026-06-30')
    const contrib = q2.find(p => p.sourceType === 'capital_call')!
    expect(contrib.amount).toBe(-100_000)   // called went 400k → 500k
    const dist = q2.find(p => p.sourceType === 'distribution')!
    expect(dist.amount).toBe(50_000)
  })

  it('as-of an intermediate date recovers the earlier position, not the later one', () => {
    const all = positionsToPostings([
      pos({ lpEntityId: 'a', asOfDate: '2026-03-31', calledCapital: 400_000, nav: 400_000 }),
      pos({ lpEntityId: 'a', asOfDate: '2026-06-30', calledCapital: 500_000, nav: 700_000 }),
    ])
    // Emulate loadPositions(asOf='2026-04-30'): only the 3/31 position is in scope.
    const asOfApril = positionsToPostings([
      pos({ lpEntityId: 'a', asOfDate: '2026-03-31', calledCapital: 400_000, nav: 400_000 }),
    ])
    expect(computeCapitalAccounts(asOfApril).get('a')!.ending).toBe(400_000)
    expect(computeCapitalAccounts(all).get('a')!.ending).toBe(700_000)
  })

  it('handles irregular gaps between dates without inventing intermediate movement', () => {
    // 3/31 then a jump to 11/15 — the delta lands entirely on 11/15.
    const postings = positionsToPostings([
      pos({ lpEntityId: 'a', asOfDate: '2026-03-31', calledCapital: 100_000, nav: 100_000 }),
      pos({ lpEntityId: 'a', asOfDate: '2026-11-15', calledCapital: 100_000, distributions: 250_000, nav: 0 }),
    ])
    const nov = postings.filter(p => p.entryDate === '2026-11-15')
    // No new capital called; a 250k distribution; NAV fell to 0 (gain went 0 → 150k realized-ish).
    expect(nov.find(p => p.sourceType === 'capital_call')).toBeUndefined()
    expect(nov.find(p => p.sourceType === 'distribution')!.amount).toBe(250_000)
    expect(computeCapitalAccounts(postings).get('a')!.ending).toBe(0)
  })

  it('a stored NAV of 0 is respected (realized position), not treated as missing', () => {
    // The Alice case, at the source: nav=0 is a real value.
    const postings = positionsToPostings([
      pos({ lpEntityId: 'a', asOfDate: '2026-03-31', calledCapital: 50_000, distributions: 140_000, nav: 0 }),
    ])
    expect(computeCapitalAccounts(postings).get('a')!.ending).toBe(0)
  })

  it('keeps entities independent', () => {
    const postings = positionsToPostings([
      pos({ lpEntityId: 'a', asOfDate: '2026-03-31', calledCapital: 100_000, nav: 100_000 }),
      pos({ lpEntityId: 'b', asOfDate: '2026-03-31', calledCapital: 200_000, nav: 250_000 }),
    ])
    const accts = computeCapitalAccounts(postings)
    expect(accts.get('a')!.ending).toBe(100_000)
    expect(accts.get('b')!.ending).toBe(250_000)
  })
})
