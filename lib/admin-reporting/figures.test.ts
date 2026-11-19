import { describe, expect, it } from 'vitest'
import { adminRows, checkPull, cleanAdminFigures, parseAmount, parseIrr, parseMultiple, splitAdminRow, type AdminFigures } from './figures'

const base = {
  as_of: '2026-06-30',
  source: 'Carta',
  positions: [
    { external_id: 'p-1', name: 'Jane Doe', commitment: '100,000', paid_in: 50_000, distributions: '(0)', nav: '$60,000' },
    { external_id: 'p-2', name: 'Acme LLC', commitment: 200_000, paid_in: 100_000, distributions: 10_000, nav: 110_000 },
  ],
  fund: { irr: 6.08, tvpi: '1.20x', dpi: 0.1 },
}

describe('parsers', () => {
  it('read amounts as written', () => {
    expect(parseAmount('1,250,000.00')).toBe(1_250_000)
    expect(parseAmount('(1,000)')).toBe(-1000)
    expect(parseAmount('')).toBeNull()
    expect(parseAmount('abc')).toBe('invalid')
  })
  it('read an IRR as a percent or a fraction', () => {
    expect(parseIrr('6.08%')).toBeCloseTo(0.0608)
    expect(parseIrr(6.08)).toBeCloseTo(0.0608)
    expect(parseIrr(0.0608)).toBeCloseTo(0.0608)
    expect(parseIrr('0.5%')).toBeCloseTo(0.005)
  })
  it('read multiples', () => {
    expect(parseMultiple('1.49x')).toBe(1.49)
    expect(parseMultiple(-1)).toBe('invalid')
  })
})

describe('cleanAdminFigures', () => {
  it('normalises a pull', () => {
    const f = cleanAdminFigures(base) as AdminFigures
    expect(f.asOf).toBe('2026-06-30')
    expect(f.positions[0]).toMatchObject({ externalId: 'p-1', commitment: 100_000, paidIn: 50_000, distributions: -0, nav: 60_000 })
    expect(f.fund.irr).toBeCloseTo(0.0608)
    expect(f.fund.tvpi).toBe(1.2)
  })
  it('refuses a bad date, no source and a partner given twice', () => {
    expect(cleanAdminFigures({ ...base, as_of: '6/30/2026' })).toMatch(/as_of/)
    expect(cleanAdminFigures({ ...base, source: '' })).toMatch(/source/)
    expect(cleanAdminFigures({ ...base, positions: [base.positions[0], base.positions[0]] })).toMatch(/twice/)
  })
})

describe('checkPull', () => {
  const figures = cleanAdminFigures(base) as AdminFigures
  const partners = [{ id: 'e-1', name: 'Jane Doe' }, { id: 'e-2', name: 'Acme, LLC' }]

  it('matches by name and passes a complete pull', () => {
    const flags = checkPull({ figures, partners, links: [] })
    expect(flags.blocking).toEqual([])
    expect(flags.matches.map(m => m.lpEntityId)).toEqual(['e-1', 'e-2'])
    expect(flags.warnings.join(' ')).toMatch(/matched by name/)
  })

  it('prefers a saved link over the name', () => {
    const flags = checkPull({ figures, partners: [...partners, { id: 'e-3', name: 'Other' }], links: [{ externalId: 'p-1', lpEntityId: 'e-3' }] })
    expect(flags.matches[0]).toMatchObject({ lpEntityId: 'e-3', by: 'link' })
  })

  it('blocks an unmatched partner and a missing figure', () => {
    const missing = cleanAdminFigures({ ...base, positions: [{ ...base.positions[0], nav: null }, { ...base.positions[1], name: 'Northwind' }] }) as AdminFigures
    const flags = checkPull({ figures: missing, partners, links: [] })
    expect(flags.blocking.some(b => /not matched/.test(b))).toBe(true)
    expect(flags.blocking.some(b => /Jane Doe has no NAV/.test(b))).toBe(true)
  })

  it('blocks a partner who dropped out since the last saved pull, and lists changes on the same date', () => {
    const previous = { figures: { ...figures, positions: figures.positions.map(p => ({ ...p, nav: (p.nav ?? 0) + 1 })) }, matches: [{ externalId: 'p-1', lpEntityId: 'e-1' }, { externalId: 'x', lpEntityId: 'e-9' }] }
    const flags = checkPull({ figures, partners: [...partners, { id: 'e-9', name: 'Gone LP' }], links: [], previous })
    expect(flags.blocking.some(b => /missing from this one: Gone LP/.test(b))).toBe(true)
    expect(flags.changes.filter(c => c.field === 'NAV')).toHaveLength(2)
  })

  it('warns, not blocks, when the fund figures are missing', () => {
    const noFund = cleanAdminFigures({ ...base, fund: {} }) as AdminFigures
    const flags = checkPull({ figures: noFund, partners, links: [] })
    expect(flags.blocking).toEqual([])
    expect(flags.warnings.some(w => /IRR, TVPI, DPI/.test(w))).toBe(true)
  })
})

describe('adminRows', () => {
  const positions = [
    { lpEntityId: 'e-1', asOfDate: '2026-03-31', commitment: 100_000, calledCapital: 40_000, distributions: 0, nav: 45_000 },
    { lpEntityId: 'e-1', asOfDate: '2026-06-30', commitment: 100_000, calledCapital: 50_000, distributions: 5_000, nav: 60_000, receivable: 1_000 },
  ]
  const fund = new Map([['2026-06-30', { irr: 0.0608, tvpi: 1.2, dpi: 0.1 }]])

  it('shows the latest position as stated with the fund figures for its date', () => {
    const [r] = adminRows(positions, fund)
    expect(r).toMatchObject({ asOf: '2026-06-30', paid_in_capital: 50_000, total_value: 65_000, outstanding_balance: 50_000, receivable: 1_000, irr: 0.0608, tvpi: 1.2, dpi: 0.1, rvpi: null })
  })

  it('never borrows fund figures from another date', () => {
    const [r] = adminRows(positions, fund, '2026-05-31')
    expect(r.asOf).toBe('2026-03-31')
    expect(r.irr).toBeNull()
    expect(r.tvpi).toBeNull()
  })
})

describe('splitAdminRow', () => {
  const row = { commitment: 50_000, paid_in_capital: 50_000, distributions: 975_000, nav: 1_075_000, tvpi: 3, dpi: 1.5 }

  it("gives capital its fund-return share by ownership and the rest by carry points", () => {
    const [a, b] = splitAdminRow(row, [
      { lpEntityId: 'a', ownershipWeight: 1, carryWeight: 0 },
      { lpEntityId: 'b', ownershipWeight: 1, carryWeight: 1 },
    ])
    expect(a).toEqual({ entity_id: 'a', commitment: 25_000, paid_in_capital: 25_000, distributions: 37_500, nav: 37_500 })
    expect(b).toEqual({ entity_id: 'b', commitment: 25_000, paid_in_capital: 25_000, distributions: 937_500, nav: 1_037_500 })
  })

  it('adds back to the row exactly, and splits by ownership when the fund figures are missing', () => {
    const shares = splitAdminRow({ ...row, tvpi: null, dpi: null }, [
      { lpEntityId: 'a', ownershipWeight: 1, carryWeight: 5 },
      { lpEntityId: 'b', ownershipWeight: 2, carryWeight: 0 },
    ])
    expect(shares.reduce((s, x) => s + (x.nav ?? 0), 0)).toBeCloseTo(1_075_000, 2)
    expect(shares[0].nav).toBeCloseTo(358_333.33, 2)
  })
})
