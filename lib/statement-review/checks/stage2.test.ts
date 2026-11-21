import { describe, expect, it } from 'vitest'
import { ledgerFlows } from './ledger-flows'
import { cash } from './cash'
import { soi } from './soi'
import { watchedAccounts } from './watched-accounts'
import { acme, ctx, northwind, pkg } from './fixtures'
import { DEFAULT_SETTINGS, type Shadow } from '../types'

const shadow = (over: Partial<Shadow> = {}): Shadow => ({
  partners: [
    { lpEntityId: 'lp-acme', name: 'Acme Partners LP', contributions: 100_000, distributions: 50_000 },
    { lpEntityId: 'lp-northwind', name: 'Northwind Capital', contributions: 50_000, distributions: 25_000 },
  ],
  cash: { ledger: 100_000, bank: 100_000, bankThrough: '2026-09-30' },
  holdings: [
    { companyId: 'c-1', name: 'Acme Robotics, Inc.', cost: 400_000, fairValue: 500_000 },
    { companyId: 'c-2', name: 'Northwind Bio', cost: 200_000, fairValue: 300_000 },
  ],
  accounts: [
    { code: '1000', name: 'Cash', type: 'asset', subtype: 'cash', balance: 100_000, movement: 20_000 },
    { code: '5100', name: 'Management fees', type: 'expense', balance: 30_000, movement: 7_500 },
    { code: '2100', name: 'Accrued expenses', type: 'liability', balance: 15_000, movement: 5_000 },
  ],
  ...over,
})

describe('contributions and distributions against the books', () => {
  it('passes when the flows match', () => {
    const r = ledgerFlows({ pkg: pkg(), shadow: shadow() }, ctx)
    expect(r.outcome).toMatchObject({ ran: true, compared: 4 })
    expect(r.findings).toEqual([])
  })

  it('flags a partner whose contributions differ from the books', () => {
    const r = ledgerFlows({ pkg: pkg({ partners: [acme({ contributions: 120_000 }), northwind()] }), shadow: shadow() }, ctx)
    expect(r.findings[0]).toMatchObject({ check: 'ledger_flows', stated: 120_000, expected: 100_000 })
  })

  it('flags money the books moved for a partner the package leaves out', () => {
    const r = ledgerFlows({ pkg: pkg({ partners: [acme()] }), shadow: shadow() }, ctx)
    expect(r.findings[0].message).toMatch(/Northwind Capital this period, but the package has no capital account/)
  })

  it("says so when the books hold no capital activity", () => {
    expect(ledgerFlows({ pkg: pkg(), shadow: shadow({ partners: null }) }, ctx).outcome).toMatchObject({ ran: false })
  })
})

describe('cash', () => {
  it('compares the stated cash with the books and the bank', () => {
    const r = cash({ pkg: pkg({ cash: [{ account: 'Operating', balance: 60_000 }, { account: 'Money market', balance: 40_000 }] }), shadow: shadow() }, ctx)
    expect(r.outcome).toMatchObject({ ran: true, compared: 2 })
    expect(r.findings).toEqual([])
  })

  it('reads cash off the balance sheet when there are no cash lines', () => {
    const r = cash({ pkg: pkg({ fund: { balanceSheet: { assets: [{ label: 'Cash and equivalents', amount: 90_000 }, { label: 'Investments', amount: 800_000 }] } } }), shadow: shadow() }, ctx)
    expect(r.findings).toHaveLength(2)
    expect(r.findings[0]).toMatchObject({ stated: 90_000, expected: 100_000 })
  })

  it('compares with the books only when the bank feed stops short', () => {
    const r = cash({ pkg: pkg({ cash: [{ account: 'Operating', balance: 100_000 }] }), shadow: shadow({ cash: { ledger: 100_000, bank: null, bankThrough: null } }) }, ctx)
    expect(r.outcome.note).toMatch(/books only/)
  })
})

describe('schedule of investments against the portfolio', () => {
  it('pairs holdings by name, ignoring case and punctuation', () => {
    const r = soi({ pkg: pkg({ holdings: [{ name: 'ACME ROBOTICS INC', cost: 400_000, fairValue: 500_000 }, { name: 'Northwind Bio', cost: 200_000, fairValue: 300_000 }] }), shadow: shadow() }, ctx)
    expect(r.findings).toEqual([])
  })

  it('flags a mark that differs, a holding left out and one the app does not carry', () => {
    const r = soi({ pkg: pkg({ holdings: [{ name: 'Acme Robotics Inc', cost: 400_000, fairValue: 550_000 }, { name: 'Contoso Labs', cost: 50_000 }] }), shadow: shadow() }, ctx)
    const msgs = r.findings.map(f => f.message)
    expect(msgs.some(m => /fair value is 550,000.00 in the schedule, but the portfolio carries 500,000.00/.test(m))).toBe(true)
    expect(msgs.some(m => /Contoso Labs isn't a holding/.test(m))).toBe(true)
    expect(msgs.some(m => /Northwind Bio is carried at 300,000.00/.test(m))).toBe(true)
  })

  it('compares totals when the package gives only totals', () => {
    const r = soi({ pkg: pkg({ fund: { soi: { fairValue: 810_000 } } }), shadow: shadow() }, ctx)
    expect(r.findings[0]).toMatchObject({ stated: 810_000, expected: 800_000 })
  })
})

describe('watched accounts', () => {
  const settings = (watch: typeof DEFAULT_SETTINGS.watchAccounts) => ({ ...DEFAULT_SETTINGS, watchAccounts: watch })

  it("says so when nothing is watched", () => {
    expect(watchedAccounts({ pkg: pkg(), shadow: shadow(), settings: DEFAULT_SETTINGS }, ctx).outcome.ran).toBe(false)
  })

  it('reports a watched account by code or name, with the note', () => {
    const r = watchedAccounts({ pkg: pkg(), shadow: shadow(), settings: settings([{ account: '5100', note: 'fee offsets' }, { account: 'accrued expenses' }]) }, ctx)
    expect(r.findings).toHaveLength(2)
    expect(r.findings[0]).toMatchObject({ severity: 'info', subject: { label: '5100 Management fees' } })
    expect(r.findings[0].message).toMatch(/moved 7,500.00\. Watch for: fee offsets/)
  })

  it('warns when the account moved more than the threshold', () => {
    const r = watchedAccounts({ pkg: pkg(), shadow: shadow(), settings: settings([{ account: '5100', threshold: 5_000 }]) }, ctx)
    expect(r.findings[0]).toMatchObject({ severity: 'warning' })
  })

  it('compares a statement line of the same name with the books', () => {
    const r = watchedAccounts({
      pkg: pkg({ fund: { operations: { lines: [{ label: 'Management fees', amount: -8_000 }] } } }),
      shadow: shadow(), settings: settings([{ account: '5100' }]),
    }, ctx)
    expect(r.findings[1]).toMatchObject({ stated: -8_000, expected: -7_500, difference: -500 })
  })

  it("warns about an account that isn't in the chart", () => {
    const r = watchedAccounts({ pkg: pkg(), shadow: shadow(), settings: settings([{ account: '9999' }]) }, ctx)
    expect(r.findings[0]).toMatchObject({ severity: 'warning' })
  })
})
