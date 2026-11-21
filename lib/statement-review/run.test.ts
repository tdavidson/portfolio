import { describe, expect, it } from 'vitest'
import { adjustmentFor, packageNav, runChecks } from './run'
import { acme, northwind, pkg } from './checks/fixtures'

describe('runChecks', () => {
  it('runs every check and reports which could not', () => {
    const r = runChecks({ pkg: pkg(), prior: null, known: null })
    expect(r.checks.map(c => c.check)).toEqual(['sources', 'foots', 'partners_sum', 'roll_forward', 'continuity', 'completeness', 'ledger_flows', 'management_fee', 'carry', 'allocation', 'cash', 'soi', 'watched_accounts'])
    expect(r.checks.find(c => c.check === 'continuity')?.ran).toBe(false)
    expect(r.checks.find(c => c.check === 'roll_forward')?.ran).toBe(true)
  })

  it('puts errors before warnings before information, and counts them', () => {
    const r = runChecks({
      pkg: pkg({ partners: [acme({ ending: 600_000 }), northwind({ ending: 295_050 }), { externalId: 'p-9', name: 'Jane Doe' }] }),
      known: [{ lpEntityId: 'lp-acme', name: 'Acme Partners LP' }, { lpEntityId: 'lp-northwind', name: 'Northwind Capital' }],
    }, { amount: 100, navShare: 0 })
    expect(r.findings.map(f => f.severity)).toEqual(['error', 'warning', 'info'])
    expect(r.counts).toEqual({ error: 1, warning: 1, info: 1 })
  })

  it('measures materiality against the NAV the package states', () => {
    expect(packageNav(pkg())).toBe(885_000)
    expect(packageNav(pkg({ fund: { partnersCapital: { ending: 900_000 } } }))).toBe(900_000)
    const r = runChecks({ pkg: pkg({ partners: [acme({ ending: 600_000 }), northwind()] }) }, { amount: 0, navShare: 0.02 })
    // 2% of 895,000 is 17,900, so a 10,000 difference is information.
    expect(r.threshold).toBeCloseTo(17_900)
    expect(r.findings.find(f => f.check === 'roll_forward')?.severity).toBe('info')
  })
})

describe('known adjustments', () => {
  const known = [{ lpEntityId: 'lp-acme', name: 'Acme Partners LP' }, { lpEntityId: 'lp-northwind', name: 'Northwind Capital' }]
  const broken = () => pkg({ partners: [acme({ ending: 600_000 }), northwind()] })

  it('marks a finding it explains as explained information, with its description', () => {
    const r = runChecks({
      pkg: broken(), known,
      settings: { materiality: { amount: 0, navShare: 0 }, instructions: '', watchAccounts: [], adjustments: [{ description: 'Admin accrues a late fee rebate', check: 'roll_forward', subject: 'acme' }] },
    })
    const f = r.findings.find(x => x.check === 'roll_forward')!
    expect(f).toMatchObject({ severity: 'info', adjustedFrom: 'error', status: 'explained', note: 'Known adjustment: Admin accrues a late fee rebate' })
    expect(r.counts.error).toBe(0)
  })

  it('matches on amount, in either sign, within the tolerance', () => {
    const f = { check: 'cash' as const, severity: 'error' as const, subject: { kind: 'fund' as const, label: 'Cash' }, difference: -1_250, message: '', cites: [], status: 'open' as const }
    expect(adjustmentFor(f, [{ description: 'Wire in transit', amount: 1_250 }])).toBeTruthy()
    expect(adjustmentFor(f, [{ description: 'Wire in transit', amount: 1_300 }])).toBeNull()
    expect(adjustmentFor(f, [{ description: 'Wire in transit', amount: 1_300, tolerance: 60 }])).toBeTruthy()
    expect(adjustmentFor(f, [{ description: 'Wire in transit', amount: 1_250, check: 'soi' }])).toBeNull()
  })

  it('never matches on a check name alone', () => {
    const f = { check: 'cash' as const, severity: 'error' as const, subject: { kind: 'fund' as const, label: 'Cash' }, difference: 5, message: '', cites: [], status: 'open' as const }
    expect(adjustmentFor(f, [{ description: 'Anything in cash', check: 'cash' }])).toBeNull()
  })
})
