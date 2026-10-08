import { describe, it, expect } from 'vitest'
import { effectiveCompanyStatus, isNewCompany } from './investments'
import type { InvestmentTransaction } from '@/lib/types/database'

const BASE = {
  company_id: 'c1', fund_id: 'f', round_name: null, transaction_date: null, notes: null,
  investment_cost: null, interest_converted: 0, shares_acquired: null, share_price: null,
  cost_basis_exited: null, proceeds_received: null, proceeds_escrow: 0, proceeds_written_off: 0,
  proceeds_per_share: null, unrealized_value_change: null, current_share_price: null,
  postmoney_valuation: null, latest_postmoney_valuation: null, exit_valuation: null,
  ownership_pct: null, portfolio_group: 'Fund I', original_currency: null,
  original_investment_cost: null, original_share_price: null, original_postmoney_valuation: null,
  original_proceeds_received: null, original_proceeds_per_share: null, original_exit_valuation: null,
  original_unrealized_value_change: null, original_current_share_price: null,
  original_latest_postmoney_valuation: null, valuation_change_source: null, fx_rate: null,
  prior_fx_rate: null, fx_value_change: null, original_position_value: null,
  created_at: null, updated_at: null,
}
const txn = (o: Partial<InvestmentTransaction> & Record<string, any>) =>
  ({ ...BASE, ...o }) as InvestmentTransaction

const buy = txn({ transaction_type: 'investment', round_name: 'Seed', transaction_date: '2016-03-01', investment_cost: 100000, shares_acquired: 1000, share_price: 100 })

describe('effectiveCompanyStatus', () => {
  it('active + fully written off, nothing received -> written-off', () => {
    const wo = txn({ transaction_type: 'proceeds', round_name: 'Seed', transaction_date: '2018-01-01', cost_basis_exited: 100000, proceeds_received: 0, proceeds_written_off: 100000 })
    expect(effectiveCompanyStatus([buy, wo], 'active')).toBe('written-off')
  })
  it('active + fully exited with proceeds -> exited', () => {
    const ex = txn({ transaction_type: 'proceeds', round_name: 'Seed', transaction_date: '2019-01-01', cost_basis_exited: 100000, proceeds_received: 250000 })
    expect(effectiveCompanyStatus([buy, ex], 'active')).toBe('exited')
  })
  it('escrow only still counts as received -> exited', () => {
    const ex = txn({ transaction_type: 'proceeds', round_name: 'Seed', transaction_date: '2019-01-01', cost_basis_exited: 100000, proceeds_received: 0, proceeds_escrow: 5000 })
    expect(effectiveCompanyStatus([buy, ex], 'active')).toBe('exited')
  })
  it('partial exit stays active', () => {
    const ex = txn({ transaction_type: 'proceeds', round_name: 'Seed', transaction_date: '2019-01-01', cost_basis_exited: 40000, proceeds_received: 90000 })
    expect(effectiveCompanyStatus([buy, ex], 'active')).toBe('active')
  })
  it('no transactions or no proceeds stays active', () => {
    expect(effectiveCompanyStatus([], 'active')).toBe('active')
    expect(effectiveCompanyStatus([buy], 'active')).toBe('active')
  })
  it('status already exited / written-off is unchanged', () => {
    const wo = txn({ transaction_type: 'proceeds', round_name: 'Seed', cost_basis_exited: 100000, proceeds_received: 0, proceeds_written_off: 100000 })
    expect(effectiveCompanyStatus([buy, wo], 'exited')).toBe('exited')
    expect(effectiveCompanyStatus([buy], 'written-off')).toBe('written-off')
  })
})

describe('isNewCompany', () => {
  const now = new Date('2026-10-08T00:00:00Z')
  const daysAgo = (d: number) => new Date(now.getTime() - d * 86400000).toISOString()
  it('is new at 90 days, not at 91', () => {
    expect(isNewCompany(daysAgo(90), null, now)).toBe(true)
    expect(isNewCompany(daysAgo(91), null, now)).toBe(false)
  })
  it('a 2016 investment is not new', () => {
    expect(isNewCompany('2016-05-01', daysAgo(5), now)).toBe(false)
  })
  it('falls back to created_at when never invested', () => {
    expect(isNewCompany(null, daysAgo(10), now)).toBe(true)
    expect(isNewCompany(null, daysAgo(200), now)).toBe(false)
    expect(isNewCompany(null, null, now)).toBe(false)
  })
})
