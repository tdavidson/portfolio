import { describe, it, expect } from 'vitest'
import { formatAccountingPrice } from '@/components/currency-context'

describe('formatAccountingPrice', () => {
  it('wraps a negative in parentheses around the symbol and figure', () => {
    expect(formatAccountingPrice(-1234.5, 'USD')).toBe('($1,234.50)')
    expect(formatAccountingPrice(-0.01, 'USD')).toBe('($0.01)')
  })
  it('prints zero and positives plainly, and a negative that rounds to zero as zero', () => {
    expect(formatAccountingPrice(1234.5, 'USD')).toBe('$1,234.50')
    expect(formatAccountingPrice(0, 'USD')).toBe('$0.00')
    expect(formatAccountingPrice(-0.001, 'USD')).toBe('$0.00')
    expect(formatAccountingPrice(null, 'USD')).toBe('—')
  })
})
