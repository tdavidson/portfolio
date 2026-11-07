import { describe, it, expect } from 'vitest'
import * as XLSX from 'xlsx'
import { buildStatementWorkbook } from './statement-workbook'
import type { StatementPackage } from './statement-package'
import { emptyAccount } from './capital-account'
import type { Account } from './types'

// A minimal-but-valid package: two accounts, one period entry, enough to exercise
// every sheet builder. The point is to prove the workbook is well-formed and that
// numbers land as numeric cells tying to the input — not to re-test the statements.
function fixture(): StatementPackage {
  const accounts: Account[] = [
    { id: 'cash', fundId: 'f', code: '1000', name: 'Cash', type: 'asset' },
    { id: 'fees', fundId: 'f', code: '5000', name: 'Management fees', type: 'expense' },
  ]
  return {
    accounts,
    inPeriodSourced: [
      { entryId: 'e1', accountId: 'fees', amount: 250, currency: 'USD', lpEntityId: null, sourceType: 'expense', entryDate: '2026-03-15', memo: 'Q1 mgmt fee' },
      { entryId: 'e1', accountId: 'cash', amount: -250, currency: 'USD', lpEntityId: null, sourceType: 'expense', entryDate: '2026-03-15', memo: 'Q1 mgmt fee' },
    ],
    payload: {
      period: { preset: 'ytd', start: '2026-01-01', end: '2026-03-31', label: 'YTD 2026' },
      asOf: '2026-03-31',
      trialBalance: {
        rows: [
          { accountId: 'cash', code: '1000', name: 'Cash', type: 'asset', balance: -250, debit: 0, credit: 250 },
          { accountId: 'fees', code: '5000', name: 'Management fees', type: 'expense', balance: 250, debit: 250, credit: 0 },
        ],
        totalDebits: 250, totalCredits: 250, balanced: true,
      },
      balanceSheet: {
        assets: { label: 'Assets', rows: [{ code: '1000', name: 'Cash', amount: -250 }], total: -250 },
        liabilities: { label: 'Liabilities', rows: [], total: 0 },
        equity: { label: "Partners' capital", rows: [], total: -250 },
        check: 0,
        partnersCapital: { total: -250, unallocatedEarnings: -250 },
      },
      incomeStatement: {
        income: { label: 'Income', rows: [], total: 0 },
        expenses: { label: 'Expenses', rows: [{ code: '5000', name: 'Management fees', amount: 250 }], total: 250 },
        netIncome: -250,
      },
      scheduleOfInvestments: {
        rows: [], realizedRows: [], totalCost: 0, totalFairValue: 0, netAssets: -250, source: 'ledger',
        ledgerCost: 0, ledgerFairValue: 0, costVariance: 0, fairValueVariance: 0,
        byIndustry: [], byGeography: [], byAssetType: [], byLevel: [],
      },
      changesInPartnersCapital: {
        partners: [{ id: 'lp1', name: 'Acme LP', ...emptyAccount(), beginning: 0, expenses: 250, ending: -250 }],
        totals: { ...emptyAccount(), expenses: 250, ending: -250 },
      },
      cashFlows: {
        operating: { label: 'Operating activities', lines: [{ code: '5000', name: 'Management fees', amount: -250 }], total: -250 },
        financing: { label: 'Financing activities', lines: [], total: 0 },
        netChange: -250, openingCash: 0, endingCash: -250, nonCash: [],
      },
    },
  }
}

describe('buildStatementWorkbook', () => {
  const wb = buildStatementWorkbook(fixture(), { fundName: 'Test Fund', vehicle: 'Main', generatedAt: '2026-07-17T00:00:00Z' })

  it('produces every workpaper tab', () => {
    expect(wb.SheetNames).toEqual([
      'Cover', 'Trial Balance', 'Balance Sheet', 'Income Statement',
      'Partners Capital', 'Schedule of Investments', 'Cash Flows', 'GL Detail',
    ])
  })

  it('writes the trial-balance totals as numeric cells', () => {
    const rows = XLSX.utils.sheet_to_json<Record<string, unknown>>(wb.Sheets['Trial Balance'], { header: 1 }) as unknown as unknown[][]
    const totals = rows.find(r => r[1] === 'Totals')!
    expect(totals[3]).toBe(250) // debit total, as a number not a string
    expect(totals[4]).toBe(250) // credit total
  })

  it('carries net income onto the income statement', () => {
    const rows = XLSX.utils.sheet_to_json<unknown[]>(wb.Sheets['Income Statement'], { header: 1 })
    const net = rows.find(r => r[0] === 'Net income')!
    expect(net[2]).toBe(-250)
  })

  it('lists GL detail postings under their account, opening to closing balance', () => {
    const rows = XLSX.utils.sheet_to_json<unknown[]>(wb.Sheets['GL Detail'], { header: 1 })
    const open = rows.find(r => r[0] === '5000 · Management fees')!
    expect(open[4]).toBe('Opening balance')
    expect(open[8]).toBe(0)
    const close = rows.find(r => r[4] === 'Closing balance 5000')!
    expect(close[6]).toBe(250) // debit total
    expect(close[8]).toBe(250) // closing balance, expense is debit-normal
    // The cash line names the account on the other side of the entry.
    const cashLine = rows.find(r => r[4] === 'Q1 mgmt fee' && r[7] === 250)!
    expect(cashLine[5]).toBe('5000')
  })

  it('carries a balance in from before the period when the whole ledger is supplied', () => {
    const pkg = fixture()
    pkg.allSourced = [
      { entryId: 'e0', accountId: 'cash', amount: 1000, currency: 'USD', lpEntityId: null, sourceType: 'capital_call', entryDate: '2025-12-01', memo: 'Prior year call' },
      ...pkg.inPeriodSourced,
    ]
    const wb2 = buildStatementWorkbook(pkg, { fundName: 'F', vehicle: 'V', generatedAt: '2026-07-20T00:00:00Z' })
    const rows = XLSX.utils.sheet_to_json<unknown[]>(wb2.Sheets['GL Detail'], { header: 1 })
    const open = rows.find(r => r[0] === '1000 · Cash')!
    expect(open[8]).toBe(1000)
    const close = rows.find(r => r[4] === 'Closing balance 1000')!
    expect(close[8]).toBe(750)
    // The prior-year posting itself is not a line in this period's detail.
    expect(rows.some(r => r[4] === 'Prior year call')).toBe(false)
  })

  it('adds a debit/credit column pair per comparison period on the trial balance', () => {
    const pkg = fixture()
    pkg.comparisons = [pkg.payload]
    const wb2 = buildStatementWorkbook(pkg, { fundName: 'F', vehicle: 'V', generatedAt: '2026-07-20T00:00:00Z' })
    const rows = XLSX.utils.sheet_to_json<unknown[]>(wb2.Sheets['Trial Balance'], { header: 1 })
    expect(rows[0]).toEqual(['Code', 'Account', 'Type', 'Debit YTD 2026', 'Credit YTD 2026', 'Debit YTD 2026', 'Credit YTD 2026'])
    const totals = rows.find(r => r[1] === 'Totals')!
    expect(totals.slice(3)).toEqual([250, 250, 250, 250])
  })

  it('surfaces the unallocated-earnings warning on the cover', () => {
    const rows = XLSX.utils.sheet_to_json<unknown[]>(wb.Sheets['Cover'], { header: 1 })
    const flat = rows.flat().join(' ')
    expect(flat).toContain('not yet allocated')
  })

  it('adds one value column per comparison period', () => {
    const pkg = fixture()
    pkg.comparisons = [pkg.payload] // reuse the same payload as a stand-in prior period
    const wb = buildStatementWorkbook(pkg, { fundName: 'F', vehicle: 'V', generatedAt: '2026-07-20T00:00:00Z' })
    const bs = wb.Sheets[wb.SheetNames.find(n => n.startsWith('Balance')) ?? '']
    const ref = XLSX.utils.decode_range(bs['!ref']!)
    // label col + 2 period cols = at least 3 columns (index 3 required for second value column)
    expect(ref.e.c).toBeGreaterThanOrEqual(3)
  })

  it('adds month columns after the annual ones on the trial balance and statements, not on capital or the SOI', () => {
    const pkg = fixture()
    pkg.comparisons = [{ ...pkg.payload, period: { ...pkg.payload.period, label: 'FY 2025' } }]
    pkg.months = ['Jan 2026', 'Feb 2026', 'Mar 2026'].map(label => ({ ...pkg.payload, period: { ...pkg.payload.period, label } }))
    const wb = buildStatementWorkbook(pkg, { fundName: 'F', vehicle: 'V', generatedAt: '2026-07-20T00:00:00Z' })
    const rowsOf = (name: string) => XLSX.utils.sheet_to_json<unknown[]>(wb.Sheets[name], { header: 1 })

    const tb = rowsOf('Trial Balance')
    expect(tb[0]).toEqual([
      'Code', 'Account', 'Type', 'Debit YTD 2026', 'Credit YTD 2026', 'Debit FY 2025', 'Credit FY 2025',
      'Debit Jan 2026', 'Credit Jan 2026', 'Debit Feb 2026', 'Credit Feb 2026', 'Debit Mar 2026', 'Credit Mar 2026',
    ])

    const is = rowsOf('Income Statement')
    expect(is[2]).toEqual(['', '', 'YTD 2026', 'FY 2025', 'Jan 2026', 'Feb 2026', 'Mar 2026'])
    expect(is.find(r => r[0] === 'Net income')).toEqual(['Net income', '', -250, -250, -250, -250, -250])
    expect(rowsOf('Balance Sheet')[2]).toEqual(['', '', 'YTD 2026', 'FY 2025', 'Jan 2026', 'Feb 2026', 'Mar 2026'])
    expect(rowsOf('Cash Flows')[2]).toEqual(['', '', 'YTD 2026', 'FY 2025', 'Jan 2026', 'Feb 2026', 'Mar 2026'])

    // Partners' capital keeps the annual matrix (two periods), the SOI its annual cost/value pairs.
    expect(rowsOf('Partners Capital')[2]).toEqual(['Partner', 'YTD 2026', 'FY 2025'])
    expect(rowsOf('Schedule of Investments')[2]).toEqual(['Investment', 'Industry', 'Country', 'Cost YTD 2026', 'Fair value YTD 2026', 'Cost FY 2025', 'Fair value FY 2025', '% of net assets'])

    expect(rowsOf('Cover').flat().join(' ')).toContain('a column for each month')
  })
})
