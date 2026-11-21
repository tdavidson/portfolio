import { describe, expect, it } from 'vitest'
import { completeness } from './completeness'
import { acme, ctx, northwind, pkg } from './fixtures'

describe('completeness', () => {
  const known = [{ lpEntityId: 'lp-acme', name: 'Acme Partners LP' }, { lpEntityId: 'lp-northwind', name: 'Northwind Capital' }]

  it('passes when the package and the app have the same partners', () => {
    const r = completeness({ pkg: pkg(), known }, ctx)
    expect(r.outcome).toMatchObject({ ran: true, compared: 4 })
    expect(r.findings).toEqual([])
  })

  it('flags a partner the app knows who is missing from the package', () => {
    const r = completeness({ pkg: pkg({ partners: [acme()] }), known }, ctx)
    expect(r.findings).toEqual([expect.objectContaining({ severity: 'error', subject: expect.objectContaining({ id: 'lp-northwind' }) })])
  })

  it('flags a package partner the app does not know, without dropping it', () => {
    const r = completeness({ pkg: pkg({ partners: [acme(), northwind(), { externalId: 'p-9', name: 'Jane Doe' }] }), known }, ctx)
    expect(r.findings).toEqual([expect.objectContaining({ severity: 'warning', subject: expect.objectContaining({ label: 'Jane Doe' }) })])
  })

  it('flags two package partners matched to the same app partner', () => {
    const r = completeness({ pkg: pkg({ partners: [acme(), acme({ externalId: 'p-1b', name: 'Acme Partners L.P.' }), northwind()] }), known }, ctx)
    expect(r.findings[0]).toMatchObject({ severity: 'error' })
    expect(r.findings[0].message).toMatch(/same partner/)
  })

  it("checks only the package's side when the app's list couldn't be read", () => {
    const r = completeness({ pkg: pkg({ partners: [acme()] }), known: null }, ctx)
    expect(r.findings).toEqual([])
    expect(r.outcome.note).toMatch(/couldn't be read/)
  })
})
