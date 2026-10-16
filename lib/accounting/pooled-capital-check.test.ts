import { describe, it, expect } from 'vitest'
import { describeStrandedCapital } from './pooled-capital-check'
import { commitmentFigures } from './capital-calls'

describe('describeStrandedCapital', () => {
  it('is silent when nothing sits on the pooled account', () => {
    const s = describeStrandedCapital({ pooledPostings: 0, pooledAmount: 0, taggedPostings: 0, perLpAccounts: 20 })
    expect(s.stranded).toBe(false)
    expect(s.message).toBeNull()
  })

  it('is silent when the pooled postings net to zero', () => {
    // Receipts booked to the pool then reclassed to each partner, plus reversed entries.
    const s = describeStrandedCapital({ pooledPostings: 75, pooledAmount: 0, taggedPostings: 0, perLpAccounts: 61 })
    expect(s.stranded).toBe(false)
    expect(s.message).toBeNull()
  })

  it('still flags a balance of a few cents', () => {
    const s = describeStrandedCapital({ pooledPostings: 2, pooledAmount: -0.05, taggedPostings: 0, perLpAccounts: 3 })
    expect(s.stranded).toBe(true)
  })

  it('flags capital pooled with not one partner account', () => {
    const s = describeStrandedCapital({ pooledPostings: 10, pooledAmount: -250_000, taggedPostings: 8, perLpAccounts: 0 })
    expect(s.stranded).toBe(true)
    expect(s.message).toContain('10 postings')
    expect(s.message).toContain('$250,000')
    expect(s.message).toContain('No partner has a capital account')
    // The tagged/untagged split is what decides whether the repair can run unattended.
    expect(s.message).toContain('8 can be attributed automatically; 2 carry no LP')
  })

  it('still flags a HALF-attributed vehicle, and says why that is worse', () => {
    const s = describeStrandedCapital({ pooledPostings: 3, pooledAmount: -100, taggedPostings: 3, perLpAccounts: 12 })
    expect(s.stranded).toBe(true)
    expect(s.message).toContain('makes the rest look like real zeroes')
    expect(s.message).toContain('All 3 can be attributed automatically')
  })
})

describe('commitmentFigures — funded can never be negative', () => {
  it('computes the normal case unchanged', () => {
    const f = commitmentFigures(100_000, 60_000, 10_000)
    expect(f).toMatchObject({ commitment: 100_000, called: 60_000, funded: 50_000, outstanding: 40_000, receivable: 10_000 })
    expect(f.fundedUnderflow).toBe(false)
  })

  it('clamps and flags the impossible case instead of reporting negative cash', () => {
    // The stranded-capital reading: called=0 because capital never reached the LP's own
    // account, while the 1300 receivable stands. funded would be -commitment.
    const f = commitmentFigures(25_000, 0, 25_000)
    expect(f.funded).toBe(0)
    expect(f.fundedUnderflow).toBe(true)
    // Committed and outstanding are still meaningful — only funded was impossible.
    expect(f.commitment).toBe(25_000)
    expect(f.outstanding).toBe(25_000)
  })

  it('does not flag a sub-cent rounding artefact', () => {
    const f = commitmentFigures(100, 50, 50.004)
    expect(f.fundedUnderflow).toBe(false)
  })

  it('leaves an LP with no receivable alone', () => {
    const f = commitmentFigures(25_000, 0, 0)
    expect(f.funded).toBe(0)
    expect(f.fundedUnderflow).toBe(false)
  })
})
