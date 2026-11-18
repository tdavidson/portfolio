import { describe, it, expect } from 'vitest'
import { accruedInterest, noteAccruals, NOTE_COLUMNS, type Note } from './note-interest'

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

describe('NOTE_COLUMNS', () => {
  it('names the company_id foreign key, since transfer_company_id also points at companies', () => {
    expect(NOTE_COLUMNS).toContain('companies!investment_transactions_company_id_fkey')
    expect(NOTE_COLUMNS).not.toMatch(/(^|[ ,])companies!inner\(/)
  })
})
