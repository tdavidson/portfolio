import { describe, expect, it, vi } from 'vitest'
import { createClient } from '@supabase/supabase-js'
import type { EntityScope } from '@/lib/access/entity-scope'
import type { PageSupabase } from '@/lib/pages/context'
import { loadDashboardTable } from './table'

const scope = { access: { fundId: 'fund-1' }, companyIds: ['c1'], vehicleNames: ['Fund I'] } as EntityScope
const value = (month: number | null, quarter: number | null, number: number, text: string | null = null) => ({
  period_year: 2026, period_month: month, period_quarter: quarter, value_number: number, value_text: text,
})
const metric = (id: string, type: string, values: ReturnType<typeof value>[]) => ({
  id, name: id, unit: null, unit_position: 'prefix', value_type: type, currency: null,
  display_order: 0, is_active: true, values, latest_numeric: [{ value_number: 99 }],
})
function setup(data: unknown, status = 200) {
  const fetch = vi.fn(async (_input: RequestInfo | URL) => new Response(JSON.stringify(data), { status }))
  const client = createClient('https://synthetic.invalid', 'synthetic', {
    global: { fetch }, auth: { persistSession: false, autoRefreshToken: false },
  }) as unknown as PageSupabase
  return { client, fetch }
}

describe('dashboard table batch', () => {
  it('preserves quarterly numeric/text summaries and scopes entity names', async () => {
    const { client, fetch } = setup([{ id: 'c1', name: 'Synthetic company', tags: [], portfolio_group: ['Fund I', 'Fund II'], metrics: [
      metric('Cash', 'currency', [value(1, 1, 10), value(3, 1, 30), value(null, 2, 60), value(null, null, 120)]),
      metric('Status', 'text', [value(3, 1, 0, 'On track')]),
    ] }])
    const rows = await loadDashboardTable(client, scope)
    expect(rows[0].portfolioGroup).toEqual(['Fund I'])
    expect(rows[0].latestCash).toBe(99)
    expect(rows[0].metrics[0].values).toEqual({ 'Q1 2026': 30, 'Q2 2026': 60, 'Q4 2026': 120 })
    expect(rows[0].metrics[1].values).toEqual({ 'Q1 2026': 'On track' })
    expect(fetch).toHaveBeenCalledTimes(1)
    const params = new URL(String(fetch.mock.calls[0][0])).searchParams
    expect(params.get('fund_id')).toBe('eq.fund-1')
    expect(params.get('id')).toBe('in.(c1)')
    expect(params.get('metrics.values.period_year')).toBe('gte.2025')
    expect(params.get('metrics.latest_numeric.limit')).toBe('1')
    expect(params.get('metrics.is_active')).toBe('eq.true')
    expect(params.get('holding_type')).toBe('eq.company')
  })

  it('avoids a query when access includes no companies', async () => {
    const { client, fetch } = setup([])
    expect(await loadDashboardTable(client, { ...scope, companyIds: [] })).toEqual([])
    expect(fetch).not.toHaveBeenCalled()
  })

  it('does not turn an RLS/query failure into an empty table', async () => {
    const { client } = setup({ message: 'private detail' }, 403)
    await expect(loadDashboardTable(client, scope)).rejects.toThrow(/^Could not load portfolio table$/)
  })
})
