import { describe, it, expect } from 'vitest'
import { reportK1Dependencies, shouldExpectK1, type ReceivedK1 } from './received-k1s'

function k1(over: Partial<ReceivedK1> & Pick<ReceivedK1, 'companyId' | 'companyName'>): ReceivedK1 {
  return { taxYear: 2026, status: 'expected', receivedDate: null, ...over }
}

describe('shouldExpectK1', () => {
  it('expects one from a fund holding, which files a partnership return', () => {
    expect(shouldExpectK1('fund')).toBe(true)
  })

  it('expects nothing from a company or a token', () => {
    // A portfolio company files its own return and sends us nothing; a token has no return.
    expect(shouldExpectK1('company')).toBe(false)
    expect(shouldExpectK1('crypto')).toBe(false)
    expect(shouldExpectK1(null)).toBe(false)
  })
})

describe('reportK1Dependencies', () => {
  it('blocks while an underlying fund has not delivered', () => {
    const r = reportK1Dependencies([k1({ companyId: 'a', companyName: 'Larchwood XI' })], 2026)
    expect(r.outstanding).toHaveLength(1)
    expect(r.blocker).toContain('Larchwood XI')
    expect(r.blocker).toContain('provisional')
  })

  it('does not block once everything has arrived', () => {
    const r = reportK1Dependencies(
      [k1({ companyId: 'a', companyName: 'Larchwood XI', status: 'received', receivedDate: '2027-08-01' })],
      2026,
    )
    expect(r.blocker).toBeNull()
    expect(r.received).toBe(1)
  })

  it('does NOT block on an upstream amendment', () => {
    // An amendment means our figures are wrong, but refusing to close for it is backwards: the
    // year needs closing so the amendment can be made against a stable base, and the amendment
    // path reopens deliberately.
    const r = reportK1Dependencies([k1({ companyId: 'a', companyName: 'Larchwood IX', status: 'amended' })], 2026)
    expect(r.blocker).toBeNull()
    expect(r.amended).toHaveLength(1)
  })

  it('does not chase a holding marked not expected', () => {
    // The position closed before the year, or the holding is not a partnership.
    const r = reportK1Dependencies([k1({ companyId: 'a', companyName: 'Old Fund', status: 'not_expected' })], 2026)
    expect(r.outstanding).toEqual([])
    expect(r.blocker).toBeNull()
  })

  it('names the funds so the manager knows who to chase', () => {
    const r = reportK1Dependencies(
      [
        k1({ companyId: 'a', companyName: 'Alpha Fund' }),
        k1({ companyId: 'b', companyName: 'Beta Fund' }),
      ],
      2026,
    )
    expect(r.blocker).toContain('Alpha Fund')
    expect(r.blocker).toContain('Beta Fund')
    expect(r.blocker).toContain('2 underlying funds have not delivered')
  })

  it('truncates a long list rather than printing forty names', () => {
    const many = Array.from({ length: 8 }, (_, i) => k1({ companyId: `c${i}`, companyName: `Fund ${i}` }))
    const r = reportK1Dependencies(many, 2026)
    expect(r.blocker).toContain('and 3 more')
  })

  it('says "has" for one fund and "have" for several', () => {
    expect(reportK1Dependencies([k1({ companyId: 'a', companyName: 'A' })], 2026).blocker).toContain('fund has not')
    expect(
      reportK1Dependencies(
        [k1({ companyId: 'a', companyName: 'A' }), k1({ companyId: 'b', companyName: 'B' })],
        2026,
      ).blocker,
    ).toContain('funds have not')
  })

  it('ignores other years entirely', () => {
    const r = reportK1Dependencies([k1({ companyId: 'a', companyName: 'A', taxYear: 2025 })], 2026)
    expect(r.outstanding).toEqual([])
    expect(r.blocker).toBeNull()
  })

  it('is clean for a fund that holds no funds at all', () => {
    const r = reportK1Dependencies([], 2026)
    expect(r).toMatchObject({ outstanding: [], amended: [], received: 0, blocker: null })
  })
})
