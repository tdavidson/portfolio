import { describe, expect, it } from 'vitest'
import { resolveCapitalEvidence } from './capital-evidence'
import { reportingIrr } from './reporting-irr'
import { computeCapitalAccounts } from './capital-account'
import { resolveDatedCommitments } from './terms'

const position = { lpEntityId: 'lp', asOfDate: '2025-03-31', commitment: 200, calledCapital: 100, distributions: 0, nav: 120, irr: 0.12 }
const ledger = [
  { lpEntityId: 'lp', entryDate: '2025-01-01', sourceType: 'contribution', amount: -100 },
  { lpEntityId: 'lp', entryDate: '2025-03-31', sourceType: 'valuation', amount: -20 },
]

describe('capital evidence resolution', () => {
  it('reports the books over an import they disagree with, flagging the difference and never adding the two', () => {
    const r = resolveCapitalEvidence(ledger.slice(0, 1), [position], '2025-04-30')
    expect(computeCapitalAccounts(r.postings).get('lp')?.ending).toBe(100)
    expect(r.evidenceByLp.get('lp')).toMatchObject({
      basis: 'ledger', conflict: true, asOf: '2025-04-30', reviewed: false,
      anchor: { agreesWithBooks: false, variance: { contributions: 0, distributions: 0, nav: -20 } },
    })
  })
  it('calculates an IRR from books that disagree with an import', () => {
    const books = [
      { lpEntityId: 'lp', entryDate: '2023-01-01', sourceType: 'contribution', amount: -100 },
      { lpEntityId: 'lp', entryDate: '2024-12-31', sourceType: 'valuation', amount: -21 },
    ]
    const r = resolveCapitalEvidence(books, [{ ...position, asOfDate: '2024-12-31' }], '2024-12-31')
    const evidence = r.evidenceByLp.get('lp')!
    expect(evidence).toMatchObject({ basis: 'ledger', conflict: true })
    expect(reportingIrr(r.postings, 121, evidence)).toBeCloseTo(0.1, 2)
  })
  it('ignores a chart and unrelated activity when selecting capital information', () => {
    expect(resolveCapitalEvidence([], [position]).evidenceByLp.get('lp')?.basis).toBe('reported')
    const r = resolveCapitalEvidence([{ ...ledger[0], lpEntityId: 'other' }], [position])
    expect(r.evidenceByLp.get('lp')?.basis).toBe('reported')
    expect(r.evidenceByLp.get('other')?.basis).toBe('ledger')
  })
  it('uses reconciled books through the reviewed date and never doubles opening records', () => {
    const r = resolveCapitalEvidence(ledger, [position], '2025-03-31', '2025-03-31')
    expect(r.postings).toEqual(ledger)
    expect(computeCapitalAccounts(r.postings).get('lp')?.ending).toBe(120)
  })
  it('reports later activity before it is reviewed, labelled unreviewed', () => {
    const r = resolveCapitalEvidence([...ledger, { ...ledger[1], entryDate: '2025-04-20', amount: 5 }], [position], '2025-04-30', '2025-03-31')
    expect(r.evidenceByLp.get('lp')).toMatchObject({ basis: 'ledger', asOf: '2025-04-30', reviewed: false, values: { nav: 115 } })
    const closed = resolveCapitalEvidence(ledger, [position], '2025-03-31', '2025-03-31')
    expect(closed.evidenceByLp.get('lp')?.reviewed).toBe(true)
  })
  it('does not turn missing fields into evidence of zero', () => {
    const r = resolveCapitalEvidence([], [{ ...position, nav: null }])
    expect(r.evidenceByLp.get('lp')?.missing).toEqual(['nav'])
    expect(r.postings).toEqual([])
  })
  it('keeps a confirmed zero NAV', () => {
    const r = resolveCapitalEvidence([], [{ ...position, nav: 0 }])
    expect(r.evidenceByLp.get('lp')?.missing).toEqual([])
    expect(computeCapitalAccounts(r.postings).get('lp')?.ending).toBe(0)
  })
  it('uses reported IRR but never derives it from statement movement dates', () => {
    const r = resolveCapitalEvidence([], [position])
    expect(reportingIrr(r.postings, 120, r.evidenceByLp.get('lp'))).toBe(0.12)
    const without = resolveCapitalEvidence([], [{ ...position, irr: null }])
    expect(reportingIrr(without.postings, 120, without.evidenceByLp.get('lp'))).toBeNull()
  })
  it('excludes future observations and journal entries', () => {
    const r = resolveCapitalEvidence(ledger, [position], '2024-12-31')
    expect(r.postings).toEqual([])
    expect(r.evidenceByLp.size).toBe(0)
  })
})

describe('statement observations an opening entry represents', () => {
  // A cutover: the books start at the March statement, booked as one opening entry.
  const anchored = { ...position, id: 'pos-march' }
  const opening = [{ lpEntityId: 'lp', entryDate: '2025-03-31', sourceType: 'opening_balance', amount: -120, entryId: 'open-1' }]
  const link = { lpEntityId: 'lp', positionId: 'pos-march', entryId: 'open-1', observedOn: '2025-03-31', observedNav: 120, bookedAmount: 120 }

  it('stops a represented observation from competing with the books that represent it', () => {
    // WITHOUT the link the statement is a competing anchor: the books still report, but the
    // opening entry says nothing about contributions, so the two disagree and it is flagged.
    const inferred = resolveCapitalEvidence(opening, [anchored], '2025-04-30')
    expect(inferred.evidenceByLp.get('lp')).toMatchObject({ basis: 'ledger', conflict: true })
    // WITH it, the statement is not a second representation of the same fact, so the books win
    // and the 120 is counted exactly once.
    const linked = resolveCapitalEvidence(opening, [anchored], '2025-04-30', null, undefined, [link])
    const evidence = linked.evidenceByLp.get('lp')!
    expect(evidence.basis).toBe('ledger')
    expect(evidence.values.nav).toBe(120)
    expect(computeCapitalAccounts(linked.postings).get('lp')?.ending).toBe(120)
    expect(evidence.representedObservations).toEqual([
      { positionId: 'pos-march', date: '2025-03-31', entryId: 'open-1', restated: false },
    ])
    // The observation is still disclosed; it is just no longer an anchor.
    expect(evidence.observationDates).toEqual(['2025-03-31'])
  })

  it('checks the books against a later statement they do not represent', () => {
    const june = { ...position, id: 'pos-june', asOfDate: '2025-06-30', nav: 140 }
    const evidence = resolveCapitalEvidence(opening, [anchored, june], '2025-07-31', null, undefined, [link])
      .evidenceByLp.get('lp')!
    expect(evidence).toMatchObject({ basis: 'ledger', conflict: true, anchor: { date: '2025-06-30', variance: { nav: -20 } } })
    expect(evidence.values.nav).toBe(120)
  })

  it('surfaces a statement restated after the books were started from it', () => {
    const restated = { ...anchored, nav: 125 }
    const evidence = resolveCapitalEvidence(opening, [restated], '2025-04-30', null, undefined, [link]).evidenceByLp.get('lp')!
    expect(evidence.conflict).toBe(true)
    expect(evidence.representedObservations?.[0].restated).toBe(true)
  })

  it('does not calculate an IRR from an opening balance', () => {
    // An opening balance is a starting position, not a dated cash flow.
    expect(resolveCapitalEvidence(opening, [anchored], '2025-04-30', null, undefined, [link])
      .evidenceByLp.get('lp')?.canCalculateIrr).toBe(false)
  })

  it('returns the statement to anchor duty if the entry representing it is gone', () => {
    // A voided or deleted opening entry leaves its link row behind (it is only dropped when the
    // entry row is). The statement must go back to anchoring rather than staying suppressed by a
    // representation that no longer exists — only a link whose entry is actually in this
    // partner's posted ledger counts.
    const evidence = resolveCapitalEvidence([], [anchored], '2025-04-30', null, undefined, [link]).evidenceByLp.get('lp')!
    expect(evidence.representedObservations).toBeUndefined()
    expect(evidence).toMatchObject({ basis: 'reported', asOf: '2025-03-31' })
    expect(evidence.values.nav).toBe(120)
  })

  it('does not let one partner\'s cutover suppress another\'s statement', () => {
    const other = { ...position, id: 'pos-other', lpEntityId: 'other' }
    const result = resolveCapitalEvidence(opening, [anchored, other], '2025-04-30', null, undefined, [link])
    expect(result.evidenceByLp.get('lp')?.basis).toBe('ledger')
    expect(result.evidenceByLp.get('other')).toMatchObject({ basis: 'reported', asOf: '2025-03-31' })
  })
})

describe('dated commitments', () => {
  const owners = [{ lpEntityId: 'lp', commitment: 999 }, { lpEntityId: 'other', commitment: 50 }]
  it('keeps a zero event balance and does not erase an unrelated partner', () => {
    const events = [{ lpEntityId: 'lp', effectiveDate: '2025-01-01', amount: 100, kind: 'initial' }, { lpEntityId: 'lp', effectiveDate: '2025-02-01', amount: -100, kind: 'transfer' }]
    expect(resolveDatedCommitments(events, owners, [])).toEqual(new Map([['other', 50], ['lp', 0]]))
  })
  it('does not pull a future commitment back into historical reports', () => {
    const events = [{ lpEntityId: 'lp', effectiveDate: '2025-06-01', amount: 999, kind: 'initial' }]
    expect(resolveDatedCommitments(events, owners, [], '2025-01-01').has('lp')).toBe(false)
  })
  it('moves a transfer between partners without changing the fund total', () => {
    // The real kinds terms.ts writes for a transfer, as a signed pair. The resolver sums amounts
    // and ignores the label, so both legs land on their own partner and the total is preserved —
    // an aggregate that reconciles to the same population is the invariant here.
    const events = [
      { lpEntityId: 'lp', effectiveDate: '2025-01-01', amount: 100, kind: 'initial' },
      { lpEntityId: 'other', effectiveDate: '2025-01-01', amount: 50, kind: 'initial' },
      { lpEntityId: 'lp', effectiveDate: '2025-06-01', amount: -40, kind: 'transfer_out' },
      { lpEntityId: 'other', effectiveDate: '2025-06-01', amount: 40, kind: 'transfer_in' },
    ]
    const before = resolveDatedCommitments(events, owners, [], '2025-05-31')
    const after = resolveDatedCommitments(events, owners, [], '2025-12-31')
    expect([before.get('lp'), before.get('other')]).toEqual([100, 50])
    expect([after.get('lp'), after.get('other')]).toEqual([60, 90])
    const total = (m: Map<string, number>) => Array.from(m.values()).reduce((sum, value) => sum + value, 0)
    expect(total(after)).toBe(total(before))
  })
  it('applies later event deltas to the statement anchor exactly once', () => {
    const events = [{ lpEntityId: 'lp', effectiveDate: '2025-03-31', amount: 200, kind: 'initial' }, { lpEntityId: 'lp', effectiveDate: '2025-04-01', amount: -50, kind: 'transfer' }]
    expect(resolveDatedCommitments(events, owners, [position]).get('lp')).toBe(150)
    expect(resolveDatedCommitments(events, owners, [position], '2025-03-31').get('lp')).toBe(200)
  })
})


describe('reviewed coverage', () => {
  const later = [...ledger, { ...ledger[1], entryDate: '2025-05-20', amount: 5 }]
  it('labels the books unreviewed when there is a gap between closed periods', () => {
    const result = resolveCapitalEvidence(later, [position], '2025-05-31', '2025-05-31', [
      { start: '2025-03-01', end: '2025-03-31' }, { start: '2025-05-01', end: '2025-05-31' },
    ])
    expect(result.evidenceByLp.get('lp')).toMatchObject({ basis: 'ledger', reviewed: false, values: { nav: 115 } })
  })
  it('labels the books reviewed through contiguous closed periods, counting activity exactly once', () => {
    const result = resolveCapitalEvidence(later, [position], '2025-05-31', null, [
      { start: '2025-04-01', end: '2025-05-31' }, { start: '2025-03-01', end: '2025-03-31' },
    ])
    expect(result.evidenceByLp.get('lp')).toMatchObject({ basis: 'ledger', reviewed: true, values: { nav: 115 } })
  })
  it('reports known-field differences even if another statement field is missing', () => {
    const result = resolveCapitalEvidence(ledger, [{ ...position, calledCapital: 90, nav: null }])
    expect(result.evidenceByLp.get('lp')).toMatchObject({
      conflict: true, missing: [], values: { nav: 120 },
      anchor: { variance: { contributions: 10, nav: null } },
    })
  })
})
