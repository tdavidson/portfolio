// lib/portfolio/fof-review-types.test.ts
import { describe, expect, it } from 'vitest'
import { applyEdits, isFundReviewType, scopeFundReviews, type FundProposal } from './fof-review-types'

const call: FundProposal = {
  kind: 'call', eventDate: '2025-09-30', dueDate: null, noticeNumber: null, purpose: null, amount: 1_250_000,
  dateAssumed: true, fundName: 'Meridian Growth Partners IV', confidence: 'high', sourceText: null,
}
const navP: FundProposal = { kind: 'nav', asOfDate: '2025-09-30', reportedNav: 9_445_000, fundName: 'Meridian Growth Partners IV', confidence: 'high', sourceText: null }

describe('scopeFundReviews', () => {
  const rows = [
    { id: 'a', issue_type: 'fund_nav', vehicle_id: 'v1' },
    { id: 'b', issue_type: 'fund_nav', vehicle_id: 'v2' },
    { id: 'c', issue_type: 'fund_capital_call', vehicle_id: null },
    { id: 'd', issue_type: 'low_confidence', vehicle_id: null },
  ]
  it('a scoped member sees their entity\'s fund reviews and every other review, not another entity\'s or an unassigned one', () => {
    expect(scopeFundReviews(rows, { vehicles: { all: false, ids: ['v1'] } }).map(r => r.id)).toEqual(['a', 'd'])
  })
  it('an unscoped caller sees all', () => {
    expect(scopeFundReviews(rows, { vehicles: { all: true, ids: [] } })).toHaveLength(4)
  })
  it('knows its issue types', () => {
    expect(isFundReviewType('fund_distribution')).toBe(true)
    expect(isFundReviewType('low_confidence')).toBe(false)
  })
})

describe('applyEdits', () => {
  it('returns the proposal unchanged with no edits', () => {
    expect(applyEdits(call, undefined)).toBe(call)
  })
  it('corrects a call\'s date and amount, and the date is no longer assumed', () => {
    expect(applyEdits(call, { eventDate: '2025-08-12', amount: '1250000', noticeNumber: ' No. 7 ' }))
      .toMatchObject({ eventDate: '2025-08-12', amount: 1_250_000, noticeNumber: 'No. 7', dateAssumed: false })
  })
  it('refuses a date that is not a date, a negative NAV, and a field the proposal does not have', () => {
    expect(applyEdits(call, { eventDate: '12 Aug' })).toMatchObject({ error: expect.stringMatching(/date/) })
    expect(applyEdits(navP, { reportedNav: -1 })).toMatchObject({ error: expect.stringMatching(/negative/) })
    expect(applyEdits(navP, { amount: 5 })).toMatchObject({ error: expect.stringMatching(/cannot be changed/) })
  })
})
