import { describe, expect, it } from 'vitest'
import type { ReportLine } from '@/lib/forecast/report'
import { OTHER_KEY, sourceBreakdown } from './breakdown'

const line = (code: string, type: 'income' | 'expense', values: number[], subtype: string | null = null): ReportLine =>
  ({ accountId: code, code, name: `Account ${code}`, type, subtype, values })

describe('sourceBreakdown', () => {
  it('ranks sources largest first and keeps each one its own series', () => {
    const out = sourceBreakdown([
      line('4000', 'income', [100, 100]),
      line('4100', 'income', [500, 500]),
      line('6000', 'expense', [50, 50]),
    ], 'income')
    expect(out.map(s => s.label)).toEqual(['Account 4100', 'Account 4000'])
    expect(out[0].values).toEqual([500, 500])
  })

  it('leaves gains and other non-operating income out of revenue', () => {
    const out = sourceBreakdown([
      line('4000', 'income', [100]),
      line('4900', 'income', [1_000], 'realized_gain'),
      line('4950', 'income', [1_000], 'unrealized'),
    ], 'income')
    expect(out.map(s => s.label)).toEqual(['Account 4000'])
  })

  it('folds everything past the top few into Other, summed period by period', () => {
    const lines = [1, 2, 3, 4, 5, 6, 7].map(n => line(`60${n}0`, 'expense', [n * 100, n * 10]))
    const out = sourceBreakdown(lines, 'expense', 5)
    expect(out).toHaveLength(6)
    expect(out.slice(0, 5).map(s => s.label)).toEqual(['Account 6070', 'Account 6060', 'Account 6050', 'Account 6040', 'Account 6030'])
    expect(out[5]).toEqual({ key: OTHER_KEY, label: 'Other (2)', values: [300, 30] })
  })

  it('names a single leftover source rather than folding it alone', () => {
    const lines = [1, 2, 3, 4, 5, 6].map(n => line(`60${n}0`, 'expense', [n * 100]))
    const out = sourceBreakdown(lines, 'expense', 5)
    expect(out).toHaveLength(6)
    expect(out.some(s => s.key === OTHER_KEY)).toBe(false)
  })

  it('drops sources with nothing in range', () => {
    expect(sourceBreakdown([line('6000', 'expense', [0, 0.1])], 'expense')).toEqual([])
  })
})
