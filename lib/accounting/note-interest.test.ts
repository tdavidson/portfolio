import { describe, it, expect } from 'vitest'
import { accruedInterest, noteAccruals, notesFromRows, NOTE_COLUMNS, type Note } from './note-interest'

const note = (over: Partial<Note> = {}): Note => ({
  txnId: 't1',
  companyId: 'c1',
  companyName: 'Acme',
  principal: 1_000_000,
  rate: 0.08,
  startDate: '2025-01-01',
  maturityDate: null,
  convertedDate: null,
  ...over,
})

describe('accruedInterest', () => {
  it('accrues simple interest, actual/365', () => {
    // Exactly one year at 8% on 1m: issued 1 Jan, accrued at the end of 31 Dec is 365 days.
    expect(accruedInterest(note(), '2025-12-31')).toBe(80_000)
  })

  it('accrues pro-rata for a part year', () => {
    // ~half a year.
    const half = accruedInterest(note(), '2025-07-02')
    expect(half).toBeGreaterThan(39_000)
    expect(half).toBeLessThan(41_000)
  })

  it('does not compound — simple is what most notes actually say', () => {
    const twoYears = accruedInterest(note(), '2026-12-31')
    // 2 x 80k, not 80k + 6.4k of interest-on-interest.
    expect(twoYears).toBeCloseTo(160_000, -1)
  })

  it('STOPS at maturity — an unconverted note past maturity earns nothing more', () => {
    const atMaturity = accruedInterest(note({ maturityDate: '2026-01-01' }), '2026-01-01')
    const wellPast = accruedInterest(note({ maturityDate: '2026-01-01' }), '2028-01-01')
    // Past maturity a note gets renegotiated; accruing on regardless books income nobody is owed.
    expect(wellPast).toBe(atMaturity)
  })

  it('STOPS at conversion', () => {
    const converted = accruedInterest(
      note({ convertedDate: '2025-07-01' }),
      '2026-01-01'
    )
    const atConversion = accruedInterest(note({ convertedDate: '2025-07-01' }), '2025-07-01')
    expect(converted).toBe(atConversion)
    expect(converted).toBeLessThan(45_000) // roughly half a year, not a full one
  })

  it('stops at whichever comes FIRST — conversion or maturity', () => {
    const n = note({ maturityDate: '2026-06-01', convertedDate: '2025-06-01' })
    const early = accruedInterest(n, '2027-01-01')
    const atConv = accruedInterest(note({ convertedDate: '2025-06-01' }), '2025-06-01')
    expect(early).toBe(atConv) // conversion came first
  })

  it('counts the issue day and the as-of day', () => {
    // Issued the 14th, accrued at the 31st: 18 days.
    expect(accruedInterest(note({ principal: 365_000, rate: 0.1, startDate: '2025-03-14' }), '2025-03-31')).toBe(1_800)
    // Accrued on the issue day itself: one day.
    expect(accruedInterest(note({ principal: 365_000, rate: 0.1, startDate: '2025-03-14' }), '2025-03-14')).toBe(100)
  })

  it('gives the same total the day before conversion and at conversion', () => {
    const n = note({ convertedDate: '2025-07-01' })
    expect(accruedInterest(n, '2025-06-30')).toBe(accruedInterest(n, '2025-07-01'))
    expect(accruedInterest(n, '2025-06-30')).toBe(accruedInterest(n, '2025-09-30'))
  })

  it('accrues nothing before the note was issued', () => {
    expect(accruedInterest(note({ startDate: '2026-06-01' }), '2026-01-01')).toBe(0)
  })

  it('accrues nothing with no rate — equity and SAFEs bear no interest', () => {
    expect(accruedInterest(note({ rate: 0 }), '2026-01-01')).toBe(0)
  })
})

describe('noteAccruals', () => {
  it('posts only the DELTA against what the ledger already carries', () => {
    // 80k earned to date; 60k already accrued in previous closes.
    const out = noteAccruals([note()], new Map([['c1', 60_000]]), '2025-12-31')
    expect(out).toHaveLength(1)
    expect(out[0].target).toBeCloseTo(80_000, 0)
    expect(out[0].delta).toBeCloseTo(20_000, 0)
  })

  it('posts nothing when the accrual is already correct', () => {
    const target = accruedInterest(note(), '2025-12-31')
    expect(noteAccruals([note()], new Map([['c1', target]]), '2025-12-31')).toEqual([])
  })

  it('SELF-CORRECTS when a rate was entered wrong', () => {
    // Someone booked 8% but the note is really 5%, and 80k was over-accrued. The target is
    // recomputed from scratch, so the next close pulls the balance back down rather than
    // compounding the error.
    const out = noteAccruals([note({ rate: 0.05 })], new Map([['c1', 80_000]]), '2025-12-31')
    expect(out[0].target).toBeCloseTo(50_000, 0)
    expect(out[0].delta).toBeLessThan(0) // a correction downwards
    expect(out[0].delta).toBeCloseTo(-30_000, 0)
  })

  it('sums several notes into ONE accrual per company', () => {
    // Two notes into the same company accrue into that company's single 1150 account, so the
    // interest converts into that company's basis as one amount.
    const out = noteAccruals(
      [
        note({ txnId: 'a', principal: 1_000_000, rate: 0.08 }),
        note({ txnId: 'b', principal: 500_000, rate: 0.10 }),
      ],
      new Map(),
      '2025-12-31'
    )
    expect(out).toHaveLength(1)
    expect(out[0].companyId).toBe('c1')
    expect(out[0].target).toBeCloseTo(80_000 + 50_000, -1)
  })

  it('keeps companies separate', () => {
    const out = noteAccruals(
      [note({ companyId: 'c1' }), note({ companyId: 'c2', companyName: 'Beta' })],
      new Map(),
      '2025-12-31'
    )
    expect(out).toHaveLength(2)
    expect(out.map(o => o.companyId).sort()).toEqual(['c1', 'c2'])
  })

  it('stops accruing a converted note without unwinding what it already earned', () => {
    // The note converted in July. Interest stops there — but the 40k it earned stays on the
    // books until conversion moves it into the equity's cost basis.
    const out = noteAccruals(
      [note({ convertedDate: '2025-07-01' })],
      new Map([['c1', accruedInterest(note({ convertedDate: '2025-07-01' }), '2025-07-01')]]),
      '2025-12-31'
    )
    expect(out).toEqual([]) // nothing further to post
  })
})

describe('noteAccruals after a conversion', () => {
  // 100k at 10%, issued 1 Jan 2025, converted 1 Jul 2025: 181 days earned = 4,958.90.
  const n = (convertedInterest: number) =>
    note({ principal: 100_000, rate: 0.1, startDate: '2025-01-01', convertedDate: '2025-07-01', convertedInterest })

  it('posts nothing more when the conversion carried exactly what was accrued', () => {
    // The conversion entry moved the 4,958.90 out of 1150, leaving it at zero.
    expect(noteAccruals([n(4_958.9)], new Map([['c1', 0]]), '2025-12-31')).toEqual([])
  })

  it('trues income up to the interest the conversion actually recorded', () => {
    // The company converted 5,200 of interest. 1150 held 4,958.90 and the conversion took 5,200
    // out, so it sits at -241.10. The close books the 241.10 difference as income.
    const out = noteAccruals([n(5_200)], new Map([['c1', -241.1]]), '2025-12-31')
    expect(out).toHaveLength(1)
    expect(out[0].delta).toBe(241.1)
    expect(out[0].target).toBe(5_200)
  })

  it('does not book the converted interest a second time', () => {
    // Before the fix the empty 1150 read as nothing accrued, and the close posted it all again.
    const out = noteAccruals([n(4_958.9)], new Map([['c1', 0]]), '2026-06-30')
    expect(out).toEqual([])
  })
})

describe('NOTE_COLUMNS', () => {
  it('names the company_id foreign key, since transfer_company_id also points at companies', () => {
    expect(NOTE_COLUMNS).toContain('companies!investment_transactions_company_id_fkey')
    expect(NOTE_COLUMNS).not.toMatch(/(^|[ ,])companies!inner\(/)
  })
})

describe('notesFromRows', () => {
  // Two notes in one company: the first converts, the second is issued after the conversion.
  const rows = [
    { id: 'n1', company_id: 'c1', transaction_type: 'investment', transaction_date: '2024-01-01', investment_cost: 100_000, interest_rate: 0.1, companies: { name: 'Acme' } },
    { id: 'conv', company_id: 'c1', transaction_type: 'investment', transaction_date: '2024-07-01', investment_cost: 0, interest_converted: 4_958.9, converts_from_txn_id: 'n1' },
    { id: 'n2', company_id: 'c1', transaction_type: 'investment', transaction_date: '2025-01-01', investment_cost: 50_000, interest_rate: 0.06, companies: { name: 'Acme' } },
  ]

  it('stops only the note the conversion names', () => {
    const notes = notesFromRows(rows)
    expect(notes.find(n => n.txnId === 'n1')?.convertedDate).toBe('2024-07-01')
    expect(notes.find(n => n.txnId === 'n2')?.convertedDate).toBeNull()
  })

  it('accrues a note issued after an earlier note of the same company converted', () => {
    // n2: 50k at 6% for 365 days = 3,000. n1's converted interest already left 1150.
    const out = noteAccruals(notesFromRows(rows), new Map([['c1', 0]]), '2025-12-31')
    expect(out).toHaveLength(1)
    expect(out[0].delta).toBe(3_000)
    expect(out[0].target).toBe(4_958.9 + 3_000)
  })

  it('reads an unlinked conversion against the company, but only for notes issued before it', () => {
    const unlinked = rows.map(r => (r.id === 'conv' ? { ...r, converts_from_txn_id: null } : r))
    const notes = notesFromRows(unlinked)
    expect(notes.find(n => n.txnId === 'n1')?.convertedDate).toBe('2024-07-01')
    expect(notes.find(n => n.txnId === 'n2')?.convertedDate).toBeNull()
  })

  it('counts an unlinked conversion once for a company with two converted notes', () => {
    const both = [
      { id: 'a', company_id: 'c1', transaction_type: 'investment', transaction_date: '2024-01-01', investment_cost: 100_000, interest_rate: 0.1 },
      { id: 'b', company_id: 'c1', transaction_type: 'investment', transaction_date: '2024-02-01', investment_cost: 100_000, interest_rate: 0.1 },
      { id: 'conv', company_id: 'c1', transaction_type: 'investment', transaction_date: '2024-07-01', investment_cost: 0, interest_converted: 9_000 },
    ]
    const out = noteAccruals(notesFromRows(both), new Map([['c1', 0]]), '2024-12-31')
    expect(out).toEqual([])
  })
})

describe('notesFromRows after an exit', () => {
  const issued = { id: 'n1', company_id: 'c1', transaction_type: 'investment', transaction_date: '2024-01-01', round_name: 'Convertible Note', investment_cost: 100_000, interest_rate: 0.1 }

  it('reverses all interest on a note written off in full', () => {
    const rows = [issued, { id: 'w', company_id: 'c1', transaction_type: 'proceeds', transaction_date: '2024-12-31', round_name: 'Convertible Note', proceeds_received: 0, cost_basis_exited: 100_000 }]
    // 1150 holds a year of interest from earlier closes; it all comes back out.
    const out = noteAccruals(notesFromRows(rows), new Map([['c1', 9_000]]), '2025-06-30')
    expect(out).toHaveLength(1)
    expect(out[0].target).toBe(0)
    expect(out[0].delta).toBe(-9_000)
  })

  it('keeps interest on the part of a note still held after a partial exit', () => {
    const rows = [issued, { id: 'p', company_id: 'c1', transaction_type: 'proceeds', transaction_date: '2024-06-30', round_name: 'convertible note ', proceeds_received: 60_000, cost_basis_exited: 50_000 }]
    const full = accruedInterest(notesFromRows([issued])[0], '2024-12-31')
    const out = noteAccruals(notesFromRows(rows), new Map([['c1', 0]]), '2024-12-31')
    expect(out[0].target).toBe(Math.round(full * 50) / 100)
  })

  it('ignores exits of another round', () => {
    const rows = [issued, { id: 'x', company_id: 'c1', transaction_type: 'proceeds', transaction_date: '2024-06-30', round_name: 'Series A', proceeds_received: 0, cost_basis_exited: 100_000 }]
    expect(notesFromRows(rows)[0].exitedPrincipal).toBe(0)
  })

  it('lets a conversion of the rest decide the interest after a partial exit', () => {
    const rows = [
      issued,
      { id: 'p', company_id: 'c1', transaction_type: 'proceeds', transaction_date: '2024-06-30', round_name: 'Convertible Note', proceeds_received: 60_000, cost_basis_exited: 50_000 },
      { id: 'c', company_id: 'c1', transaction_type: 'investment', transaction_date: '2024-06-30', investment_cost: 0, interest_converted: 2_500, converts_from_txn_id: 'n1' },
    ]
    // The conversion moved its 2,500 out of 1150; nothing further is owed.
    expect(noteAccruals(notesFromRows(rows), new Map([['c1', 0]]), '2024-12-31')).toEqual([])
  })
})
