import { describe, it, expect } from 'vitest'
import { loadActualBookYear, orgClockFor, taxSourceRef } from './book-tax-run'
import { ORG_AMORTIZATION_MONTHS } from './book-tax'

describe('orgClockFor', () => {
  it('runs from the month the fund begins business, not from January', () => {
    // Begins business in October: three months of the §709 clock fall in the first tax year.
    expect(orgClockFor('2026-10-14', 2026)).toEqual({
      monthsInYear: 3,
      monthsAlreadyAmortized: 0,
      isFirstYear: true,
    })
  })

  it('gives a full first year to a fund that begins in January', () => {
    expect(orgClockFor('2026-01-02', 2026)).toEqual({
      monthsInYear: 12,
      monthsAlreadyAmortized: 0,
      isFirstYear: true,
    })
  })

  it('carries the short first year forward into the months already run', () => {
    // Oct 2026 start: 3 months in 2026, so 2027 opens with 3 already amortized.
    expect(orgClockFor('2026-10-14', 2027)).toEqual({
      monthsInYear: 12,
      monthsAlreadyAmortized: 3,
      isFirstYear: false,
    })
    expect(orgClockFor('2026-10-14', 2028)).toEqual({
      monthsInYear: 12,
      monthsAlreadyAmortized: 15,
      isFirstYear: false,
    })
  })

  it('accumulates to the 180-month horizon without overshooting it', () => {
    // Year 16 of a January fund: 180 months exactly consumed, nothing left.
    const clock = orgClockFor('2026-01-01', 2041)
    expect(clock.monthsAlreadyAmortized).toBe(ORG_AMORTIZATION_MONTHS)
  })

  it('reports nothing for a year before the fund existed', () => {
    expect(orgClockFor('2026-10-14', 2025)).toEqual({
      monthsInYear: 0,
      monthsAlreadyAmortized: 0,
      isFirstYear: false,
    })
  })
})

describe('taxSourceRef', () => {
  it('is deterministic per year, so a re-run can find what it wrote', () => {
    expect(taxSourceRef(2026)).toBe('tax:2026')
  })
})

// ---------------------------------------------------------------------------
// loadActualBookYear
// ---------------------------------------------------------------------------

const ACCOUNTS = [
  { id: 'a-1200', code: '1200', type: 'asset', subtype: 'unrealized' },
  { id: 'a-4200', code: '4200', type: 'income', subtype: 'unrealized' },
  { id: 'a-5200', code: '5200' },
  { id: 'a-5250', code: '5250' },
  { id: 'cap-a', code: '3100-a', type: 'equity', lp_entity_id: 'lp-a' },
  { id: 'cap-b', code: '3100-b', type: 'equity', lp_entity_id: 'lp-b' },
  { id: 'cap-gp', code: '3100-gp', type: 'equity', lp_entity_id: 'gp' },
  { id: 'due', code: '1300', type: 'asset' },
  { id: 'a-4300', code: '4300', type: 'income', subtype: 'fx_translation' },
  { id: 'fx-acme', code: '1250-acme', type: 'asset', subtype: 'fx_translation' },
]

function posting(over: Partial<Record<string, any>>) {
  return {
    account_id: 'a-4200',
    amount: 0,
    lp_entity_id: null,
    journal_entries: { entry_date: '2026-06-30', status: 'posted', source_type: null, book: 'actual' },
    ...over,
  }
}

/** Chainable fake returning the right rows per table. */
function fakeAdmin(postings: any[], vehicleName = 'Fund I', accounts: any[] = ACCOUNTS) {
  const make = (rows: any[]) => {
    const q: any = {
      select: () => q,
      eq: () => q,
      in: () => q,
      order: () => q,
      range: (from: number) => Promise.resolve({ data: from === 0 ? rows : [], error: null }),
      maybeSingle: () => Promise.resolve({ data: rows[0] ?? null, error: null }),
      single: () => Promise.resolve({ data: rows[0] ?? null, error: null }),
      then: (resolve: (v: any) => void) => resolve({ data: rows, error: null }),
    }
    return q
  }
  return {
    from: (table: string) => {
      if (table === 'chart_of_accounts') return make(accounts)
      if (table === 'journal_postings') return make(postings)
      if (table === 'fund_vehicles') return make([{ id: 'veh-1', name: vehicleName }])
      return make([])
    },
  } as any
}

describe('loadActualBookYear', () => {
  it('reports appreciation as a positive book-over-tax difference', async () => {
    // 4200 is an income account, so book credits it: appreciation of 2.5m arrives as -2,500,000.
    // Getting this sign wrong would reverse every unrealized adjustment, so it is pinned.
    const res = await loadActualBookYear(
      fakeAdmin([posting({ account_id: 'a-4200', amount: -2_500_000 })]),
      'fund-1',
      'Fund I',
      2026,
    )
    if ('error' in res) throw new Error(res.error)
    expect(res.year.unrealizedChange).toBe(2_500_000)
  })

  it('reports a write-down as a negative difference', async () => {
    const res = await loadActualBookYear(
      fakeAdmin([posting({ account_id: 'a-4200', amount: 400_000 })]),
      'fund-1',
      'Fund I',
      2026,
    )
    if ('error' in res) throw new Error(res.error)
    expect(res.year.unrealizedChange).toBe(-400_000)
  })

  it('ignores activity outside the tax year', async () => {
    const res = await loadActualBookYear(
      fakeAdmin([
        posting({ amount: -1_000_000, journal_entries: { entry_date: '2025-12-31', status: 'posted', source_type: null, book: 'actual' } }),
        posting({ amount: -250_000, journal_entries: { entry_date: '2026-03-31', status: 'posted', source_type: null, book: 'actual' } }),
      ]),
      'fund-1',
      'Fund I',
      2026,
    )
    if ('error' in res) throw new Error(res.error)
    expect(res.year.unrealizedChange).toBe(250_000)
  })

  it('ignores drafts and voids', async () => {
    const res = await loadActualBookYear(
      fakeAdmin([
        posting({ amount: -900_000, journal_entries: { entry_date: '2026-06-30', status: 'draft', source_type: null, book: 'actual' } }),
        posting({ amount: -100_000 }),
      ]),
      'fund-1',
      'Fund I',
      2026,
    )
    if ('error' in res) throw new Error(res.error)
    expect(res.year.unrealizedChange).toBe(100_000)
  })

  it('collects the carry accrual per partner, keeping both sides', async () => {
    const carryEntry = { entry_date: '2026-12-31', status: 'posted', source_type: 'carried_interest', book: 'actual' }
    const res = await loadActualBookYear(
      fakeAdmin([
        posting({ journal_entry_id: 'e-carry', account_id: 'cap-a', amount: 60_000, lp_entity_id: 'lp-a', journal_entries: carryEntry }),
        posting({ journal_entry_id: 'e-carry', account_id: 'cap-b', amount: 40_000, lp_entity_id: 'lp-b', journal_entries: carryEntry }),
        posting({ journal_entry_id: 'e-carry', account_id: 'cap-gp', amount: -100_000, lp_entity_id: 'gp', journal_entries: carryEntry }),
      ]),
      'fund-1',
      'Fund I',
      2026,
    )
    if ('error' in res) throw new Error(res.error)
    // The difference is the amount the LPs bore; the GP's credit is the other side of the same
    // reallocation and must not double it.
    expect(res.year.carryAccruedOnUnrealized).toBe(100_000)
    expect(res.perLpCarry.get('lp-a')).toBe(60_000)
    expect(res.perLpCarry.get('gp')).toBe(-100_000)
  })

  it("does not read a GP entity's 4200 (management-fee income) as unrealized appreciation", async () => {
    const admin = fakeAdmin([posting({ account_id: 'gp-4200', amount: -50_000 })], 'GP LLC', [
      { id: 'gp-4200', code: '4200', type: 'income', subtype: 'management_fee_income' },
    ])
    const res = await loadActualBookYear(admin, 'fund-1', 'GP LLC', 2026)
    if ('error' in res) throw new Error(res.error)
    expect(res.year.unrealizedChange).toBe(0)
  })

  it("reads currency translation apart from the marks: the year's 4300, each partner's share, each company's 1250", async () => {
    const reval = { entry_date: '2026-06-30', status: 'posted', source_type: 'fx_revaluation', book: 'actual' }
    const res = await loadActualBookYear(
      fakeAdmin([
        posting({ journal_entry_id: 'e-fx', account_id: 'fx-acme', amount: 12_000, journal_entries: reval }),
        posting({ journal_entry_id: 'e-fx', account_id: 'a-4300', amount: -12_000, journal_entries: reval }),
        posting({ journal_entry_id: 'e-alloc', account_id: 'cap-a', amount: -12_000, lp_entity_id: 'lp-a', journal_entries: reval }),
      ]),
      'fund-1',
      'Fund I',
      2026,
    )
    if ('error' in res) throw new Error(res.error)
    expect(res.year.fxChange).toBe(12_000)
    expect(res.year.unrealizedChange).toBe(0)
    expect(res.perLpFx).toEqual(new Map([['lp-a', -12_000]]))
    expect(res.assetMoves.fx).toEqual(new Map([['fx-acme', 12_000]]))
  })

  it("collects each partner's unrealized allocation from their capital account, not a receivable", async () => {
    const valuation = { entry_date: '2026-12-31', status: 'posted', source_type: 'valuation', book: 'actual' }
    const res = await loadActualBookYear(
      fakeAdmin([
        posting({ journal_entry_id: 'e-val', account_id: 'cap-a', amount: -300_000, lp_entity_id: 'lp-a', journal_entries: valuation }),
        posting({ journal_entry_id: 'e-val', account_id: 'cap-b', amount: -200_000, lp_entity_id: 'lp-b', journal_entries: valuation }),
        // A per-partner receivable is tagged with the partner too, and is not capital.
        posting({ journal_entry_id: 'e-val', account_id: 'due', amount: 999, lp_entity_id: 'lp-a', journal_entries: valuation }),
      ]),
      'fund-1',
      'Fund I',
      2026,
    )
    if ('error' in res) throw new Error(res.error)
    expect(res.perLpUnrealized).toEqual(new Map([['lp-a', -300_000], ['lp-b', -200_000]]))
  })

  it('separates organizational from syndication costs', async () => {
    const res = await loadActualBookYear(
      fakeAdmin([
        posting({ account_id: 'a-5200', amount: 60_000 }),
        posting({ account_id: 'a-5250', amount: 150_000 }),
      ]),
      'fund-1',
      'Fund I',
      2026,
    )
    if ('error' in res) throw new Error(res.error)
    expect(res.year.organizationalExpense).toBe(60_000)
    expect(res.year.syndicationExpense).toBe(150_000)
  })

  it('counts organizational costs since inception, not just this year', async () => {
    // §709's immediate deduction is computed off the total spend, so a prior-year cost still
    // affects this year's phase-out.
    const res = await loadActualBookYear(
      fakeAdmin([
        posting({ account_id: 'a-5200', amount: 40_000, journal_entries: { entry_date: '2025-11-01', status: 'posted', source_type: null, book: 'actual' } }),
        posting({ account_id: 'a-5200', amount: 20_000 }),
      ]),
      'fund-1',
      'Fund I',
      2026,
    )
    if ('error' in res) throw new Error(res.error)
    expect(res.year.organizationalExpense).toBe(20_000)
    expect(res.year.organizationalCostsToDate).toBe(60_000)
  })

  it('derives the §709 clock from the earliest posted entry when not told otherwise', async () => {
    const res = await loadActualBookYear(
      fakeAdmin([
        posting({ account_id: 'a-5200', amount: 10_000, journal_entries: { entry_date: '2026-10-05', status: 'posted', source_type: null, book: 'actual' } }),
      ]),
      'fund-1',
      'Fund I',
      2026,
    )
    if ('error' in res) throw new Error(res.error)
    expect(res.year.org).toEqual({ monthsInYear: 3, monthsAlreadyAmortized: 0, isFirstYear: true })
  })

  it('prefers an inception date the caller supplies', async () => {
    const res = await loadActualBookYear(
      fakeAdmin([posting({ account_id: 'a-5200', amount: 10_000 })]),
      'fund-1',
      'Fund I',
      2026,
      { inceptionDate: '2026-02-01' },
    )
    if ('error' in res) throw new Error(res.error)
    expect(res.year.org.monthsInYear).toBe(11)
  })
})
