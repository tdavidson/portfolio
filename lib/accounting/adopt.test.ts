// lib/accounting/adopt.test.ts
import { describe, it, expect } from 'vitest'
import { readInvestmentLines, touchesInvestmentAccounts } from './adopt'
import type { ChartAccount } from './investment-accounts'

const A = (id: string, code: string, type: string, subtype: string | null, companyId: string | null = null): ChartAccount =>
  ({ id, code, type, subtype, companyId })
const chart: ChartAccount[] = [
  A('cash', '1000', 'asset', 'cash'),
  A('esc', '1350', 'asset', 'escrow_receivable'),
  A('ap', '2000', 'liability', 'payable'),
  A('a1100', '1100-aaaa', 'asset', 'investment', 'co-a'),
  A('a1200', '1200-aaaa', 'asset', 'unrealized', 'co-a'),
  A('a1250', '1250-aaaa', 'asset', 'fx_translation', 'co-a'),
  A('a4000', '4000-aaaa', 'income', 'realized_gain', 'co-a'),
  A('a1150', '1150-aaaa', 'asset', 'accrued_interest', 'co-a'),
  A('b1100', '1100-bbbb', 'asset', 'investment', 'co-b'),
  A('c1100', '1100-cccc', 'asset', 'investment', 'co-c'),
  A('p1100', '1100', 'asset', 'investment'),
  A('p4000', '4000', 'income', 'realized_gain'),
  A('p4200', '4200', 'income', 'unrealized'),
  A('p4300', '4300', 'income', 'fx_translation'),
  A('inc', '4120', 'income', 'portfolio_income'),
]
const L = (accountId: string, amount: number) => ({ accountId, amount })
const read = (...lines: { accountId: string; amount: number }[]) => readInvestmentLines(lines, chart)

describe('readInvestmentLines — what it reads', () => {
  it('a purchase', () => {
    expect(read(L('a1100', 1000), L('cash', -1000))).toEqual({ transactions: [
      { company_id: 'co-a', transaction_type: 'investment', investment_cost: 1000 },
    ] })
  })
  it('a purchase on account (no cash) reads the same — the offset is context', () => {
    expect(read(L('a1100', 1000), L('ap', -1000))).toEqual({ transactions: [
      { company_id: 'co-a', transaction_type: 'investment', investment_cost: 1000 },
    ] })
  })
  it('a mark', () => {
    expect(read(L('a1200', 250), L('p4200', -250))).toEqual({ transactions: [
      { company_id: 'co-a', transaction_type: 'unrealized_gain_change', unrealized_value_change: 250, valuation_change_source: 'mark' },
    ] })
  })
  it('an FX mark', () => {
    expect(read(L('a1250', -40), L('p4300', 40))).toEqual({ transactions: [
      { company_id: 'co-a', transaction_type: 'unrealized_gain_change', fx_value_change: -40, valuation_change_source: 'fx' },
    ] })
  })
  it("an exit with the gain on the company's own 4000, unwinding its mark", () => {
    expect(read(L('cash', 1500), L('a1100', -1000), L('a4000', -500), L('a1200', -200), L('p4200', 200))).toEqual({ transactions: [
      { company_id: 'co-a', transaction_type: 'proceeds', cost_basis_exited: 1000, proceeds_received: 1500 },
    ] })
  })
  it('an exit with the gain on pooled 4000, one company', () => {
    expect(read(L('cash', 1200), L('a1100', -1000), L('p4000', -200))).toEqual({ transactions: [
      { company_id: 'co-a', transaction_type: 'proceeds', cost_basis_exited: 1000, proceeds_received: 1200 },
    ] })
  })
  it('an exit at a loss', () => {
    expect(read(L('cash', 700), L('a1100', -1000), L('a4000', 300))).toEqual({ transactions: [
      { company_id: 'co-a', transaction_type: 'proceeds', cost_basis_exited: 1000, proceeds_received: 700 },
    ] })
  })
  it('an exit with escrow held back', () => {
    expect(read(L('cash', 900), L('esc', 100), L('a1100', -800), L('a4000', -200))).toEqual({ transactions: [
      { company_id: 'co-a', transaction_type: 'proceeds', cost_basis_exited: 800, proceeds_received: 900, proceeds_escrow: 100 },
    ] })
  })
  it('in-kind income reads as a purchase at that cost', () => {
    expect(read(L('a1100', 300), L('inc', -300))).toEqual({ transactions: [
      { company_id: 'co-a', transaction_type: 'investment', investment_cost: 300 },
    ] })
  })
  it('a compound purchase across three companies, in company order', () => {
    expect(read(L('c1100', 300), L('a1100', 100), L('b1100', 200), L('cash', -600))).toEqual({ transactions: [
      { company_id: 'co-a', transaction_type: 'investment', investment_cost: 100 },
      { company_id: 'co-b', transaction_type: 'investment', investment_cost: 200 },
      { company_id: 'co-c', transaction_type: 'investment', investment_cost: 300 },
    ] })
  })
  it('an entry on 4200 and cash only has nothing to adopt', () => {
    expect(read(L('p4200', -50), L('cash', 50))).toEqual({ transactions: [] })
    expect(touchesInvestmentAccounts([L('p4200', -50), L('cash', 50)], chart)).toBe(false)
  })
})

describe('readInvestmentLines — what it refuses', () => {
  const refused = (r: ReturnType<typeof read>) => ('refused' in r ? r.refused : '')
  it('a pooled investment account', () => {
    expect(refused(read(L('p1100', 100), L('cash', -100)))).toMatch(/pooled.*1100.*company's own account/i)
  })
  it('a gain on pooled 4000 when several companies exit', () => {
    expect(refused(read(L('cash', 2200), L('a1100', -1000), L('b1100', -1000), L('p4000', -200)))).toMatch(/more than one company/i)
  })
  it('escrow when several companies exit', () => {
    expect(refused(read(L('cash', 1900), L('esc', 100), L('a1100', -1000), L('b1100', -1000)))).toMatch(/escrow/i)
  })
  it('a realized gain with no exit', () => {
    expect(refused(read(L('cash', 100), L('a4000', -100)))).toMatch(/gain.*no exit/i)
  })
  it('cost lines netting to zero beside other investment lines', () => {
    expect(refused(read(L('a1100', 100), L('a1100', -100), L('a1200', 50), L('p4200', -50)))).toMatch(/cannot be read/i)
  })
  it('a conversion (cost and a mark together)', () => {
    expect(refused(read(L('a1100', 100), L('cash', -100), L('a1200', 50), L('p4200', -50)))).toMatch(/conversion/i)
  })
  it('note interest capitalising', () => {
    expect(refused(read(L('a1100', 30), L('a1150', -30)))).toMatch(/conversion/i)
  })
  it('a purchase and an FX move together', () => {
    expect(refused(read(L('a1100', 100), L('cash', -100), L('a1250', 5), L('p4300', -5)))).toMatch(/split/i)
  })
})
