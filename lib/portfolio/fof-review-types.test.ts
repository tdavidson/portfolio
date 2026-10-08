// lib/portfolio/fof-review-types.test.ts
import { describe, expect, it } from 'vitest'
import { CAPS, applyEdits, checkProposal, isFundReviewType, scopeFundReviews, type FundProposal } from './fof-review-types'

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

describe('applyEdits hardening', () => {
  it('refuses a blank, null or boolean number rather than reading it as zero', () => {
    for (const v of ['', '  ', null, true, false, []]) {
      expect(applyEdits(navP, { reportedNav: v })).toMatchObject({ error: expect.any(String) })
      expect(applyEdits(call, { amount: v })).toMatchObject({ error: expect.any(String) })
    }
  })
  it('refuses a date that has the shape but is not on the calendar', () => {
    expect(applyEdits(call, { eventDate: '2025-13-45' })).toMatchObject({ error: expect.stringMatching(/date/) })
    expect(applyEdits(navP, { asOfDate: '2025-02-30' })).toMatchObject({ error: expect.stringMatching(/date/) })
    expect(applyEdits(call, { dueDate: '2025-00-10' })).toMatchObject({ error: expect.stringMatching(/date/) })
  })
  it('caps an edited notice number and purpose', () => {
    const r: any = applyEdits(call, { noticeNumber: 'n'.repeat(500), purpose: 'p'.repeat(900) })
    expect(r.noticeNumber).toHaveLength(CAPS.noticeNumber)
    expect(r.purpose).toHaveLength(CAPS.purpose)
  })
})

describe('checkProposal', () => {
  it('passes a well-formed proposal whose kind matches the review type', () => {
    expect(checkProposal('fund_nav', navP)).toBe(navP)
    expect(checkProposal('fund_capital_call', call)).toBe(call)
    expect(checkProposal('fund_distribution', { ...call, kind: 'distribution' })).toMatchObject({ kind: 'distribution' })
  })
  it('refuses a kind that does not match its type, and anything out of range or not a proposal', () => {
    expect(checkProposal('fund_capital_call', navP)).toHaveProperty('error')
    expect(checkProposal('low_confidence', navP)).toHaveProperty('error')
    for (const p of [null, 'nav', [], {}, { ...navP, reportedNav: -1 }, { ...navP, reportedNav: Infinity }, { ...navP, asOfDate: '30/09/2025' },
      { ...call, amount: 0 }, { ...call, amount: '5' }, { ...call, dueDate: '2025-02-30' }, { ...call, noticeNumber: 7 }]) {
      expect(checkProposal(typeof p === 'object' && p && 'kind' in p && p.kind === 'nav' ? 'fund_nav' : 'fund_capital_call', p)).toHaveProperty('error')
    }
  })
})
