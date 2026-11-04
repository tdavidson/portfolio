import { describe, expect, it } from 'vitest'
import { capitalActivity, type CapitalActivityInput } from './capital-activity'
import type { Account } from '@/lib/accounting/types'

const acct = (id: string, type: Account['type'], subtype: string | null, extra: Partial<Account> = {}): Account =>
  ({ id, fundId: 'f', code: id, name: id, type, subtype, ...extra })

const accounts: Account[] = [
  acct('cash', 'asset', 'cash'),
  acct('due', 'asset', 'receivable'),
  acct('accrued', 'liability', 'accrued'),
  acct('cap-a', 'equity', 'partner_capital', { lpEntityId: 'lp-a' }),
  acct('fee', 'expense', 'management_fee'),
  acct('org', 'expense', 'organizational_expense'),
  acct('legal', 'expense', 'legal'),
  acct('gain', 'income', 'realized_gain'),
]

const base = (over: Partial<CapitalActivityInput> = {}): CapitalActivityInput => ({
  months: [
    { month: '2025-11', status: 'actual' },
    { month: '2025-12', status: 'actual_unclosed' },
    { month: '2026-01', status: 'forecast' },
    { month: '2026-02', status: 'forecast' },
  ],
  accounts,
  capitalPostings: [],
  postings: [],
  investments: [],
  planEntries: [],
  ...over,
})

describe('capitalActivity', () => {
  it('counts a call from partners’ capital, however the cash arrived', () => {
    // Called through Due from LPs: capital is credited when the call is booked, the wire later
    // only clears the receivable — no cash leg ever touches capital.
    const r = capitalActivity(base({
      capitalPostings: [
        { lpEntityId: 'lp-a', amount: -100_000, sourceType: 'capital_call', entryDate: '2025-11-10' },
        { lpEntityId: 'lp-a', amount: -50_000, sourceType: 'contribution', entryDate: '2025-12-05' },
      ],
    }))
    expect(r.called).toEqual({ actual: 150_000, forecast: 0 })
  })

  it('counts a distribution and nets its reversal', () => {
    const r = capitalActivity(base({
      capitalPostings: [
        { lpEntityId: 'lp-a', amount: 20_000, sourceType: 'distribution', entryDate: '2025-11-20' },
        { lpEntityId: 'lp-a', amount: -5_000, sourceType: 'distribution', entryDate: '2025-12-20' },
        { lpEntityId: 'lp-a', amount: -1_000, sourceType: 'realized_gain', entryDate: '2025-12-20' },
      ],
    }))
    expect(r.distributed.actual).toBe(15_000)
    expect(r.called.actual).toBe(0)
  })

  it('reads fees and expenses on their expense accounts, accrued or paid', () => {
    const r = capitalActivity(base({
      postings: [
        // A fee accrued in November and paid in January: counted once, in November.
        { accountId: 'fee', amount: 25_000, currency: 'USD', entryDate: '2025-11-30' },
        { accountId: 'accrued', amount: -25_000, currency: 'USD', entryDate: '2025-11-30' },
        { accountId: 'org', amount: 4_000, currency: 'USD', entryDate: '2025-12-01' },
        { accountId: 'legal', amount: 3_000, currency: 'USD', entryDate: '2025-12-15' },
        { accountId: 'gain', amount: -9_000, currency: 'USD', entryDate: '2025-12-15' },
      ],
    }))
    expect(r.fees.actual).toBe(25_000)
    expect(r.org.actual).toBe(4_000)
    expect(r.partnership.actual).toBe(3_000)
  })

  it('takes invested capital from the investments’ cost', () => {
    const r = capitalActivity(base({
      investments: [
        { date: '2025-11-03', cost: 500_000 },
        { date: '2025-12-09', cost: 250_000 },
        { date: '2024-06-01', cost: 900_000 },
      ],
    }))
    expect(r.invested.actual).toBe(750_000)
  })

  it('splits by month: books in actual months, the plan in forecast months', () => {
    const r = capitalActivity(base({
      capitalPostings: [
        { lpEntityId: 'lp-a', amount: -100_000, sourceType: 'capital_call', entryDate: '2025-12-01' },
        // Booked in a month the plan owns: the plan's figure stands, this is not double counted.
        { lpEntityId: 'lp-a', amount: -70_000, sourceType: 'capital_call', entryDate: '2026-01-15' },
      ],
      planEntries: [
        { date: '2025-12-01', kind: 'capital_call', postings: [{ accountId: 'cash', amount: 999_000, currency: 'USD' }] },
        { date: '2026-01-15', kind: 'capital_call', postings: [
          { accountId: 'cash', amount: 80_000, currency: 'USD' },
          { accountId: 'cap-a', amount: -80_000, currency: 'USD' },
        ] },
        { date: '2026-02-01', kind: 'investment', postings: [{ accountId: 'cash', amount: -300_000, currency: 'USD' }] },
        { date: '2026-02-01', kind: 'distribution', postings: [{ accountId: 'cash', amount: -40_000, currency: 'USD' }] },
        { date: '2026-02-28', kind: null, driver: 'fee', postings: [
          { accountId: 'fee', amount: 25_000, currency: 'USD' },
          { accountId: 'cash', amount: -25_000, currency: 'USD' },
        ] },
      ],
    }))
    expect(r.called).toEqual({ actual: 100_000, forecast: 80_000 })
    expect(r.invested).toEqual({ actual: 0, forecast: 300_000 })
    expect(r.distributed).toEqual({ actual: 0, forecast: 40_000 })
    expect(r.fees).toEqual({ actual: 0, forecast: 25_000 })
  })

  it('ignores anything outside the range', () => {
    const r = capitalActivity(base({
      capitalPostings: [{ lpEntityId: 'lp-a', amount: -100_000, sourceType: 'capital_call', entryDate: '2025-10-31' }],
      planEntries: [{ date: '2026-03-01', kind: 'capital_call', postings: [{ accountId: 'cash', amount: 50_000, currency: 'USD' }] }],
    }))
    expect(r.called).toEqual({ actual: 0, forecast: 0 })
  })
})
