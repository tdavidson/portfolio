import { describe, it, expect } from 'vitest'
import { proposeMapping, type ChartAccount } from './propose-mapping'

const CHART = [
  { id: 'a1', code: '1000', name: 'Cash', type: 'asset', subtype: 'cash' },
  { id: 'a2', code: '1100', name: 'Investments at cost', type: 'asset', subtype: 'investment' },
  { id: 'a3', code: '5100', name: 'Partnership expenses', type: 'expense', subtype: 'partnership_expense' },
  { id: 'a4', code: '5000', name: 'Management fee', type: 'expense', subtype: 'management_fee' },
]
const qb = (account: string) => ({ account, lineCount: 1, totalDebit: 0, totalCredit: 0 })

describe('proposeMapping', () => {
  it('maps a bank account to cash', () => {
    const [p] = proposeMapping([qb('Bank:Operating')], CHART)
    expect(p.code).toBe('1000')
    expect(p.confidence).not.toBe('none')
  })

  it('keeps an investment sub-account unresolved until its dedicated account exists', () => {
    // The key move: a per-fund investment account in QuickBooks IS the discovery of a
    // fund holding. The leaf name becomes the holding.
    const [p] = proposeMapping([qb('Investments:Acme Ventures III')], CHART)
    expect(p.code).toBeNull()
    expect(p.suggestsHolding).toBe('Acme Ventures III')
  })

  it('does not suggest a holding for the investments parent itself', () => {
    const [p] = proposeMapping([qb('Investments')], CHART)
    expect(p.suggestsHolding).toBeNull()
  })

  it('does not suggest a holding for a top-level account that merely has a fund-like name', () => {
    // "Acme Ventures III" with no parent could be anything — a vendor, an expense line.
    // Guessing here would create a phantom holding with a real commitment field.
    const [p] = proposeMapping([qb('Acme Ventures III')], CHART)
    expect(p.suggestsHolding).toBeNull()
  })

  it('matches on our account name exactly, case-insensitively', () => {
    const [p] = proposeMapping([qb('management fee')], CHART)
    expect(p.code).toBe('5000')
    expect(p.confidence).toBe('exact')
  })

  it('returns none with a reason when nothing matches, rather than a wrong guess', () => {
    const [p] = proposeMapping([qb('Suspense — ask Dana')], CHART)
    expect(p.code).toBeNull()
    expect(p.confidence).toBe('none')
    expect(p.reason.length).toBeGreaterThan(10)
  })

  it('returns one proposal per QuickBooks account, in the order given', () => {
    const ps = proposeMapping([qb('Bank:Operating'), qb('Management Fee')], CHART)
    expect(ps.map(p => p.qbAccount)).toEqual(['Bank:Operating', 'Management Fee'])
  })

  it('maps a keyword hit to a likely, not an exact, match', () => {
    const [p] = proposeMapping([qb('Audit Fees')], CHART)
    expect(p.code).toBe('5100')
    expect(p.confidence).toBe('likely')
    expect(p.reason).toMatch(/5100/)
  })

  it('falls back to none when the keyword has no account in this chart', () => {
    // The chart has no realized-gain account, so a realized-gain QB account cannot be mapped.
    const [p] = proposeMapping([qb('Realized Gain on Sale')], CHART)
    expect(p.code).toBeNull()
    expect(p.confidence).toBe('none')
  })
})

/**
 * The management company's QuickBooks import.
 *
 * A manco's general ledger is mostly compensation and occupancy — none of which has an analogue on
 * a fund's chart. Before these rules existed the mapping screen offered `confidence: 'none'` for
 * essentially every expense account, which is not wrong (a human confirms every proposal) but
 * makes importing a firm's history twenty dropdowns of manual work.
 *
 * The mechanism worth pinning is that NO rule here is chart-kind aware: a rule whose subtype is
 * absent from the vehicle's chart is skipped, so the same keyword table serves both charts and a
 * manco rule can never fire on a fund.
 */
import { MANAGEMENT_COMPANY_CHART, DEFAULT_CHART } from '../chart'

const asChart = (seed: typeof MANAGEMENT_COMPANY_CHART) =>
  seed.map((a, i) => ({ id: `id-${i}`, code: a.code, name: a.name, type: a.type, subtype: a.subtype ?? null }))

const MANCO = asChart(MANAGEMENT_COMPANY_CHART)
const FUND = asChart(DEFAULT_CHART)

const codeFor = (account: string, chart: ChartAccount[]) => proposeMapping([qb(account)], chart)[0].code

describe('proposeMapping — management company charts', () => {
  it('maps the compensation accounts a fund chart has no home for', () => {
    expect(codeFor('Payroll:Salaries and Wages', MANCO)).toBe('5000')
    expect(codeFor('Payroll Taxes', MANCO)).toBe('5010')
    expect(codeFor('Employee Benefits — Health', MANCO)).toBe('5020')
    expect(codeFor('Annual Bonus', MANCO)).toBe('5030')
  })

  it('maps the rest of an operating business', () => {
    expect(codeFor('Office Rent', MANCO)).toBe('5100')
    expect(codeFor('Software Subscriptions', MANCO)).toBe('5300')
    expect(codeFor('Travel & Entertainment', MANCO)).toBe('5400')
    expect(codeFor('Depreciation Expense', MANCO)).toBe('5800')
  })

  it('sends the management fee to income here and to expense on a fund', () => {
    // The same QuickBooks account name, and the two entities book it on opposite sides. The rule
    // for the expense is tried first and simply does not apply to a chart without one.
    expect(codeFor('Management Fee', MANCO)).toBe('4000')
    expect(codeFor('Management Fee', FUND)).toBe('5000')
  })

  it('no longer reads "Operating Expenses" as the operating bank account', () => {
    // The bug this rule ordering fixes: "operating" was a cash keyword, so the largest expense
    // account on a manco's books mapped confidently to 1000 Cash — a confident wrong mapping,
    // which is the one outcome proposeMapping is written to avoid.
    expect(codeFor('Operating Expenses', MANCO)).not.toBe('1000')
    // …while an account that really is the bank still maps.
    expect(codeFor('Operating Account', MANCO)).toBe('1000')
    expect(codeFor('Bank:Operating', MANCO)).toBe('1000')
  })

  it("leaves a fund's mappings alone — every manco rule is inert without the subtype", () => {
    expect(codeFor('Bank:Operating', FUND)).toBe('1000')
    expect(codeFor('Investments:Acme Ventures III', FUND)).toBeNull()
    expect(codeFor('Audit Fees', FUND)).toBe('5100')
    // A fund chart has no salaries account, so a payroll line stays unmapped rather than landing
    // somewhere plausible-looking.
    expect(codeFor('Salaries', FUND)).toBeNull()
  })
})


describe('migration account identity', () => {
  it('maps each investment to its own account, never another investment or pooled cost', () => {
    const chart = [...CHART,
      { id: 'coin', code: '1100-exchange', name: 'Investment — Exchange Co', type: 'asset', subtype: 'investment', company_id: 'exchange' },
      { id: 'multi', code: '1100-cinder', name: 'Investment — Cinderpeak Fund III', type: 'asset', subtype: 'investment', company_id: 'multi' },
    ]
    expect(proposeMapping([qb('Investments:Exchange Co'), qb('Investments:Cinderpeak Fund III'), qb('Investments:Unknown')], chart).map(p => p.code))
      .toEqual(['1100-exchange', '1100-cinder', null])
  })

  it('does not suggest an individual partner for generic partners capital', () => {
    const chart = [{ id: 'lp', code: '3100-other', name: "Partners’ capital — Other LP", type: 'equity', subtype: 'lp_capital', lp_entity_id: 'other' }]
    expect(proposeMapping([qb("Partners capital")], chart)[0].code).toBeNull()
    chart.push({ id: 'pool', code: '3100', name: 'LP (unallocated)', type: 'equity', subtype: 'lp_capital', lp_entity_id: '' })
    expect(proposeMapping([qb("Partners capital")], chart)[0].code).toBe('3100')
  })

  it('never maps accumulated amortization to amortization expense', () => {
    expect(codeFor('Accumulated Amortization of Other Assets', MANCO)).toBeNull()
    expect(codeFor('Amortization', MANCO)).toBe('5800')
  })

  it('does not suggest inactive accounts', () => {
    expect(proposeMapping([qb('Cash')], CHART.map(a => ({ ...a, is_active: false })))[0].code).toBeNull()
  })
})

describe('capital and gains must not become investment assets', () => {
  it.each(['Partner investments', "Partner's investments", 'Partners’ capital'])('maps %s to LP equity', name => {
    expect(codeFor(name, FUND)).toBe('3100')
    expect(codeFor(name, CHART)).toBeNull()
  })
  it('maps realized investment gains to income and refuses an asset fallback', () => {
    expect(codeFor('Realized Gains on Investment', FUND)).toBe('4000')
    expect(codeFor('Realized Gains on Investment', CHART)).toBeNull()
  })
})
