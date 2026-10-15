import { describe, expect, it, vi } from 'vitest'
import { createClient } from '@supabase/supabase-js'
import type { PageSupabase } from '@/lib/pages/context'
import { loadDashboardCompanyRows } from './companies'

function client(body: unknown = [], status = 200) {
  const fetch = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => new Response(JSON.stringify(body), { status }))
  const db = createClient('https://synthetic.invalid', 'synthetic-key', {
    global: { fetch }, auth: { persistSession: false, autoRefreshToken: false },
  }) as unknown as PageSupabase
  return { db, fetch }
}

describe('dashboard metric batch', () => {
  it('bounds each embedded history independently in one fund- and entity-scoped request', async () => {
    const { db, fetch } = client()
    await loadDashboardCompanyRows(db, 'fund-1', ['company-1', 'company-2'])
    expect(fetch).toHaveBeenCalledTimes(1)
    const query = new URL(String(fetch.mock.calls[0][0])).searchParams
    expect(query.get('fund_id')).toBe('eq.fund-1')
    expect(query.get('id')).toBe('in.(company-1,company-2)')
    expect(query.get('metrics.is_active')).toBe('eq.true')
    expect(query.get('parsing_reviews.resolution')).toBe('is.null')
    expect(query.get('select')).toContain('parsing_reviews(count)')
    for (const relation of ['metrics.latest', 'metrics.latest_numeric', 'latest_period']) {
      expect(query.get(`${relation}.limit`)).toBe('1')
      expect(query.get(`${relation}.order`)).toContain('period_year.desc')
    }
    // Card values preserve chronological order, with newest capture breaking period ties.
    expect(query.get('metrics.latest.order')).toBe('period_year.desc,period_quarter.desc.nullsfirst,period_month.desc.nullsfirst,created_at.desc')
    // Cash sorting ignores text/null values, without dropping a company or its metric.
    expect(query.get('metrics.latest_numeric.value_number')).toBe('not.is.null')
    expect(query.get('select')).not.toContain('!inner')
  })

  it('does no database work when the viewer has no companies', async () => {
    const { db, fetch } = client()
    expect(await loadDashboardCompanyRows(db, 'fund-1', [])).toEqual([])
    expect(fetch).not.toHaveBeenCalled()
  })

  it('retains the fund filter for an unscoped admin', async () => {
    const { db, fetch } = client()
    await loadDashboardCompanyRows(db, 'fund-1', null)
    const query = new URL(String(fetch.mock.calls[0][0])).searchParams
    expect(query.get('fund_id')).toBe('eq.fund-1')
    expect(query.has('id')).toBe(false)
  })

  it('surfaces a failed batch without exposing provider details or claiming an empty portfolio', async () => {
    const { db } = client({ message: 'sensitive provider detail', code: '42501' }, 403)
    await expect(loadDashboardCompanyRows(db, 'fund-1', null)).rejects.toThrow(/^Could not load portfolio metrics$/)
  })
})
