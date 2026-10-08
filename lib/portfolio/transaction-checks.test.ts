import { describe, expect, it } from 'vitest'
import { transactionRowError } from './transaction-checks'

const base = { transaction_type: 'investment', transaction_date: '2026-01-15', investment_cost: 1000 }

describe('transactionRowError', () => {
  it('accepts a plain investment', () => {
    expect(transactionRowError(base)).toBeNull()
  })

  it('refuses a rate that is not a fraction, as the table constraint would', () => {
    expect(transactionRowError({ ...base, interest_rate: 5 })).toMatch(/interest_rate is a fraction/)
    expect(transactionRowError({ ...base, dividend_rate: 1 })).toMatch(/dividend_rate is a fraction/)
    expect(transactionRowError({ ...base, interest_rate: -0.01 })).toMatch(/interest_rate is a fraction/)
  })

  it('accepts a rate from 0 up to 1', () => {
    expect(transactionRowError({ ...base, interest_rate: 0.08 })).toBeNull()
    expect(transactionRowError({ ...base, dividend_rate: '0' })).toBeNull()
  })
})
