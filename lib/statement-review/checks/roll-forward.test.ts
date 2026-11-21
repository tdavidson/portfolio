import { describe, expect, it } from 'vitest'
import { rollForward } from './roll-forward'
import { acme, ctx, northwind, pkg } from './fixtures'

describe('roll-forward', () => {
  it('rolls each partner forward', () => {
    const r = rollForward({ pkg: pkg() }, ctx)
    expect(r.outcome).toMatchObject({ ran: true })
    expect(r.findings).toEqual([])
  })

  it("flags an ending that doesn't roll from the beginning", () => {
    const r = rollForward({ pkg: pkg({ partners: [acme({ ending: 600_000 }), northwind()] }) }, ctx)
    expect(r.findings).toHaveLength(1)
    expect(r.findings[0]).toMatchObject({ subject: { kind: 'partner', id: 'lp-acme' }, stated: 600_000, expected: 590_000, difference: 10_000 })
    expect(r.findings[0].cites[0]).toMatchObject({ document: 'Q3 statements.pdf', page: 4 })
  })

  it('uses the stated net allocation when there is one', () => {
    const r = rollForward({ pkg: pkg({ partners: [acme({ allocations: { total: 40_000 } })] }) }, ctx)
    expect(r.findings).toEqual([])
  })

  it('reads a blank distribution as none when the column is stated for someone', () => {
    const r = rollForward({ pkg: pkg({ partners: [acme({ distributions: undefined, ending: 640_000 }), northwind()] }) }, ctx)
    expect(r.findings).toEqual([])
  })

  it("can't roll forward a package with no beginning or allocations, and says why", () => {
    const r = rollForward({ pkg: pkg({ partners: [{ externalId: 'p-1', name: 'Acme Partners LP', ending: 590_000, commitment: 1_000_000 }] }) }, ctx)
    expect(r.outcome.ran).toBe(false)
    expect(r.outcome.note).toMatch(/beginning capital/)
    expect(r.outcome.note).toMatch(/allocations/)
  })

  it('checks unfunded against commitment less paid-in', () => {
    const r = rollForward({ pkg: pkg({ partners: [acme({ unfunded: 450_000 })] }) }, ctx)
    expect(r.findings[0]).toMatchObject({ stated: 450_000, expected: 400_000 })
  })

  it('rolls the fund total forward too', () => {
    const r = rollForward({ pkg: pkg({ fund: { partnersCapital: { beginning: 750_000, contributions: 150_000, distributions: 75_000, allocations: { total: 60_000 }, ending: 890_000 } } }) }, ctx)
    expect(r.findings).toHaveLength(1)
    expect(r.findings[0].subject).toMatchObject({ kind: 'fund' })
  })
})
