import { describe, it, expect } from 'vitest'
import { clawbackFromPostings, buildClawbackEntry } from './carry-clawback'
import type { CapitalPosting } from './capital-account'

// Debit-positive capital postings: an accrual credits the recipient (negative), a payout debits it.
const gp = 'gp'
const lp = 'lp'

describe('clawbackFromPostings', () => {
  it('owes back the carry paid beyond what was credited', () => {
    const postings: CapitalPosting[] = [
      { lpEntityId: gp, amount: -100_000, sourceType: 'carried_interest' }, // accrued (entitlement)
      { lpEntityId: gp, amount: 150_000, sourceType: 'carry_distribution' }, // paid early
      { lpEntityId: lp, amount: 100_000, sourceType: 'carried_interest' },  // LP side, ignored
    ]
    expect(clawbackFromPostings(postings, [gp])).toEqual([{ lpEntityId: gp, paid: 150_000, owed: 50_000, amount: 50_000 }])
  })

  it('owes nothing when paid is within the entitlement, and nothing twice', () => {
    expect(clawbackFromPostings([
      { lpEntityId: gp, amount: -100_000, sourceType: 'carried_interest' },
      { lpEntityId: gp, amount: 80_000, sourceType: 'carry_distribution' },
    ], [gp])).toEqual([])
    expect(clawbackFromPostings([
      { lpEntityId: gp, amount: -100_000, sourceType: 'carried_interest' },
      { lpEntityId: gp, amount: 150_000, sourceType: 'carry_distribution' },
      { lpEntityId: gp, amount: -50_000, sourceType: 'carry_clawback' },
    ], [gp])).toEqual([])
  })

  it('caps the give-back at the carry paid less tax', () => {
    const postings: CapitalPosting[] = [
      { lpEntityId: gp, amount: 0, sourceType: 'carried_interest' },
      { lpEntityId: gp, amount: 100_000, sourceType: 'carry_distribution' },
    ]
    const [line] = clawbackFromPostings(postings, [gp], 0.4)
    expect(line).toMatchObject({ owed: 100_000, cap: 60_000, amount: 60_000 })
    // Once the cap is booked, nothing more is owed by this close.
    const after = clawbackFromPostings([...postings, { lpEntityId: gp, amount: -60_000, sourceType: 'carry_clawback' }], [gp], 0.4)
    expect(after[0]).toMatchObject({ owed: 40_000, amount: 0 })
  })
})

describe('buildClawbackEntry', () => {
  it('debits the receivable and credits the recipient, balanced', () => {
    const entry = buildClawbackEntry({ fundId: 'f', entryDate: '2030-12-31' }, [{ lpEntityId: gp, paid: 150_000, owed: 50_000, amount: 50_000 }], new Map([[gp, 'cap-gp']]), 'recv')
    expect(entry?.sourceType).toBe('carry_clawback')
    expect(entry?.postings).toEqual([
      { accountId: 'recv', amount: 50_000, currency: 'USD', lpEntityId: gp },
      { accountId: 'cap-gp', amount: -50_000, currency: 'USD', lpEntityId: gp },
    ])
    expect(buildClawbackEntry({ fundId: 'f', entryDate: '2030-12-31' }, [], new Map(), 'recv')).toBeNull()
  })
})
