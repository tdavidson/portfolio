import { describe, it, expect } from 'vitest'
import * as XLSX from 'xlsx'
import { buildForecastWorkbook, buildVarianceWorkbook } from './workbook'
import { varianceCell } from './variance'
import type { RuleView, SeriesResult, VarianceResponse } from './service'

// Six months: January–March actual, April–June forecast. Each rule method the workbook drives from
// the Assumptions sheet appears once, plus an override the rule doesn't explain.
const months = ['2026-01', '2026-02', '2026-03', '2026-04', '2026-05', '2026-06']
const status = ['actual', 'actual', 'actual', 'forecast', 'forecast', 'forecast'] as const
const z = () => ({ actual: 0, forecast: 0 })

const lines = [
  { accountId: 'fees', code: '4000', name: 'Fee income', type: 'income' as const, values: [900, 950, 1000, 1000, 1000, 1200] },
  { accountId: 'rent', code: '6100', name: 'Rent', type: 'expense' as const, values: [480, 500, 510, 500, 500, 500] },
  { accountId: 'software', code: '6200', name: 'Software', type: 'expense' as const, values: [190, 195, 200, 200, 220, 242] },
  // Recurring 3,000 every May; June is an override the rule doesn't produce.
  { accountId: 'tax', code: '6300', name: '=HYPERLINK("http://evil")', type: 'expense' as const, values: [0, 0, 0, 0, 3000, 100] },
  { accountId: 'travel', code: '6400', name: 'Travel', type: 'expense' as const, values: [140, 160, 150, 150, 150, 150] },
]

const rules: RuleView[] = [
  { id: 'r1', accountId: 'fees', method: 'seasonal', params: { profile: { 4: 1000, 5: 1000, 6: 1200 }, anchor: '2026-04' }, cashTiming: { kind: 'same_month' } as any, source: 'manual', note: null },
  { id: 'r2', accountId: 'rent', method: 'fixed', params: { amount: 500 }, cashTiming: { kind: 'same_month' } as any, source: 'manual', note: null },
  { id: 'r3', accountId: 'software', method: 'growth', params: { base: 200, baseMonth: '2026-04', rate: 0.1, per: 'month' }, cashTiming: { kind: 'same_month' } as any, source: 'manual', note: null },
  { id: 'r4', accountId: 'tax', method: 'recurring', params: { amount: 3000, everyMonths: 12, anchor: '2026-05' }, cashTiming: { kind: 'same_month' } as any, source: 'manual', note: null },
  { id: 'r5', accountId: 'travel', method: 'run_rate', params: { window: 3 }, cashTiming: { kind: 'same_month' } as any, source: 'manual', note: null },
]

function fixture(): SeriesResult {
  const rev = months.map((_, i) => lines.filter(l => l.type === 'income').reduce((s, l) => s + l.values[i], 0))
  const exp = months.map((_, i) => lines.filter(l => l.type === 'expense').reduce((s, l) => s + l.values[i], 0))
  const called = [0, 5000, 0, 0, 0, 0]
  const distributed = [0, 0, 0, 0, 0, -2000]
  const operating = months.map((_, i) => rev[i] - exp[i])
  let running = 10000
  const cash = months.map((_, i) => {
    const movement = operating[i] + called[i] + distributed[i]
    const c = { opening: running, movement, ending: running + movement }
    running = c.ending
    return c
  })
  return {
    view: 'combined', interval: 'month',
    periods: months.map((m, i) => ({ key: m, label: m, start: `${m}-01`, end: `${m}-28`, months: [m], status: status[i], partial: false })),
    months: months.map((m, i) => ({ month: m, status: status[i] })),
    lines, revenue: rev, expenses: exp, netIncome: operating, cash, boundary: '2026-03',
    cashFlows: null,
    cashDetail: [
      ...lines.map(l => ({ section: 'operating' as const, key: l.accountId, label: l.name, code: l.code, values: l.values.map(v => (l.type === 'income' ? v : -v)) })),
      { section: 'financing', key: 'called', label: 'Capital contributions', code: null, values: called },
      { section: 'financing', key: 'distributed', label: 'Distributions', code: null, values: distributed },
      { section: 'financing', key: 'distributed:lp', label: 'To the LPs', code: null, parent: 'distributed', values: [0, 0, 0, 0, 0, -1500] },
      { section: 'financing', key: 'distributed:carry', label: 'Carried interest', code: null, parent: 'distributed', values: [0, 0, 0, 0, 0, -500] },
    ],
    cashBasis: null, indirect: null, cashAccounts: [],
    vehicle: 'Fund I', currency: 'USD',
    plan: { id: 'p', name: 'Budget', kind: 'rolling_forecast', revision: 1 }, version: null,
    actualsThrough: '2026-03', closedThrough: '2026-03', overridden: { tax: ['2026-06'] }, sources: {},
    planWindow: { first: '2026-04', last: '2026-06' }, warnings: [],
    capitalActivity: { called: z(), distributed: z(), recycled: z(), invested: z(), fees: z(), org: z(), partnership: z() },
  }
}

const build = (interval: 'month' | 'quarter' = 'month') =>
  buildForecastWorkbook({
    monthly: fixture(), rules, interval,
    accounts: lines.map(l => ({ id: l.accountId, code: l.code, name: l.name })),
    meta: { fundName: 'Test Fund', generatedAt: '2026-10-11T00:00:00Z' },
  })

/** Find the row whose column B (or A) reads `label`. */
function rowOf(ws: XLSX.WorkSheet, label: string): number {
  const range = XLSX.utils.decode_range(ws['!ref']!)
  for (let r = 0; r <= range.e.r; r++) if (ws[`B${r + 1}`]?.v === label || ws[`A${r + 1}`]?.v === label) return r + 1
  throw new Error(`no row ${label}`)
}

describe('buildForecastWorkbook', () => {
  it('writes rule-driven forecast months as formulas over the Assumptions sheet', () => {
    const ws = build().Sheets.Monthly
    const rent = rowOf(ws, 'Rent')
    expect(ws[`C${rent}`]).toMatchObject({ v: 480 }) // actual: a value
    expect(ws[`C${rent}`].f).toBeUndefined()
    expect(ws[`F${rent}`].f).toMatch(/^Assumptions!\$E\$\d+$/)
    expect(ws[`H${rent}`].v).toBe(500)

    const software = rowOf(ws, 'Software')
    expect(ws[`G${software}`].f).toMatch(/^ROUND\(Assumptions!\$E\$\d+\*\(1\+Assumptions!\$F\$\d+\)\^1,2\)$/)
    expect(ws[`H${software}`].v).toBe(242)

    const fees = rowOf(ws, 'Fee income')
    expect(ws[`H${fees}`].f).toMatch(/Assumptions!\$R\$\d+/) // June's profile cell (column M + 5)
  })

  it('keeps the app value where the rule does not explain it, and never puts names in formulas', () => {
    const wb = build()
    const ws = wb.Sheets.Monthly
    const tax = rowOf(ws, '=HYPERLINK("http://evil")')
    expect(ws[`B${tax}`].t).toBe('s')
    expect(ws[`G${tax}`].f).toMatch(/^ROUND\(/) // May: the recurring charge
    expect(ws[`H${tax}`]).toMatchObject({ v: 100 }) // June: the override
    expect(ws[`H${tax}`].f).toBeUndefined()
    for (const name of wb.SheetNames) {
      for (const [k, c] of Object.entries(wb.Sheets[name])) if (!k.startsWith('!') && (c as any).f) expect((c as any).f).not.toMatch(/HYPERLINK|evil/)
    }
  })

  it('totals, net income and the cash roll-forward are formulas that tie to the app', () => {
    const s = fixture()
    const ws = build().Sheets.Monthly
    const revenue = rowOf(ws, 'Total revenue')
    const net = rowOf(ws, 'Net income')
    const opening = rowOf(ws, 'Opening cash')
    const ending = rowOf(ws, 'Ending cash')
    const financing = rowOf(ws, 'Net cash from financing activities')
    expect(ws[`C${revenue}`].f).toMatch(/^SUM\(/)
    expect(ws[`C${net}`].f).toBe(`C${revenue}-C${rowOf(ws, 'Total expenses')}`)
    expect(ws[`C${opening}`].f).toBeUndefined()
    expect(ws[`D${opening}`].f).toBe(`C${ending}`)
    expect(ws[`D${ending}`].f).toBe(`D${opening}+D${rowOf(ws, 'Net cash movement')}`)
    // The distribution's breakdown is not added again.
    expect(ws[`H${financing}`].v).toBe(-2000)
    s.cash.forEach((c, i) => expect(ws[`${XLSX.utils.encode_col(2 + i)}${ending}`].v).toBe(c!.ending))
    // The Total column: flows add up, ending cash is the last month's.
    expect(ws[`I${ending}`].v).toBe(s.cash[5]!.ending)
  })

  it('adds a quarterly sheet that sums the monthly one', () => {
    const wb = build('quarter')
    expect(wb.SheetNames).toEqual(['Summary', 'Quarterly', 'Monthly', 'Assumptions'])
    const q = wb.Sheets.Quarterly
    const rent = rowOf(q, 'Rent')
    expect(q[`C${rent}`]).toMatchObject({ f: `SUM(Monthly!C${rent}:E${rent})`, v: 1490 })
    expect(q[`D${rent}`].v).toBe(1500)
    const opening = rowOf(q, 'Opening cash')
    expect(q[`D${opening}`].f).toBe(`Monthly!F${opening}`)
  })
})

describe('buildVarianceWorkbook', () => {
  it('writes the difference and percentage as formulas over base and compare', () => {
    const cells = [varianceCell(100, 120, 'expense'), varianceCell(0, 50, 'expense')]
    const v = {
      interval: 'month', vehicle: 'Fund I', currency: 'USD',
      periods: [{ key: '2026-01', label: 'Jan 2026', start: '2026-01', end: '2026-01', months: ['2026-01'], partial: false },
        { key: '2026-02', label: 'Feb 2026', start: '2026-02', end: '2026-02', months: ['2026-02'], partial: false }],
      lines: [{ accountId: 'rent', code: '6100', name: 'Rent', type: 'expense', cells, total: varianceCell(100, 170, 'expense') }],
      revenue: [null, null], expenses: cells, netIncome: cells, endingCash: [], totals: { revenue: null, expenses: null, netIncome: null },
      base: { plan: { id: 'p', name: 'Budget', kind: 'budget', revision: 1 }, version: null }, compare: { kind: 'actual' },
      actualsThrough: '2026-02', closedThrough: null, largest: { revenue: [], expenses: [] }, warnings: [],
    } as unknown as VarianceResponse
    const ws = buildVarianceWorkbook(v, { fundName: 'Test Fund', generatedAt: 'now' }).Sheets.Variance
    // Rows 6–9: Rent base, compare, difference, %.
    expect(ws.D8).toMatchObject({ f: 'D7-D6', v: 20 })
    expect(ws.D9).toMatchObject({ f: 'IF(D6=0,"",D8/ABS(D6))', v: 0.2 })
    expect(ws.F8).toMatchObject({ f: 'F7-F6', v: 70 })
    const net = rowOf(ws, 'Net income')
    expect(ws[`D${net}`].f).toMatch(/^D\d+-D\d+$/)
  })
})

describe('the balance sheet in the workbook', () => {
  const withBalanceSheet = (): SeriesResult => {
    const s = fixture()
    const ending = s.cash.map(c => c!.ending)
    const capital = [10_000, 15_000, 15_000, 15_000, 15_000, 13_000]
    const net = ending.map((v, i) => v - capital[i])
    return {
      ...s,
      balanceSheet: {
        assets: { rows: [{ key: 'cash', code: '1000', name: 'Cash', values: ending }], total: ending },
        liabilities: { rows: [], total: ending.map(() => 0) },
        equity: {
          label: "Partners' capital",
          rows: [{ key: 'capital', code: null, name: "Partners' capital", values: capital }, { key: 'net_income', code: null, name: 'Net income not yet closed', values: net }],
          total: ending,
        },
        check: ending.map(() => 0),
      },
    }
  }
  const book = (interval: 'month' | 'quarter') => buildForecastWorkbook({
    monthly: withBalanceSheet(), rules, interval,
    accounts: lines.map(l => ({ id: l.accountId, code: l.code, name: l.name })),
    meta: { fundName: 'Test Fund', generatedAt: '2026-10-11T00:00:00Z' },
  })

  it('totals the balances with formulas and checks that the sheet balances', () => {
    const ws = book('month').Sheets.Monthly
    const assets = rowOf(ws, 'Total assets')
    const both = rowOf(ws, "Total liabilities and partners' capital")
    const check = rowOf(ws, 'Out of balance (should be zero)')
    expect(ws[`D${assets}`].f).toBe(`SUM(D${rowOf(ws, 'Cash')})`)
    expect(ws[`D${both}`].f).toBe(`SUM(D${rowOf(ws, 'Total liabilities')},D${rowOf(ws, "Total partners' capital")})`)
    expect(ws[`D${check}`]).toMatchObject({ f: `D${assets}-D${both}`, v: 0 })
    // The range's column is the last period's balance, not a sum of balances.
    expect(ws[`I${rowOf(ws, 'Cash')}`].f).toBe(`H${rowOf(ws, 'Cash')}`)
  })

  it('takes each quarter at its last month', () => {
    const wb = book('quarter')
    const q = wb.Sheets.Quarterly
    const cash = rowOf(q, 'Cash')
    expect(q[`C${cash}`].f).toBe(`Monthly!E${rowOf(wb.Sheets.Monthly, 'Cash')}`)
  })
})
