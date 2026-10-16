import { describe, it, expect } from 'vitest'
import { resolveDistributionSplit } from './bank-match'
import {
  splitRecords,
  parseTransactionsCsv,
  normalizeDate,
  dedupHash,
  suggestCategory,
  bankEntryPostings,
  counterPosting,
  summarizeBankRec,
  cashTransferEntryIds,
  openingCashBefore,
} from './bank'
import { isBalanced } from './ledger'

describe('normalizeDate', () => {
  it('accepts ISO and M/D/Y', () => {
    expect(normalizeDate('2026-06-30')).toBe('2026-06-30')
    expect(normalizeDate('6/30/2026')).toBe('2026-06-30')
    expect(normalizeDate('06/05/26')).toBe('2026-06-05')
    expect(normalizeDate('nope')).toBeNull()
  })
})

describe('splitRecords', () => {
  it('preserves leading empty columns in a TAB-delimited record', () => {
    // Leading tabs are WHITESPACE. Trimming a record destroys its empty leading columns and
    // shifts every field left — the failure that made a QuickBooks continuation line put the
    // account where the memo belongs. Commas survive trimming, which is why CSV never showed it.
    const [row] = splitRecords('\t\t\tThird\tFourth')
    expect(row).toBe('\t\t\tThird\tFourth')
  })

  it('preserves leading empty columns in a comma-delimited record', () => {
    const [row] = splitRecords(',,,Third,Fourth')
    expect(row).toBe(',,,Third,Fourth')
  })

  it('still drops blank and whitespace-only lines', () => {
    expect(splitRecords('a,b\n\n   \nc,d')).toEqual(['a,b', 'c,d'])
  })

  it('still honors newlines inside quoted fields', () => {
    expect(splitRecords('a,"multi\nline",c')).toEqual(['a,"multi\nline",c'])
  })

  it('strips carriage returns from CRLF input', () => {
    expect(splitRecords('a,b\r\nc,d')).toEqual(['a,b', 'c,d'])
  })
})

describe('parseTransactionsCsv', () => {
  it('parses a signed-amount CSV', () => {
    const csv = 'Date,Description,Amount\n2026-06-01,Capital call Fund II,5000000\n2026-06-15,Audit fee,-12000'
    const { rows, errors } = parseTransactionsCsv(csv)
    expect(errors).toEqual([])
    expect(rows).toHaveLength(2)
    expect(rows[0]).toMatchObject({ date: '2026-06-01', amount: 5000000, description: 'Capital call Fund II' })
    expect(rows[1].amount).toBe(-12000)
  })

  it('parses debit/credit columns and TSV', () => {
    const tsv = 'Date\tDescription\tDebit\tCredit\n06/15/2026\tWire in\t\t5000000\n06/20/2026\tLegal\t3000\t'
    const { rows } = parseTransactionsCsv(tsv)
    expect(rows[0].amount).toBe(5000000)
    expect(rows[1].amount).toBe(-3000)
  })

  it('handles quoted fields and accounting-negative parens', () => {
    const csv = 'Date,Description,Amount\n2026-06-01,"Fee, quarterly","(1,200.50)"'
    const { rows } = parseTransactionsCsv(csv)
    expect(rows[0].description).toBe('Fee, quarterly')
    expect(rows[0].amount).toBe(-1200.5)
  })

  it('reports bad rows instead of dropping silently', () => {
    const csv = 'Date,Description,Amount\nbadrow,x,y\n2026-06-01,ok,100'
    const { rows, errors } = parseTransactionsCsv(csv)
    expect(rows).toHaveLength(1)
    expect(errors.length).toBe(1)
  })

  it('errors when required columns are missing', () => {
    const { errors } = parseTransactionsCsv('Foo,Bar\n1,2')
    expect(errors.length).toBe(1)
  })

  it('matches header variants and skips metadata rows above the header', () => {
    const csv = 'Acme Bank Statement\nAccount ****1234\n\nPosting Date,Description,Transaction Amount\n07/01/2026,Wire in,5000000'
    const { rows, errors } = parseTransactionsCsv(csv)
    expect(errors).toEqual([])
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ date: '2026-07-01', amount: 5000000 })
  })

  it('handles a newline embedded in a quoted field (brokerage export)', () => {
    const csv = 'Date,Description,Amount($),Running Balance\n06/30/2026,"ACME BANK N.A.\n(Period 06/01-06/30)",0.42,"58,210.42"'
    const { rows, errors } = parseTransactionsCsv(csv)
    expect(errors).toEqual([])
    expect(rows).toHaveLength(1)
    expect(rows[0].amount).toBe(0.42)
    expect(rows[0].description).toBe('ACME BANK N.A. (Period 06/01-06/30)')
  })
})

describe('parseTransactionsCsv — one cell per line (copied from a bank web page)', () => {
  const MS = ['Date', 'Activity Type', 'Description', 'Amount', '09/30/26', 'Interest Income', 'ACME BANK N.A.', '(Period 09/01-09/30)', '0.37'].join('\n')

  it('reads the stacked header and a description that wraps over two lines', () => {
    const r = parseTransactionsCsv(MS)
    expect(r.errors).toEqual([])
    expect(r.rows).toEqual([{ date: '2026-09-30', amount: 0.37, description: 'ACME BANK N.A. (Period 09/01-09/30)', counterparty: undefined, activity: 'Interest Income' }])
  })

  it('splits several transactions at each date line, with accounting negatives', () => {
    const r = parseTransactionsCsv([MS, '09/15/26', 'Wire Out', 'AUDIT LLC', '(12,000.00)', '09/02/26', 'Deposit', 'CAPITAL CALL', 'FUND II', 'Q3', '50,000'].join('\n'))
    expect(r.rows.map(x => [x.date, x.amount, x.description])).toEqual([
      ['2026-09-30', 0.37, 'ACME BANK N.A. (Period 09/01-09/30)'],
      ['2026-09-15', -12000, 'AUDIT LLC'],
      ['2026-09-02', 50000, 'CAPITAL CALL FUND II Q3'],
    ])
  })

  it('skips a title above the header and blank lines in between', () => {
    const r = parseTransactionsCsv('Account activity\n\nDate\nDescription\nAmount\n\n10/01/26\nFEE\n-5')
    expect(r.rows).toEqual([expect.objectContaining({ date: '2026-10-01', amount: -5, description: 'FEE' })])
  })

  it('refuses a record too short to place its columns, rather than guessing', () => {
    const r = parseTransactionsCsv('Date\nDescription\nDebit\nCredit\n10/01/26\nFEE\n5')
    expect(r.rows).toEqual([])
    expect(r.errors[0]).toMatch(/expected at least 4 values/)
  })

  it('reads a brokerage activity table, skipping Quantity, Price and Balance', () => {
    const ms = 'Date\nActivity Type\nDescription\nQuantity\nPrice\nAmount($)\nBalance($)\n\n09/30/26\nInterest Income\nACME BANK N.A.\n(Period 09/01-09/30)\n-\n-\n0.37\n32,500.37'
    const r = parseTransactionsCsv(ms)
    expect(r.errors).toEqual([])
    expect(r.rows).toEqual([{ date: '2026-09-30', amount: 0.37, description: 'ACME BANK N.A. (Period 09/01-09/30)', counterparty: undefined, activity: 'Interest Income' }])
    // Two rows, one with a one-line description and a negative amount.
    const two = parseTransactionsCsv(`${ms}\n09/15/26\nFunds Paid\nWIRE TO AUDIT LLC\n-\n-\n(12,000.00)\n20,500.37`)
    expect(two.rows.map(x => [x.date, x.amount, x.description])).toEqual([
      ['2026-09-30', 0.37, 'ACME BANK N.A. (Period 09/01-09/30)'],
      ['2026-09-15', -12000, 'WIRE TO AUDIT LLC'],
    ])
  })

  it('ignores the zero-width characters bank websites wrap cells in', () => {
    const r = parseTransactionsCsv(MS.split('\n').map(x => `\u200b${x}\u200b`).join('\n'))
    expect(r.rows).toHaveLength(1)
    expect(r.rows[0]).toMatchObject({ date: '2026-09-30', amount: 0.37 })
  })

  it('reads a web table whose cells are tab-separated except where a cell wraps a line', () => {
    const tsv = 'Date\tActivity Type\tDescription\tAmount\n09/30/26\tInterest Income\tACME BANK N.A.\n(Period 09/01-09/30)\t0.37'
    expect(parseTransactionsCsv(tsv).rows).toEqual([expect.objectContaining({ amount: 0.37, description: 'ACME BANK N.A. (Period 09/01-09/30)' })])
    const headerOnly = 'Date\tActivity Type\tDescription\tAmount\n09/30/26\nInterest Income\nACME BANK N.A.\n(Period 09/01-09/30)\n0.37'
    expect(parseTransactionsCsv(headerOnly).rows).toHaveLength(1)
  })

  it('leaves an ordinary TSV alone', () => {
    const r = parseTransactionsCsv('Date\tDescription\tAmount\n2026-01-01\tA, B and C\t-5\n2026-01-02\tD\t7')
    expect(r.rows.map(x => [x.description, x.amount])).toEqual([['A, B and C', -5], ['D', 7]])
  })

  it('still reports a paste with no recognisable header', () => {
    expect(parseTransactionsCsv('hello\nworld').errors[0]).toMatch(/Could not find a date column/)
  })
})

describe('dedupHash', () => {
  it('is stable and sensitive to the key fields', () => {
    const a = { date: '2026-06-01', amount: 100, description: 'Fee' }
    expect(dedupHash(a)).toBe(dedupHash({ ...a }))
    expect(dedupHash(a)).not.toBe(dedupHash({ ...a, amount: 101 }))
  })
})

describe('suggestCategory', () => {
  it('classifies by keyword', () => {
    expect(suggestCategory({ date: 'd', amount: 5e6, description: 'Capital call' }).sourceType).toBe('capital_call')
    expect(suggestCategory({ date: 'd', amount: -12000, description: 'Annual audit' }).sourceType).toBe('partnership_expense')
    expect(suggestCategory({ date: 'd', amount: -50000, description: 'Management fee Q2' }).sourceType).toBe('management_fee')
  })

  it('reads the activity/type column when the description lacks a keyword', () => {
    // Brokerage feed: keyword is in Activity, description is just the bank name.
    const cat = suggestCategory({ date: 'd', amount: 0.5, description: 'ACME BANK N.A.', activity: 'Interest Income' })
    expect(cat.sourceType).toBe('income')
    expect(cat.accountCode).toBe('4100')
    expect(cat.confidence).toBe('high')
  })

  it('treats interest as income on inflow and expense on outflow', () => {
    expect(suggestCategory({ date: 'd', amount: 0.5, description: 'x', activity: 'Interest Income' }).accountCode).toBe('4100')
    const exp = suggestCategory({ date: 'd', amount: -420, description: 'Margin interest charged' })
    expect(exp.accountCode).toBe('5300')
    expect(exp.label).toBe('Interest expense')
  })

  it('falls back by direction with low confidence', () => {
    expect(suggestCategory({ date: 'd', amount: 999, description: 'mystery' }).confidence).toBe('low')
    expect(suggestCategory({ date: 'd', amount: -999, description: 'mystery' }).sourceType).toBe('partnership_expense')
  })
})

describe('bankEntryPostings', () => {
  it('builds a balanced two-line entry for inflow and outflow', () => {
    const inflow = bankEntryPostings(5000, 'cash', 'lp')
    expect(isBalanced({ fundId: 'f', entryDate: 'd', postings: inflow })).toBe(true)
    expect(inflow.find(p => p.accountId === 'cash')!.amount).toBe(5000)

    const outflow = bankEntryPostings(-3000, 'cash', 'exp')
    expect(isBalanced({ fundId: 'f', entryDate: 'd', postings: outflow })).toBe(true)
    expect(outflow.find(p => p.accountId === 'cash')!.amount).toBe(-3000)
  })
})

describe('counterPosting', () => {
  it('returns the one non-cash line of a simple draft', () => {
    const ps = [{ id: 'a', account_id: 'cash', amount: 50 }, { id: 'b', account_id: 'income', amount: -50 }]
    expect(counterPosting(ps, 'cash', 50)?.id).toBe('b')
  })

  it('finds the counter-leg when the import fell back to cash for both lines', () => {
    // An inflow whose suggested account was not on the chart: cash +18.40 / cash -18.40.
    const inflow = [{ id: 'a', account_id: 'cash', amount: 18.40 }, { id: 'b', account_id: 'cash', amount: -18.40 }]
    expect(counterPosting(inflow, 'cash', 18.40)?.id).toBe('b')
    const outflow = [{ id: 'a', account_id: 'cash', amount: '-1250' }, { id: 'b', account_id: 'cash', amount: '1250' }]
    expect(counterPosting(outflow, 'cash', -1250)?.id).toBe('b')
  })

  it('refuses an allocated entry', () => {
    const ps = [
      { id: 'a', account_id: 'cash', amount: 100 },
      { id: 'b', account_id: 'lp1', amount: -60 },
      { id: 'c', account_id: 'lp2', amount: -40 },
    ]
    expect(counterPosting(ps, 'cash', 100)).toBeNull()
  })
})

describe('summarizeBankRec', () => {
  it('ties out when ledger cash equals the bank feed and all matched', () => {
    const s = summarizeBankRec([{ amount: 5000, matched: true }, { amount: -2000, matched: true }], 3000)
    expect(s.bankEndingBalance).toBe(3000)
    expect(s.difference).toBe(0)
    expect(s.tiesOut).toBe(true)
  })

  it('surfaces unmatched transactions and the difference', () => {
    const s = summarizeBankRec([{ amount: 5000, matched: true }, { amount: -2000, matched: false }], 5000)
    expect(s.unmatchedCount).toBe(1)
    expect(s.unmatchedTotal).toBe(-2000)
    expect(s.bankEndingBalance).toBe(3000)
    expect(s.difference).toBe(2000) // ledger cash still shows the unbooked outflow
    expect(s.tiesOut).toBe(false)
  })

  it('opens the feed at ledger cash before its first transaction', () => {
    // Books from 2021, bank feed from September: the earlier cash is the feed's opening balance.
    const postings = [
      { accountId: 'cash', amount: 200_000, currency: 'USD', entryDate: '2021-03-01' },
      { accountId: 'cash', amount: -38_400.50, currency: 'USD', entryDate: '2026-08-31' },
      { accountId: 'cash', amount: 120_000, currency: 'USD', entryDate: '2026-09-02' },
      { accountId: 'other', amount: 5, currency: 'USD', entryDate: '2020-01-01' },
    ]
    const opening = openingCashBefore(postings, 'cash', ['2026-09-30', '2026-09-02'])
    expect(opening).toBe(161_599.50)
    const s = summarizeBankRec([{ amount: 120_000, matched: true }], 281_599.50, opening)
    expect(s.bankEndingBalance).toBe(281_599.50)
    expect(s.tiesOut).toBe(true)
  })

  it('leaves a transfer in from the old bank out of the bank side', () => {
    // The old bank held 31,250.40 on 1000 before the feed; the feed opens with that money arriving, posted 1000 to 1000.
    const transfers = cashTransferEntryIds([
      { entryId: 'move', accountId: 'cash', amount: 31_250.40 },
      { entryId: 'move', accountId: 'cash', amount: -31_250.40 },
      { entryId: 'fee', accountId: 'cash', amount: -500 },
      { entryId: 'fee', accountId: 'expense', amount: 500 },
    ], 'cash')
    expect([...transfers]).toEqual(['move'])
    const s = summarizeBankRec([
      { amount: 31_250.40, matched: true, cashTransfer: transfers.has('move') },
      { amount: -500, matched: true, cashTransfer: transfers.has('fee') },
    ], 30_750.40, 31_250.40)
    expect(s.bankEndingBalance).toBe(30_750.40)
    expect(s.transferCount).toBe(1)
    expect(s.transferTotal).toBe(31_250.40)
    expect(s.tiesOut).toBe(true)
  })

  it('counts an unmatched row in full even if flagged as a transfer', () => {
    const s = summarizeBankRec([{ amount: 100, matched: false, cashTransfer: true }], 0)
    expect(s.bankEndingBalance).toBe(100)
    expect(s.transferCount).toBe(0)
  })

  it('opens at zero with no feed or no cash account', () => {
    expect(openingCashBefore([{ accountId: 'cash', amount: 1, currency: 'USD', entryDate: '2020-01-01' }], 'cash', [])).toBe(0)
    expect(openingCashBefore([], undefined, ['2026-01-01'])).toBe(0)
  })
})

describe('resolveDistributionSplit', () => {
  it('gives the whole amount to a named partner', () => {
    const r = resolveDistributionSplit(10_000, { lpEntityId: 'b' })
    expect('perLp' in r && Array.from(r.perLp.entries())).toEqual([['b', 10_000]])
  })

  it('uses explicit per-LP amounts as given', () => {
    const perLpOverride = new Map([['a', 6_000], ['b', 4_000]])
    const r = resolveDistributionSplit(10_000, { perLpOverride })
    expect('perLp' in r && Object.fromEntries(r.perLp)).toEqual({ a: 6_000, b: 4_000 })
  })

  it('rejects explicit amounts that do not total the transaction', () => {
    const perLpOverride = new Map([['a', 6_000], ['b', 1_000]])
    const r = resolveDistributionSplit(10_000, { perLpOverride })
    expect('error' in r && r.error).toContain('total 7000')
  })

  it('REFUSES an unnamed payment rather than splitting it pro-rata', () => {
    // The bug this guards: a $500 wire to ONE partner was split across all twenty by capital
    // balance, so the recipient was debited $12.50 of their own money. A wire is one payment;
    // pro-rata belongs to DECLARING a distribution, before any money moves.
    const r = resolveDistributionSplit(500, {})
    expect('error' in r).toBe(true)
    expect('error' in r && r.error).toContain('Name the partner')
    expect('error' in r && r.error).toContain('declare it')
  })

  it('refuses an empty override too — an empty map is not an instruction', () => {
    const r = resolveDistributionSplit(500, { perLpOverride: new Map() })
    expect('error' in r).toBe(true)
  })
})
