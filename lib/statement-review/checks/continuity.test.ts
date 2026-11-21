import { describe, expect, it } from 'vitest'
import { continuity } from './continuity'
import { acme, ctx, northwind, pkg } from './fixtures'

const prior = {
  periodEnd: '2026-06-30',
  partners: [
    acme({ ending: 500_000, paidInToDate: 500_000, distributedToDate: 0 }),
    northwind({ ending: 250_000, paidInToDate: 250_000, distributedToDate: 0 }),
  ],
}

describe('continuity', () => {
  it("says it can't run with no earlier review", () => {
    expect(continuity({ pkg: pkg(), prior: null }, ctx).outcome).toMatchObject({ ran: false })
  })

  it('carries on from the last review', () => {
    const r = continuity({ pkg: pkg(), prior }, ctx)
    expect(r.outcome.ran).toBe(true)
    expect(r.findings).toEqual([])
  })

  it('flags a beginning balance that moved', () => {
    const r = continuity({ pkg: pkg({ partners: [acme({ beginning: 510_000 }), northwind()] }), prior }, ctx)
    expect(r.findings[0]).toMatchObject({ check: 'continuity', stated: 510_000, expected: 500_000 })
    expect(r.findings[0].message).toMatch(/2026-06-30 statement ended at 500,000.00/)
  })

  it('carries paid-in to date forward with the period contributions', () => {
    const r = continuity({ pkg: pkg({ partners: [acme({ paidInToDate: 650_000 }), northwind()] }), prior }, ctx)
    expect(r.findings[0]).toMatchObject({ stated: 650_000, expected: 600_000 })
  })

  it('flags a to-date total that went down when no flow is stated', () => {
    const r = continuity({ pkg: pkg({ partners: [acme({ contributions: undefined, paidInToDate: 450_000 }), northwind()] }), prior }, ctx)
    expect(r.findings[0]).toMatchObject({ severity: 'error' })
    expect(r.findings[0].message).toMatch(/shouldn't go down/)
  })

  it('warns when a commitment changed', () => {
    const r = continuity({ pkg: pkg({ partners: [acme({ commitment: 1_200_000 }), northwind()] }), prior }, ctx)
    expect(r.findings[0]).toMatchObject({ severity: 'warning', difference: 200_000 })
  })

  it('flags a partner with capital last period who is gone now', () => {
    const r = continuity({ pkg: pkg({ partners: [acme()] }), prior }, ctx)
    expect(r.findings).toHaveLength(1)
    expect(r.findings[0].message).toMatch(/Northwind Capital ended 2026-06-30/)
  })

  it('pairs partners by the package id when neither period matched them', () => {
    const r = continuity({
      pkg: pkg({ partners: [acme({ lpEntityId: undefined, beginning: 510_000 })] }),
      prior: { periodEnd: '2026-06-30', partners: [acme({ lpEntityId: undefined, ending: 500_000 })] },
    }, ctx)
    expect(r.findings[0].expected).toBe(500_000)
  })
})
