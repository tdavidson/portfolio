import { describe, it, expect } from 'vitest'
import { previewMetricValue, writeMetricValue } from '@/lib/pending-actions/metric-value'

/** Per-table chainable Supabase stub: `metrics` returns the metric, `metric_values` the existing
 *  same-period row (or null → insert). Awaiting a builder, or maybeSingle/single, resolves data. */
function makeAdminStub(opts: { existingValue: number | null; metricName: string; valueType: string }) {
  const data: Record<string, any> = {
    metrics: { id: 'm1', name: opts.metricName, value_type: opts.valueType, company_id: 'c1', fund_id: 'f1' },
    metric_values: opts.existingValue == null ? null : { id: 'mv1', value_number: opts.existingValue, value_text: null },
  }
  const query = (table: string) => {
    const result = { data: data[table] ?? null, error: null }
    const handler: ProxyHandler<any> = {
      get(_t, prop) {
        if (prop === 'then') return (res: any) => Promise.resolve(result).then(res)
        if (prop === 'maybeSingle' || prop === 'single') return async () => result
        return () => proxy
      },
    }
    const proxy: any = new Proxy({}, handler)
    return proxy
  }
  return { from: query } as any
}

const deps = (admin: any) => ({ admin, fundId: 'f1', userId: 'u1', access: { vehicles: { all: true, ids: [] } } as any })

describe('metric-value action', () => {
  it('preview reports update when a same-period row exists', async () => {
    const admin = makeAdminStub({ existingValue: 3_000_000, metricName: 'ARR', valueType: 'number' })
    const p = await previewMetricValue(deps(admin), {
      companyId: 'c1',
      metricId: 'm1',
      period_label: 'Q2 2026',
      period_year: 2026,
      period_quarter: 2,
      value: 4_000_000,
    })
    expect(p.summary).toContain('ARR')
    expect(p.details.mode).toBe('update')
    expect(p.details.from).toBe(3_000_000)
    expect(p.details.to).toBe(4_000_000)
  })

  it('preview reports insert when no same-period row exists', async () => {
    const admin = makeAdminStub({ existingValue: null, metricName: 'ARR', valueType: 'number' })
    const p = await previewMetricValue(deps(admin), {
      companyId: 'c1',
      metricId: 'm1',
      period_label: 'Q3 2026',
      period_year: 2026,
      period_quarter: 3,
      value: 5_000_000,
    })
    expect(p.details.mode).toBe('insert')
    expect(p.details.from).toBeNull()
  })

  it('write refuses a metric that is not in the caller fund', async () => {
    const admin = makeAdminStub({ existingValue: null, metricName: 'ARR', valueType: 'number' })
    await expect(
      writeMetricValue({ admin, fundId: 'other-fund', userId: 'u1', access: { vehicles: { all: true, ids: [] } } as any }, {
        companyId: 'c1',
        metricId: 'm1',
        period_label: 'Q3 2026',
        period_year: 2026,
        value: 1,
      }),
    ).rejects.toThrow(/not found/i)
  })
})
