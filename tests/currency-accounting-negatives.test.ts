import { describe, expect, it } from 'vitest'
import { formatCurrency, formatCurrencyAxis, formatCurrencyFull, formatCurrencyPrice } from '@/components/currency-context'

// Negative money reads in accounting parentheses everywhere, compact figures and axes included.
describe('currency formatters', () => {
  it('puts negatives in parentheses', () => {
    expect(formatCurrency(-1_200_000, 'USD')).toBe('($1.2M)')
    expect(formatCurrencyFull(-200_000, 'USD')).toBe('($200,000)')
    expect(formatCurrencyPrice(-12.5, 'USD')).toBe('($12.50)')
    expect(formatCurrencyAxis(-2_000_000, 'USD')).toBe('($2M)')
  })

  it('leaves positives and zero alone', () => {
    expect(formatCurrencyFull(200_000, 'USD')).toBe('$200,000')
    expect(formatCurrencyAxis(0, 'USD')).toBe('$0')
    expect(formatCurrencyPrice(-0.001, 'USD')).toBe('$0.00')
  })
})
