import { describe, expect, it } from 'vitest'
import { scheduledMonth } from './close-suggestions'

describe('scheduledMonth', () => {
  it('preserves the requested monthly recognition day', () => {
    expect(scheduledMonth('2026-03-05', 1, 5)).toBe('2026-04-05')
  })

  it('uses month end when the requested day does not exist', () => {
    expect(scheduledMonth('2026-01-31', 1, 31)).toBe('2026-02-28')
    expect(scheduledMonth('2028-01-31', 1, 31)).toBe('2028-02-29')
  })

  it('can move backward for recurring-pattern lookback', () => {
    expect(scheduledMonth('2026-09-30', -6, 1)).toBe('2026-03-01')
  })
})

import { vi } from 'vitest'
vi.mock('./vehicle-id', () => ({ vehicleIdByName: async () => 'v1' }))
import { loadCloseEntrySuggestions } from './close-suggestions'

/** A query builder over fixed rows: applies status/date filters the suggester uses. */
function fakeAdmin(entries: any[]) {
  return {
    from(table: string) {
      const f: { status?: string; notStatus?: string; gte?: string; lte?: string; lt?: string } = {}
      const q: any = {
        select: () => q, order: () => q, not: () => q,
        eq: (col: string, v: any) => { if (col === 'status') f.status = v; return q },
        neq: (col: string, v: any) => { if (col === 'status') f.notStatus = v; return q },
        gte: (_c: string, v: string) => { f.gte = v; return q },
        lte: (_c: string, v: string) => { f.lte = v; return q },
        lt: (_c: string, v: string) => { f.lt = v; return q },
        then: (res: any) => {
          const data = table === 'journal_entries'
            ? entries.filter(e => (!f.status || e.status === f.status) && (!f.notStatus || e.status !== f.notStatus)
                && (!f.gte || e.entry_date >= f.gte) && (!f.lte || e.entry_date <= f.lte) && (!f.lt || e.entry_date < f.lt))
            : []
          return Promise.resolve({ data, error: null }).then(res)
        },
      }
      return q
    },
  } as any
}

const interest = (id: string, date: string, amount: number, status = 'posted', source_ref: string | null = null) => ({
  id, entry_date: date, status, memo: `MORGAN STANLEY BANK N.A. (Period ${date.slice(5, 7)})`, source_type: 'income', source_ref,
  journal_postings: [{ account_id: 'cash', amount, currency: 'USD' }, { account_id: 'interest', amount: -amount, currency: 'USD' }],
})

describe('loadCloseEntrySuggestions — recurring patterns', () => {
  const july = interest('j', '2026-07-31', 0.51)
  const aug = interest('a', '2026-08-31', 0.51)

  it('suggests the next occurrence when nothing is there', async () => {
    const s = await loadCloseEntrySuggestions(fakeAdmin([july, aug]), 'f1', 'Bluefish SPV LP', '2026-09-01', '2026-09-30')
    expect(s).toHaveLength(1)
    expect(s[0].entryDate).toBe('2026-09-30')
  })

  it('does not suggest it when a bank-imported DRAFT at a different amount is already in the month', async () => {
    const sept = interest('s', '2026-09-30', 0.49, 'draft', null)
    const s = await loadCloseEntrySuggestions(fakeAdmin([july, aug, sept]), 'f1', 'Bluefish SPV LP', '2026-09-01', '2026-09-30')
    expect(s).toEqual([])
  })

  it('still suggests it when the only entry that month hits different accounts', async () => {
    const other = { ...interest('o', '2026-09-15', 100), journal_postings: [{ account_id: 'cash', amount: -100 }, { account_id: 'fees', amount: 100 }] }
    const s = await loadCloseEntrySuggestions(fakeAdmin([july, aug, other]), 'f1', 'Bluefish SPV LP', '2026-09-01', '2026-09-30')
    expect(s).toHaveLength(1)
  })
})

import { shiftMemoMonth } from './close-suggestions'

describe('shiftMemoMonth', () => {
  it('moves the period a copied memo names to the new month', () => {
    expect(shiftMemoMonth('Monthly amortization of 10-year prepaid management fee — 2026-08', '2026-08-31', '2026-09-30'))
      .toBe('Monthly amortization of 10-year prepaid management fee — 2026-09')
    expect(shiftMemoMonth('MORGAN STANLEY BANK N.A. (Period 08/01-08/31)', '2026-08-31', '2026-09-30'))
      .toBe('MORGAN STANLEY BANK N.A. (Period 09/01-09/30)')
    expect(shiftMemoMonth('Accrued as of 2026-08-31, August 2026', '2026-08-31', '2026-09-30')).toBe('Accrued as of 2026-09-30, September 2026')
    expect(shiftMemoMonth('Rent — 2026-12', '2026-12-31', '2027-01-31')).toBe('Rent — 2027-01')
    expect(shiftMemoMonth('Software subscription', '2026-08-31', '2026-09-30')).toBe('Software subscription')
  })
})
