import { describe, expect, it } from 'vitest'
import { cleanPackage, quarterStart } from './clean'
import { packageFromCsv } from './csv'
import { packageInputFromPull } from './from-admin-pull'

describe('cleanPackage', () => {
  it('takes snake_case or camelCase, and amounts as a statement prints them', () => {
    const p = cleanPackage({
      period_end: '2026-09-30',
      partners: [{ name: 'Acme Partners LP', beginning: '1,000.00', paidInToDate: 500, allocations: { management_fee: '(250.00)' }, cite: { paid_in_to_date: { document: 'Q3.pdf', page: 2 } } }],
      fund: { balance_sheet: { total_assets: 900, partners_capital: 880 }, soi: { fair_value: 800 } },
    }, 'veh-1')
    expect(typeof p).toBe('object')
    if (typeof p === 'string') return
    expect(p.periodStart).toBe('2026-07-01')
    expect(p.partners![0]).toMatchObject({ externalId: 'Acme Partners LP', beginning: 1000, paidInToDate: 500, allocations: { managementFee: -250 } })
    expect(p.partners![0].cite?.paidInToDate).toEqual({ document: 'Q3.pdf', page: 2 })
    expect(p.fund).toMatchObject({ balanceSheet: { totalAssets: 900, partnersCapital: 880 }, soi: { fairValue: 800 } })
  })

  it('refuses what it cannot read', () => {
    expect(cleanPackage({ partners: [] }, 'v')).toMatch(/period_end/)
    expect(cleanPackage({ period_end: '2026-09-30' }, 'v')).toMatch(/nothing to check/)
    expect(cleanPackage({ period_end: '2026-09-30', partners: [{ name: 'Acme', ending: 'lots' }] }, 'v')).toMatch(/ending must be an amount/)
    expect(cleanPackage({ period_end: '2026-09-30', partners: [{ name: 'Acme' }, { name: 'Acme' }] }, 'v')).toMatch(/given twice/)
    expect(cleanPackage({ period_end: '2026-09-30', period_start: '2026-10-01', partners: [{ name: 'Acme' }] }, 'v')).toMatch(/on or before/)
  })

  it('finds the quarter start', () => {
    expect(quarterStart('2026-12-31')).toBe('2026-10-01')
    expect(quarterStart('2026-03-31')).toBe('2026-01-01')
  })
})

describe('packageFromCsv', () => {
  const csv = [
    'Partner,Partner ID,Commitment,Beginning capital,Contributions,Distributions,Income,Expenses,Management fee,Unrealized gain (loss),Ending capital,Paid-in capital',
    'Acme Partners LP,p-1,"1,000,000",500000,100000,50000,10000,(5000),(5000),40000,590000,600000',
    'Northwind Capital,p-2,500000,250000,50000,25000,5000,(2500),(2500),20000,295000,300000',
    'Total,,1500000,750000,150000,75000,15000,(7500),(7500),60000,885000,900000',
  ].join('\n')

  it('reads period and to-date columns apart, allocations signed, and the total row as stated totals', () => {
    const r = packageFromCsv(csv, 'q3.csv')
    if (typeof r === 'string') throw new Error(r)
    expect(r.partners).toHaveLength(2)
    expect(r.partners[0]).toMatchObject({ name: 'Acme Partners LP', external_id: 'p-1', contributions: '100000', paid_in_to_date: '600000' })
    expect((r.partners[0] as any).allocations).toMatchObject({ expenses: '(5000)', management_fee: '(5000)', unrealized: '40000' })
    expect(r.totals).toMatchObject({ ending: '885000' })
    expect((r.partners[0] as any).cite.ending).toEqual({ document: 'q3.csv', label: 'Ending capital, row 2' })
    const p = cleanPackage({ period_end: '2026-09-30', partners: r.partners, fund: { partner_totals: r.totals } }, 'v')
    if (typeof p === 'string') throw new Error(p)
    expect(p.partners![0].allocations).toEqual({ income: 10_000, expenses: -5_000, managementFee: -5_000, unrealized: 40_000 })
    expect(p.partners![0].cite?.['allocations.managementFee']).toBeTruthy()
  })

  it('says what is missing from the header', () => {
    expect(packageFromCsv('Commitment,Ending\n1,2')).toMatch(/partner name/)
    expect(packageFromCsv('Name,Colour\nAcme,blue')).toMatch(/names no figures/)
  })
})

describe('packageInputFromPull', () => {
  it("carries a pull's figures as to-date totals and ending capital", () => {
    const input = packageInputFromPull({
      asOf: '2026-09-30', source: 'Example Admin',
      positions: [{ externalId: 'x-1', name: 'Acme Partners LP', commitment: 1_000_000, paidIn: 600_000, distributions: 50_000, nav: 590_000 }],
      fund: { irr: null, tvpi: null, dpi: null },
    }, [{ externalId: 'x-1', lpEntityId: 'lp-acme' }])
    const p = cleanPackage(input, 'v')
    if (typeof p === 'string') throw new Error(p)
    expect(p.partners![0]).toMatchObject({ lpEntityId: 'lp-acme', paidInToDate: 600_000, distributedToDate: 50_000, ending: 590_000 })
    expect(p.partners![0].beginning).toBeUndefined()
  })
})
