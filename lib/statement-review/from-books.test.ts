import { describe, expect, it } from 'vitest'
import { capitalFromAccount, packageFromPayload } from './from-books'
import { runChecks } from './run'
import { emptyAccount } from '@/lib/accounting/capital-account'

const acct = (over: Record<string, number>) => ({ ...emptyAccount(), ...over })
const acme = acct({ beginning: 500_000, contributions: 100_000, distributions: -50_000, managementFees: -5_000, operatingIncome: 10_000, unrealizedGains: 35_000, ending: 590_000 })
const nw = acct({ beginning: 250_000, contributions: 50_000, distributions: -25_000, managementFees: -2_500, operatingIncome: 5_000, unrealizedGains: 17_500, ending: 295_000 })
const sum = (k: string) => (acme as any)[k] + (nw as any)[k]
const totals = acct(Object.fromEntries(Object.keys(acme).map(k => [k, sum(k)])))

const payload = {
  changesInPartnersCapital: {
    partners: [{ id: 'lp-acme', name: 'Acme Partners LP', ...acme }, { id: 'lp-nw', name: 'Northwind Capital', ...nw }],
    totals,
  },
  balanceSheet: {
    assets: { label: 'Assets', rows: [{ code: '1000', name: 'Cash', amount: 85_000 }, { code: '1200', name: 'Investments', amount: 800_000 }], total: 885_000 },
    liabilities: { label: 'Liabilities', rows: [], total: 0 },
    equity: { label: 'Equity', rows: [], total: 885_000 },
    check: 0,
    partnersCapital: { total: 885_000, unallocatedEarnings: 0 },
  },
  incomeStatement: {
    income: { label: 'Income', rows: [{ code: '4000', name: 'Interest', amount: 15_000 }, { code: '4500', name: 'Unrealized gain', amount: 52_500 }], total: 67_500 },
    expenses: { label: 'Expenses', rows: [{ code: '5100', name: 'Management fees', amount: 7_500 }], total: 7_500 },
    netIncome: 60_000,
  },
  scheduleOfInvestments: { rows: [], realizedRows: [], totalCost: 0, totalFairValue: 0, netAssets: 885_000, source: 'ledger', ledgerCost: 0 },
} as any
const period = { start: '2026-07-01', end: '2026-09-30' }

describe('packageFromPayload', () => {
  it("states a capital account the way the package model does", () => {
    expect(capitalFromAccount(acme)).toMatchObject({
      beginning: 500_000, contributions: 100_000, distributions: 50_000, ending: 590_000,
      allocations: { income: 10_000, managementFee: -5_000, unrealized: 35_000, total: 40_000 },
    })
  })

  it("builds a package the checks find nothing wrong with when the books tie", () => {
    const { pkg, notes } = packageFromPayload(payload, 'veh-1', period, { commitments: { 'lp-acme': 1_000_000, 'lp-nw': 500_000 } })
    expect(notes).toEqual([])
    expect(pkg.source).toBe('books')
    expect(pkg.partners?.map(p => p.lpEntityId)).toEqual(['lp-acme', 'lp-nw'])
    const r = runChecks({ pkg })
    const errors = r.findings.filter(f => f.severity !== 'info')
    expect(errors).toEqual([])
    expect(r.checks.find(c => c.check === 'roll_forward')?.ran).toBe(true)
    expect(r.checks.find(c => c.check === 'foots')?.ran).toBe(true)
  })

  it('flags unallocated net income, and an unclassified line as a net allocation its parts miss', () => {
    const odd = { ...acme, unclassified: 1_000, ending: 591_000 }
    const p = {
      ...payload,
      changesInPartnersCapital: { partners: [{ id: 'lp-acme', name: 'Acme Partners LP', ...odd }], totals: odd },
      balanceSheet: { ...payload.balanceSheet, partnersCapital: { total: 591_000, unallocatedEarnings: 2_500 } },
    }
    const { pkg, notes } = packageFromPayload(p, 'veh-1', period)
    expect(notes[0]).toMatch(/isn't allocated/)
    const f = runChecks({ pkg }).findings.find(x => x.check === 'foots' && x.subject.label === 'Acme Partners LP')
    expect(f).toBeDefined()
  })

  it('rolls the GP row forward from its balance before the period', () => {
    const gp = { id: 'gp', name: 'General Partner', ...emptyAccount(), carriedInterest: 12_000, ending: 12_000 }
    const p = { ...payload, changesInPartnersCapital: { partners: [...payload.changesInPartnersCapital.partners, gp], totals: { ...totals, carriedInterest: 12_000, ending: totals.ending + 12_000 } } }
    const { pkg } = packageFromPayload(p, 'veh-1', period, { gpBeginning: 10_000 })
    expect(pkg.partners?.find(x => x.externalId === 'gp')).toMatchObject({ beginning: 10_000, ending: 12_000, allocations: { carry: 2_000 } })
    expect(pkg.fund?.partnersCapital).toMatchObject({ beginning: totals.beginning + 10_000 })
  })
})
