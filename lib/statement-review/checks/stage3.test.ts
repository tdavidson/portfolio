import { describe, expect, it } from 'vitest'
import { allocation } from './allocation'
import { carry } from './carry'
import { managementFee } from './management-fee'
import { acme, ctx, northwind, pkg } from './fixtures'
import type { Shadow, ShadowTerms } from '../types'

const terms = (over: Partial<ShadowTerms> = {}): ShadowTerms => ({
  basis: 'commitment',
  commitments: { 'lp-acme': 1_000_000, 'lp-northwind': 500_000 },
  partnerTerms: [],
  fees: [{ lpEntityId: 'lp-acme', fee: 5_000 }, { lpEntityId: 'lp-northwind', fee: 2_500 }],
  carry: { kind: 'european', rate: 0.2, recipients: ['lp-gp'], carryFree: ['lp-gp'] },
  ...over,
})
const shadow = (t: ShadowTerms | null, partners: Shadow['partners'] = null): Shadow =>
  ({ partners, cash: null, holdings: null, accounts: null, terms: t })

describe('management fee', () => {
  it('passes when each partner is charged what the schedule charges', () => {
    const r = managementFee({ pkg: pkg(), shadow: shadow(terms()) }, ctx)
    expect(r.outcome).toMatchObject({ ran: true, compared: 2 })
    expect(r.findings).toEqual([])
  })

  it('flags a partner charged a different fee', () => {
    const p = pkg({ partners: [acme({ allocations: { managementFee: -6_000 } }), northwind()] })
    const [f] = managementFee({ pkg: p, shadow: shadow(terms()) }, ctx).findings
    expect(f).toMatchObject({ severity: 'error', stated: -6_000, expected: -5_000, difference: -1_000, subject: { label: 'Acme Partners LP' } })
  })

  it('flags a partner the schedule charges but the package shows no fee for', () => {
    const p = pkg({ partners: [acme(), northwind({ allocations: { income: 5_000 } })] })
    const [f] = managementFee({ pkg: p, shadow: shadow(terms()) }, ctx).findings
    expect(f).toMatchObject({ stated: 0, expected: -2_500, subject: { label: 'Northwind Capital' } })
  })

  it('compares the fund total when the package gives no fee per partner', () => {
    const p = pkg({
      partners: [acme({ allocations: undefined }), northwind({ allocations: undefined })],
      fund: { partnersCapital: { allocations: { managementFee: -7_000 } } },
    })
    const r = managementFee({ pkg: p, shadow: shadow(terms()) }, ctx)
    expect(r.outcome.ran).toBe(true)
    expect(r.findings[0]).toMatchObject({ subject: { kind: 'fund' }, stated: -7_000, expected: -7_500 })
  })

  it("says why it couldn't run without a fee schedule", () => {
    const r = managementFee({ pkg: pkg(), shadow: shadow(terms({ fees: null, feeNote: 'No schedule.' })) }, ctx)
    expect(r.outcome).toMatchObject({ ran: false, note: 'No schedule.' })
  })
})

describe('allocation', () => {
  it('passes when each category is split on commitments', () => {
    const r = allocation({ pkg: pkg(), shadow: shadow(terms()) }, ctx)
    expect(r.outcome.ran).toBe(true)
    expect(r.findings).toEqual([])
  })

  it('flags a share off the commitment split', () => {
    const p = pkg({ partners: [acme({ allocations: { income: 9_000 } }), northwind({ allocations: { income: 6_000 } })] })
    const f = allocation({ pkg: p, shadow: shadow(terms()) }, ctx).findings
    expect(f.map(x => [x.subject.label, x.stated, x.expected])).toEqual([['Acme Partners LP', 9_000, 10_000], ['Northwind Capital', 6_000, 5_000]])
  })

  it('follows partner terms: a partner left out of a category gets none of it', () => {
    const t = terms({ partnerTerms: [{ lpEntityId: 'lp-northwind', category: 'income', participates: false, weightOverride: null, rateOverride: null }] })
    const f = allocation({ pkg: pkg(), shadow: shadow(t) }, ctx).findings
    expect(f.find(x => x.subject.label === 'Northwind Capital')).toMatchObject({ stated: 5_000, expected: 0 })
    expect(f.find(x => x.subject.label === 'Acme Partners LP')).toMatchObject({ stated: 10_000, expected: 15_000 })
  })

  it('on capital balances, measures from the package and warns rather than errs', () => {
    // Balances before allocations: 550,000 and 275,000, the same 2:1 as commitments, so make them differ.
    const p = pkg({ partners: [acme({ beginning: 300_000 }), northwind()] })
    const f = allocation({ pkg: p, shadow: shadow(terms({ basis: 'capital_balance' })) }, ctx).findings
    expect(f.length).toBeGreaterThan(0)
    expect(f.every(x => x.severity !== 'error')).toBe(true)
  })

  it("uses the package's own commitments without the app's terms", () => {
    const r = allocation({ pkg: pkg(), shadow: null }, ctx)
    expect(r.outcome).toMatchObject({ ran: true })
    expect(r.outcome.note).toMatch(/own commitments/)
  })
})

describe('carry', () => {
  it("doesn't run when neither the package nor the books show carry", () => {
    expect(carry({ pkg: pkg(), shadow: shadow(terms()) }, ctx).outcome.ran).toBe(false)
  })

  it('flags carry when the vehicle has no carry terms', () => {
    const p = pkg({ partners: [acme({ allocations: { carry: -2_000 } }), northwind()] })
    const t = terms({ carry: { kind: 'none', rate: 0, recipients: [], carryFree: [] } })
    const [f] = carry({ pkg: p, shadow: shadow(t) }, ctx).findings
    expect(f).toMatchObject({ subject: { kind: 'fund' }, stated: -2_000, expected: 0 })
  })

  it('flags carry charged to a carry-free partner, and carry that does not net to zero', () => {
    const gp = { ...northwind({ externalId: 'p-gp', name: 'Example GP LLC', lpEntityId: 'lp-gp' }), allocations: { carry: 1_500 } }
    const t = terms({ carry: { kind: 'european', rate: 0.2, recipients: ['lp-gp'], carryFree: ['lp-gp', 'lp-northwind'] } })
    const p = pkg({ partners: [acme({ allocations: { carry: -1_000 } }), northwind({ allocations: { carry: -500 } }), gp] })
    const f = carry({ pkg: p, shadow: shadow(t) }, ctx).findings
    expect(f.find(x => x.subject.label === 'Northwind Capital')).toMatchObject({ stated: -500, expected: 0 })
    // -1,000 - 500 + 1,500 nets to zero.
    expect(f.find(x => x.subject.kind === 'fund')).toBeUndefined()

    const short = pkg({ partners: [acme({ allocations: { carry: -1_000 } }), { ...gp, allocations: { carry: 800 } }] })
    expect(carry({ pkg: short, shadow: shadow(t) }, ctx).findings.find(x => x.subject.kind === 'fund')).toMatchObject({ stated: -200 })
  })

  it('compares with the carry the books accrued', () => {
    const books = [
      { lpEntityId: 'lp-acme', name: 'Acme Partners LP', contributions: 100_000, distributions: 50_000, carry: -1_200 },
      { lpEntityId: 'lp-northwind', name: 'Northwind Capital', contributions: 50_000, distributions: 25_000, carry: -600 },
    ]
    const p = pkg({ partners: [acme({ allocations: { carry: -1_000 } }), northwind()] })
    const f = carry({ pkg: p, shadow: shadow(terms(), books) }, ctx).findings
    expect(f.map(x => [x.subject.label, x.stated, x.expected])).toEqual([['Acme Partners LP', -1_000, -1_200], ['Northwind Capital', 0, -600]])
  })
})
