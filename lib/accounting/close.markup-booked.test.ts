import { describe, expect, it } from 'vitest'
import { markupPostings } from './close'
import { computeCapitalAccounts } from './capital-account'

// The associate markup reconciles each member's line to a target. "Already booked" must be what
// earlier markups posted, not the associate's own income and expenses, which share the buckets.
describe('markupPostings', () => {
  const postings = [
    // The associate's own legal fee, allocated to a member (no markup asset account on its entry).
    { entryId: 'own-fee', lpEntityId: 'm1', amount: 2_000, sourceType: 'partnership_expense' },
    // Its own bank interest.
    { entryId: 'own-interest', lpEntityId: 'm1', amount: -50, sourceType: 'income' },
    // An earlier close's markup: the member's share of the fund's expenses and carry.
    { entryId: 'markup-1', lpEntityId: 'm1', amount: 300, sourceType: 'partnership_expense' },
    { entryId: 'markup-2', lpEntityId: 'm1', amount: -10_000, sourceType: 'carried_interest' },
    // A member contribution recorded against the investment account on an older chart.
    { entryId: 'markup-1', lpEntityId: 'm1', amount: -1_000, sourceType: 'contribution' },
    // Carry paid out, which the close adds back to the carry line.
    { entryId: 'paid', lpEntityId: 'm1', amount: 4_000, sourceType: 'carry_distribution' },
  ]
  const markupIds = new Set(['markup-1', 'markup-2'])

  it('keeps only earlier markups and carry paid', () => {
    expect(markupPostings(postings, markupIds).map(p => p.entryId)).toEqual(['markup-1', 'markup-2', 'paid'])
  })

  it("leaves the associate's own expenses out of the booked expense line", () => {
    const booked = computeCapitalAccounts(markupPostings(postings, markupIds)).get('m1')!
    expect(booked.expenses).toBe(computeCapitalAccounts([postings[2]]).get('m1')!.expenses)
    expect(booked.operatingIncome).toBe(0)
  })
})
