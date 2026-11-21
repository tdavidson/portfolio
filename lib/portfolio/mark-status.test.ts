import { describe, expect, it } from 'vitest'
import { holdingTypeLabel, lastQuarterEnd, latestMarks, markChangeOf, markSourceOf, staleness, type MarkTxn } from './mark-status'

const txn = (o: Partial<MarkTxn>): MarkTxn => ({ id: 't', company_id: 'c1', transaction_type: 'unrealized_gain_change', transaction_date: '2026-06-30', ...o })

describe('markSourceOf', () => {
  const none = new Set<string>()
  it('labels each kind of mark', () => {
    expect(markSourceOf(txn({ id: 'a' }), new Set(['a']))).toBe('nav_statement')
    expect(markSourceOf(txn({ valuation_change_source: 'nav', unrealized_value_change: 5_000 }), none)).toBe('nav')
    expect(markSourceOf(txn({ valuation_change_source: 'quote', current_share_price: 12 }), none)).toBe('price')
    expect(markSourceOf(txn({ transaction_type: 'round_info', share_price: 2 }), none)).toBe('round')
    expect(markSourceOf(txn({ valuation_change_source: 'mark', unrealized_value_change: -1_000 }), none)).toBe('manual')
  })
  it('does not count an FX revaluation, a round with no price, or other transactions', () => {
    expect(markSourceOf(txn({ valuation_change_source: 'fx', unrealized_value_change: 300 }), none)).toBeNull()
    expect(markSourceOf(txn({ transaction_type: 'round_info', share_price: null }), none)).toBeNull()
    expect(markSourceOf(txn({ transaction_type: 'investment' }), none)).toBeNull()
    expect(markSourceOf(txn({}), none)).toBeNull()
  })
})

describe('markChangeOf', () => {
  it('is the signed value change on a mark row only', () => {
    expect(markChangeOf({ transaction_type: 'unrealized_gain_change', unrealized_value_change: -2_500 })).toBe(-2_500)
    expect(markChangeOf({ transaction_type: 'investment', unrealized_value_change: 100 })).toBeNull()
    expect(markChangeOf({ transaction_type: 'unrealized_gain_change', unrealized_value_change: null })).toBeNull()
  })
})

describe('holdingTypeLabel', () => {
  it('reads crypto as digital_asset', () => {
    expect(holdingTypeLabel('crypto')).toBe('digital_asset')
    expect(holdingTypeLabel('fund')).toBe('fund')
    expect(holdingTypeLabel(null)).toBe('company')
  })
})

describe('latestMarks', () => {
  it('takes the latest mark, counts NAV statements, and prefers the better-evidenced source on a tie', () => {
    const m = latestMarks([
      txn({ id: 'buy', transaction_type: 'investment', transaction_date: '2025-01-15' }),
      txn({ id: 'm1', transaction_date: '2026-03-31', valuation_change_source: 'mark', unrealized_value_change: 1 }),
      txn({ id: 'm2', transaction_date: '2026-06-30', valuation_change_source: 'mark', unrealized_value_change: 1 }),
    ], [{ company_id: 'c1', as_of_date: '2026-06-30', reported_nav: '100000', investment_transaction_id: null }]).get('c1')!
    expect(m).toEqual({ lastMarkDate: '2026-06-30', lastMarkSource: 'nav_statement', lastNavStatementDate: '2026-06-30', lastNavStatementNav: 100_000, firstInvestmentDate: '2025-01-15' })
  })
  it('ignores anything after as_of', () => {
    const m = latestMarks([txn({ transaction_date: '2026-09-30', valuation_change_source: 'nav', unrealized_value_change: 1 })], [], '2026-09-29')
    expect(m.get('c1')?.lastMarkDate ?? null).toBeNull()
  })
})

describe('staleness', () => {
  it('finds the latest quarter end', () => {
    expect(lastQuarterEnd('2026-11-21')).toBe('2026-09-30')
    expect(lastQuarterEnd('2026-09-30')).toBe('2026-09-30')
    expect(lastQuarterEnd('2026-02-01')).toBe('2025-12-31')
  })
  it('is stale before the quarter end, current on or after it', () => {
    expect(staleness({ lastMarkDate: '2026-06-30', firstInvestmentDate: '2025-01-01' }, '2026-11-21')).toMatchObject({ stale: true, staleReason: 'before_quarter_end', markAgeDays: 144 })
    expect(staleness({ lastMarkDate: '2026-09-30', firstInvestmentDate: '2025-01-01' }, '2026-11-21')).toMatchObject({ stale: false, staleReason: null })
  })
  it('a NAV-sourced plain value change counts as current', () => {
    const m = latestMarks([txn({ transaction_date: '2026-09-30', valuation_change_source: 'nav', unrealized_value_change: 4_000 })], []).get('c1')
    expect(m?.lastMarkSource).toBe('nav')
    expect(staleness(m, '2026-11-21').stale).toBe(false)
  })
  it('uses max_age_days instead when given', () => {
    expect(staleness({ lastMarkDate: '2026-09-30', firstInvestmentDate: null }, '2026-11-21', 30)).toMatchObject({ stale: true, staleReason: 'older_than_max_age' })
    expect(staleness({ lastMarkDate: '2026-06-30', firstInvestmentDate: null }, '2026-11-21', 200).stale).toBe(false)
  })
  it('a holding never marked is stale, unless it was first bought after the quarter end', () => {
    expect(staleness({ lastMarkDate: null, firstInvestmentDate: '2026-01-10' }, '2026-11-21')).toMatchObject({ stale: true, staleReason: 'no_mark' })
    expect(staleness({ lastMarkDate: null, firstInvestmentDate: '2026-10-10' }, '2026-11-21').stale).toBe(false)
    expect(staleness(undefined, '2026-11-21').stale).toBe(true)
  })
})
