import { describe, it, expect } from 'vitest'
import { DEFAULT_CHART, GP_ENTITY_CHART, INDIVIDUAL_CHART, MANAGEMENT_COMPANY_CHART } from './chart'
import {
  categorizeBankRow, learnedAccount, payeeKey, affiliateNamed, accountForSubtypes,
  type ChartAccountRef, type HistoryEntry,
} from './bank-categorize'
import { historyFromRows } from './bank-categorize-context'

const fund = { chart: DEFAULT_CHART as ChartAccountRef[] }
const manco = { chart: MANAGEMENT_COMPANY_CHART as ChartAccountRef[] }
const gp = { chart: GP_ENTITY_CHART as ChartAccountRef[] }
const individual = { chart: INDIVIDUAL_CHART as ChartAccountRef[] }
const row = (amount: number, description: string, extra: { counterparty?: string; activity?: string } = {}) =>
  ({ date: '2026-01-15', amount, description, ...extra })

describe('categorizeBankRow — the entity\'s own chart', () => {
  it('keeps the fund chart suggestions the fund has always had', () => {
    expect(categorizeBankRow(row(5e6, 'Capital call'), fund).accountCode).toBe('3100')
    expect(categorizeBankRow(row(-12000, 'Annual audit'), fund).accountCode).toBe('5100')
    expect(categorizeBankRow(row(-50000, 'Management fee Q2'), fund).accountCode).toBe('5000')
    expect(categorizeBankRow(row(0.5, 'ACME BANK', { activity: 'Interest Income' }), fund).accountCode).toBe('4100')
    expect(categorizeBankRow(row(12, 'Dividend received'), fund).accountCode).toBe('4130')
    expect(categorizeBankRow(row(-420, 'Margin interest charged'), fund).accountCode).toBe('5300')
  })

  it('books a management company\'s rows to a management company\'s accounts', () => {
    // On this chart 3100 is member distributions and 5100 is rent: the fund codes would book
    // revenue as a draw and every unknown bill as rent.
    expect(categorizeBankRow(row(90000, 'Management fee Q1'), manco).accountCode).toBe('4000')
    expect(categorizeBankRow(row(3.21, 'Interest paid'), manco).accountCode).toBe('4200')
    expect(categorizeBankRow(row(-50000, 'GUSTO PAYROLL'), manco).accountCode).toBe('5000')
    expect(categorizeBankRow(row(-9000, 'EFTPS payroll tax'), manco).accountCode).toBe('5010')
    expect(categorizeBankRow(row(-15, 'SLACK T12345'), manco).accountCode).toBe('5300')
    expect(categorizeBankRow(row(-2500, 'Smith & Co law firm retainer'), manco).accountCode).toBe('5200')
    expect(categorizeBankRow(row(-1800, 'Quarterly tax prep CPA'), manco).accountCode).toBe('5210')
    expect(categorizeBankRow(row(-30, 'Outgoing wire fee'), manco).accountCode).toBe('5700')
    expect(categorizeBankRow(row(-6000, 'Office rent October'), manco).accountCode).toBe('5100')
  })

  it('falls back to a sensible account for the chart, flagged low', () => {
    const inMystery = categorizeBankRow(row(999, 'mystery'), manco)
    expect(inMystery.accountCode).toBe('4900')
    expect(inMystery.confidence).toBe('low')
    expect(inMystery.by).toBe('fallback')
    expect(categorizeBankRow(row(-999, 'mystery'), manco).accountCode).toBe('5700')
    expect(categorizeBankRow(row(999, 'mystery'), fund).accountCode).toBe('3100')
    expect(categorizeBankRow(row(-999, 'mystery'), fund).accountCode).toBe('5100')
  })

  it('never suggests cash, even on a chart that lacks the rule\'s account', () => {
    // A GP entity has no dividend or interest income account.
    const c = categorizeBankRow(row(12, 'Dividend received'), gp)
    expect(c.accountCode).not.toBe('1000')
    expect(c.accountCode).toBe('3000')
    expect(c.confidence).toBe('low')
  })

  it('says so when nothing in the chart fits', () => {
    const cashOnly = { chart: [{ code: '1000', name: 'Cash', type: 'asset', subtype: 'cash' }] as ChartAccountRef[] }
    const c = categorizeBankRow(row(-50, 'mystery'), cashOnly)
    expect(c.accountCode).toBeNull()
    expect(c.confidence).toBe('low')
  })

  it('never picks a partner\'s or a company\'s sub-account', () => {
    const chart: ChartAccountRef[] = [
      { code: '3100-abcdef12', name: 'Capital — A', type: 'equity', subtype: 'lp_capital', lpEntityId: 'abcdef12' },
      ...(DEFAULT_CHART as ChartAccountRef[]),
    ]
    expect(accountForSubtypes(chart, ['lp_capital'])?.code).toBe('3100')
  })
})

describe('categorizeBankRow — direction and whole words', () => {
  it('reads an outgoing subscription as software, not a capital call', () => {
    const c = categorizeBankRow(row(-49, 'Annual subscription renewal'), manco)
    expect(c.accountCode).toBe('5300')
    expect(c.sourceType).not.toBe('capital_call')
    // And on a fund, a partnership expense rather than LP capital.
    expect(categorizeBankRow(row(-49, 'Annual subscription renewal'), fund).accountCode).toBe('5100')
  })

  it('treats an incoming subscription as capital, on whichever capital account the chart has', () => {
    expect(categorizeBankRow(row(250000, 'Subscription — new partner'), fund).accountCode).toBe('3100')
    expect(categorizeBankRow(row(250000, 'Capital contribution'), manco).accountCode).toBe('3000')
  })

  it('reads a distribution only on money going out', () => {
    expect(categorizeBankRow(row(-10000, 'Member distribution'), manco).accountCode).toBe('3100')
    expect(categorizeBankRow(row(10000, 'Distribution'), fund).by).toBe('fallback')
  })

  it('matches whole words', () => {
    expect(categorizeBankRow(row(-38, 'Yellow taxi'), manco).accountCode).toBe('5400')
    expect(categorizeBankRow(row(-38, 'Yellow taxi'), manco).label).not.toMatch(/tax/i)
    // "current" contains "rent"; it is not rent.
    expect(categorizeBankRow(row(-38, 'current account charge'), manco).label).not.toBe('Rent and occupancy')
  })

  it('books benefits before travel when a word could mean either', () => {
    expect(categorizeBankRow(row(-400, 'Delta Dental premium'), manco).accountCode).toBe('5020')
  })

  it('reads a card payment as paying down the card, where the chart has one', () => {
    expect(categorizeBankRow(row(-1200, 'AMEX EPAYMENT ACH PMT'), individual).accountCode).toBe('2100')
    // A chart with no card account doesn't pretend: the row falls to the expense fallback.
    expect(categorizeBankRow(row(-1200, 'Credit card payment'), manco).accountCode).toBe('5700')
  })
})

describe('categorizeBankRow — transfers between the firm\'s own vehicles', () => {
  const affiliates = [
    { vehicleId: 'aaaaaaaa-1', names: ['Northwind Fund I, LP'] },
    { vehicleId: 'bbbbbbbb-2', names: ['Northwind Fund II, LP'] },
  ]
  const ctx = { chart: MANAGEMENT_COMPANY_CHART as ChartAccountRef[], affiliates, vehicleId: 'self' }

  it('tells Fund I from Fund II by the short word', () => {
    expect(affiliateNamed('Transfer from Northwind Fund II', affiliates)?.vehicleId).toBe('bbbbbbbb-2')
    expect(affiliateNamed('Transfer from Northwind Fund I', affiliates)?.vehicleId).toBe('aaaaaaaa-1')
    expect(affiliateNamed('Northwind Fund', affiliates)).toBeNull()
  })

  it('books money from an affiliate as due to it, and money to one as due from it', () => {
    const inn = categorizeBankRow(row(5000, 'Transfer from Northwind Fund II'), ctx)
    expect(inn.accountCode).toBe('2900')
    expect(inn.confidence).toBe('high')
    expect(categorizeBankRow(row(-5000, 'Transfer to Northwind Fund I'), ctx).accountCode).toBe('1900')
  })

  it('uses the per-counterparty sub-account when the chart has one', () => {
    const chart: ChartAccountRef[] = [
      ...(MANAGEMENT_COMPANY_CHART as ChartAccountRef[]),
      { code: '2900-bbbbbbbb', name: 'Due to Northwind Fund II', type: 'liability', subtype: 'intercompany_payable' },
    ]
    expect(categorizeBankRow(row(5000, 'Transfer from Northwind Fund II'), { ...ctx, chart }).accountCode).toBe('2900-bbbbbbbb')
  })

  it('flags a bare transfer for review rather than calling it income', () => {
    const c = categorizeBankRow(row(5000, 'ONLINE TRANSFER FROM CHK 1234'), ctx)
    expect(c.accountCode).toBe('2900')
    expect(c.confidence).toBe('low')
  })

  it('does not read a wire to a vendor as an internal transfer', () => {
    const c = categorizeBankRow(row(-5000, 'WIRE TRANSFER TO ACME CONSULTING'), ctx)
    expect(c.accountCode).toBe('5210')
  })

  it('never reads a row as a transfer to the vehicle itself', () => {
    expect(affiliateNamed('Transfer from Northwind Fund II', affiliates, 'bbbbbbbb-2')).toBeNull()
  })

  it('leaves a fund chart without intercompany accounts to the ordinary rules', () => {
    const c = categorizeBankRow(row(5000, 'Transfer from Northwind Fund II'), { ...ctx, chart: DEFAULT_CHART as ChartAccountRef[] })
    expect(c.accountCode).not.toBe('1000')
  })
})

describe('payeeKey', () => {
  it('reduces the same payee to the same key across payment rails', () => {
    expect(payeeKey({ description: 'POS DEBIT 0412 SLACK T12345 SAN FRANCISCO' })).toBe('slack san')
    expect(payeeKey({ description: 'ACH PMT 99812 Acme Insurance Co' })).toBe('acme insurance')
    expect(payeeKey({ description: 'WIRE TRANSFER TO ACME INSURANCE' })).toBe('acme insurance')
  })

  it('prefers the counterparty column when the feed has one', () => {
    expect(payeeKey({ description: 'ACH DEBIT 1234', counterparty: 'Acme Insurance' })).toBe('acme insurance')
  })

  it('is null when nothing distinctive is left', () => {
    expect(payeeKey({ description: 'ACH DEBIT 1234 0412' })).toBeNull()
  })
})

describe('learning from history', () => {
  const chart = MANAGEMENT_COMPANY_CHART as ChartAccountRef[]
  const h = (accountCode: string, chosen = false, inflow = false, payee = 'acme insurance'): HistoryEntry => ({ payee, inflow, accountCode, chosen })

  it('follows two consistent bookings over the keyword rules', () => {
    // The rule would say Insurance (5600); this entity has twice booked Acme to Office and general.
    const c = categorizeBankRow(row(-300, 'ACH PMT Acme Insurance'), { chart, history: [h('5700'), h('5700')] })
    expect(c.accountCode).toBe('5700')
    expect(c.by).toBe('history')
    expect(c.confidence).toBe('high')
  })

  it('follows a single choice a person made by hand', () => {
    expect(learnedAccount(row(-300, 'Acme Insurance'), [h('5700', true)], chart)?.account.code).toBe('5700')
    // But one unreviewed booking is not a pattern.
    expect(learnedAccount(row(-300, 'Acme Insurance'), [h('5700')], chart)).toBeNull()
  })

  it('stays out of it when the payee has been booked several ways', () => {
    expect(learnedAccount(row(-300, 'Acme Insurance'), [h('5700'), h('5600'), h('5700')], chart)).toBeNull()
  })

  it('keeps money in and money out apart', () => {
    expect(learnedAccount(row(300, 'Acme Insurance'), [h('5700'), h('5700')], chart)).toBeNull()
  })

  it('ignores accounts the chart no longer has', () => {
    expect(learnedAccount(row(-300, 'Acme Insurance'), [h('9999'), h('9999')], chart)).toBeNull()
  })
})

describe('historyFromRows', () => {
  const accountOfEntry = new Map([['e1', '5300'], ['e2', '5300'], ['e3', '5600'], ['e4', '5300']])
  it('counts posted rows and hand-picked drafts, nothing else', () => {
    const out = historyFromRows([
      { amount: -10, description: 'SLACK', counterparty: null, status: 'reconciled', journal_entry_id: 'e1', raw: {} },
      { amount: -10, description: 'SLACK', counterparty: null, status: 'drafted', journal_entry_id: 'e2', raw: { categorization: { by: 'user' } } },
      // A draft nobody has looked at is only the categorizer's own guess.
      { amount: -10, description: 'SLACK', counterparty: null, status: 'drafted', journal_entry_id: 'e3', raw: { categorization: { by: 'rule' } } },
      // Linked to an investment: its entry was not booked from the bank line.
      { amount: -10, description: 'SLACK', counterparty: null, status: 'reconciled', journal_entry_id: 'e4', raw: { investmentReview: true } },
    ], accountOfEntry)
    expect(out).toEqual([
      { payee: 'slack', inflow: false, accountCode: '5300', chosen: false },
      { payee: 'slack', inflow: false, accountCode: '5300', chosen: true },
    ])
  })
})
