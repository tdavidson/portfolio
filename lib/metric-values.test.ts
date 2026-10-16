import { describe, expect, it } from 'vitest'
import { dedupeMetricValues } from './metric-values'

describe('batched metric histories', () => {
  it('keeps independent series and periods, replacing only an older capture of the same period', () => {
    const period = { period_year: 2026, period_quarter: 1, period_month: null }
    const original = { ...period, metric_id: 'cash', created_at: '2026-04-01', value_number: 10 }
    const other = { ...period, metric_id: 'mrr', created_at: '2026-04-01', value_number: 20 }
    const revised = { ...original, created_at: '2026-04-02', value_number: 12 }
    const monthly = { ...original, period_month: 3, value_number: 30 }
    expect(dedupeMetricValues([original, other, revised, monthly])).toEqual([revised, other, monthly])
    expect(dedupeMetricValues([])).toEqual([])
  })
})
