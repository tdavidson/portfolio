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

describe('letter and dashboard formatters', () => {
  it('put negatives in parentheses', async () => {
    const { fmt } = await import('@/lib/lp-letters/generate')
    const { createFormatters } = await import('@/lib/mcp-apps/app/format')
    expect(fmt(-1_200_000, 'USD')).toBe('($1.2M)')
    expect(fmt(-250_000, 'USD')).toBe('($250K)')
    expect(fmt(250_000, 'USD')).toBe('$250K')
    const f = createFormatters('USD', 'en-US')
    expect(f.compact(-1_200_000)).toBe('($1.2M)')
    expect(f.compact(850_000)).toBe('$850K')
    expect(f.money(-200_000)).toBe('($200,000)')
  })
})
