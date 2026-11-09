import { describe, it, expect } from 'vitest'
import { computeCapitalAccounts, rollForwardTies, type CapitalPosting } from './capital-account'
import {
  basisExclusion, parseStatementBasis, partnerTakesBases, postingsForBasis, BASIS_NOTES, type StatementBasis,
} from './statement-basis'
import { commitmentSummaryRows } from './capital-statement-layout'
import { buildStatementHtml, type StatementPdfData } from './lp-statement-pdf'

// One partner over four quarters, with invented figures. Postings are debit-positive, as the ledger
// stores them: a credit (negative) increases the partner's capital.
const LP = 'partner-a'
const credit = (entryDate: string, sourceType: string, capital: number): CapitalPosting =>
  ({ lpEntityId: LP, entryDate, sourceType, amount: -capital })

const postings: CapitalPosting[] = [
  // Q1 2025: contribution, fee, income, a positive mark
  credit('2025-01-15', 'capital_call', 100_000),
  credit('2025-03-31', 'management_fee', -2_000),
  credit('2025-03-31', 'income', 300),
  credit('2025-03-31', 'valuation', 5_000),
  // Q2 2025: a realized gain, a negative mark, currency translation of unrealized value
  credit('2025-05-10', 'realized_gain', 1_200),
  credit('2025-06-30', 'valuation', -7_500),
  credit('2025-06-30', 'fx_revaluation', 250),
  credit('2025-06-30', 'partnership_expense', -400),
  // Q3 2025: a distribution, a write-off through realized loss, another positive mark
  credit('2025-08-01', 'distribution', -3_000),
  credit('2025-09-30', 'realized_gain', -600),
  credit('2025-09-30', 'valuation', 4_000),
  credit('2025-09-30', 'income', 150),
  // Q4 2025: fee and a negative mark
  credit('2025-12-31', 'management_fee', -2_000),
  credit('2025-12-31', 'valuation', -1_000),
]

const Q3 = { start: '2025-07-01', end: '2025-09-30' }
const Q4 = { start: '2025-10-01', end: '2025-12-31' }
const account = (basis: StatementBasis, period?: { start?: string; end?: string }) =>
  computeCapitalAccounts(postingsForBasis(postings, basis), period).get(LP)!

describe('statement basis', () => {
  const fvItd = account('fair_value')
  const itdUnrealized = 5_000 - 7_500 + 4_000 - 1_000 // 500
  const itdFx = 250
  const itdRealized = 1_200 - 600 // 600

  it('leaves fair value exactly as the books have it', () => {
    expect(postingsForBasis(postings, 'fair_value')).toBe(postings)
    expect(fvItd.unrealizedGains).toBe(itdUnrealized)
    expect(fvItd.ending).toBe(94_400)
  })

  it('cost basis drops every mark and the FX translation, in every column, and keeps the rest', () => {
    for (const period of [undefined, Q3, Q4, { start: '2025-01-01', end: '2025-12-31' }]) {
      const cost = account('cost', period)
      const fv = account('fair_value', period)
      expect(cost.unrealizedGains).toBe(0)
      expect(cost.fxTranslation).toBe(0)
      for (const line of ['contributions', 'distributions', 'managementFees', 'expenses', 'operatingIncome', 'realizedGains'] as const) {
        expect(cost[line]).toBe(fv[line])
      }
      expect(rollForwardTies(cost)).toBe(true)
    }
  })

  it("rolls a period's beginning forward from the prior period's cost-basis ending, not fair value less this period's marks", () => {
    const q3 = account('cost', Q3)
    const q4 = account('cost', Q4)
    expect(q4.beginning).toBe(q3.ending)
    // Through Q3: 100,000 − 2,000 + 300 + 1,200 − 400 − 3,000 − 600 + 150
    expect(q3.ending).toBe(95_650)
    // The tempting wrong answer: fair-value beginning, with only this quarter's marks taken out.
    const fvQ4 = account('fair_value', Q4)
    expect(q4.beginning).not.toBe(fvQ4.beginning)
  })

  it('foots: cost ending = fair value ending − ITD unrealized (marks and their FX translation)', () => {
    const cost = account('cost')
    expect(cost.ending).toBe(fvItd.ending - itdUnrealized - itdFx)
    expect(basisExclusion(fvItd, 'cost')).toBe(itdUnrealized + itdFx)
    expect(fvItd.ending - cost.ending).toBe(basisExclusion(fvItd, 'cost'))
  })

  it('contributions and income only also drops realized gains and losses, write-offs included', () => {
    const cash = account('cash_only')
    expect(cash.realizedGains).toBe(0)
    expect(cash.unrealizedGains).toBe(0)
    expect(cash.fxTranslation).toBe(0)
    expect(cash.operatingIncome).toBe(450)
    expect(cash.ending).toBe(fvItd.ending - itdUnrealized - itdFx - itdRealized)
    expect(fvItd.ending - cash.ending).toBe(basisExclusion(fvItd, 'cash_only'))
    expect(account('cash_only', Q4).beginning).toBe(account('cash_only', Q3).ending)
  })

  it('offers cost and contributions-only only to partners whose capital is the ledger, line by line', () => {
    expect(partnerTakesBases(undefined)).toBe(true)
    expect(partnerTakesBases({ basis: 'ledger' })).toBe(true)
    // Administrator snapshots lump fees, income and gains into one unrealized leftover.
    expect(partnerTakesBases({ basis: 'reported' })).toBe(false)
    expect(partnerTakesBases({ basis: 'missing' })).toBe(false)
  })

  it('refuses an unknown basis instead of falling back to fair value', () => {
    expect(parseStatementBasis(undefined)).toBe('fair_value')
    expect(parseStatementBasis('', 'cost')).toBe('cost')
    expect(parseStatementBasis('cash_only')).toBe('cash_only')
    expect(parseStatementBasis('book')).toEqual({ error: expect.stringContaining('fair_value') })
  })
})

describe('statement basis on the document', () => {
  const cost = account('cost')
  const data = (over: Partial<StatementPdfData>): StatementPdfData => ({
    fundName: 'Example Capital', fundLogo: null, fundAddress: null, currency: 'USD',
    vehicle: 'Example Fund LP', partnerName: 'Partner A',
    period: { label: 'Inception to date', start: null, end: null } as any,
    row: { commitment: 150_000, called: 100_000, funded: 100_000, outstanding: 50_000, receivable: 0, ending: cost.ending },
    periodRollForward: cost, ytdRollForward: cost, rollForward: cost, ownership: 0.05,
    ...over,
  })
  const text = (html: string) => html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ')

  it('prints the basis so an LP can tell which version they have', () => {
    expect(text(buildStatementHtml(data({ basis: 'cost' })))).toContain(BASIS_NOTES.cost!)
    expect(text(buildStatementHtml(data({ basis: 'cash_only' })))).toContain(BASIS_NOTES.cash_only!)
    expect(text(buildStatementHtml(data({})))).not.toContain('Presented on')
  })

  it('names the basis on the ending capital line instead of calling it NAV', () => {
    const row = { commitment: 1, called: 1, outstanding: 0, receivable: 0, ending: 1 }
    expect(commitmentSummaryRows([cost], row, 1).at(-1)!.label).toBe('Ending capital (NAV)')
    expect(commitmentSummaryRows([cost], row, 1, 'cost').at(-1)!.label).toBe('Ending capital (cost basis)')
    expect(text(buildStatementHtml(data({ basis: 'cost' })))).not.toContain('Net unrealized')
  })
})
