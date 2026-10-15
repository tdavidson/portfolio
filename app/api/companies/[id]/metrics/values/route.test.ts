import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createClient } from '@supabase/supabase-js'

const state = vi.hoisted(() => ({ client: null as any }))
vi.mock('@/lib/supabase/server', () => ({ createClient: async () => state.client }))
import { GET } from './route'

let company: unknown[]
let series: unknown[]
let failed: boolean
const fetch = vi.fn(async (input: RequestInfo | URL) => {
  const table = new URL(String(input)).pathname.split('/').at(-1)
  return new Response(JSON.stringify(table === 'companies' ? company
    : failed ? { message: 'synthetic database error', code: '42501' } : series), {
    status: failed && table === 'metrics' ? 403 : 200,
  })
})
const request = () => GET(new Request('https://synthetic.invalid'), { params: Promise.resolve({ id: 'company-1' }) })

beforeEach(() => {
  fetch.mockClear()
  failed = false
  company = [{ id: 'company-1', fund_id: 'fund-1' }]
  series = []
  state.client = createClient('https://synthetic.invalid', 'synthetic-key', {
    global: { fetch }, auth: { persistSession: false, autoRefreshToken: false },
  })
  vi.spyOn(state.client.auth, 'getUser').mockResolvedValue({ data: { user: { id: 'user-1' } }, error: null })
})

describe('company chart history batch', () => {
  it('requires authentication before querying data', async () => {
    state.client.auth.getUser.mockResolvedValue({ data: { user: null }, error: null })
    expect((await request()).status).toBe(401)
    expect(fetch).not.toHaveBeenCalled()
  })

  it('does not fetch metrics when RLS hides the company', async () => {
    company = []
    expect((await request()).status).toBe(404)
    expect(fetch).toHaveBeenCalledTimes(1)
  })

  it('batches active series while retaining company/fund filters and independent history limits', async () => {
    const base = { metric_id: 'cash', period_year: 2026, period_quarter: 1, period_month: null }
    series = [
      { id: 'cash', values: [{ ...base, created_at: '2026-04-01', value_number: 10 },
        { ...base, created_at: '2026-04-02', value_number: 12 }] },
      { id: 'mrr', values: [{ ...base, metric_id: 'mrr', created_at: '2026-04-01', value_number: 20 }] },
    ]
    const res = await request()
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.cash).toHaveLength(1)
    expect(body.cash[0].value_number).toBe(12)
    expect(body.mrr[0].value_number).toBe(20)
    expect(fetch).toHaveBeenCalledTimes(2)
    expect(new URL(String(fetch.mock.calls[0][0])).searchParams.get('holding_type')).toBe('eq.company')
    const query = new URL(String(fetch.mock.calls[1][0])).searchParams
    expect(query.get('company_id')).toBe('eq.company-1')
    expect(query.get('fund_id')).toBe('eq.fund-1')
    expect(query.get('values.company_id')).toBe('eq.company-1')
    expect(query.get('values.fund_id')).toBe('eq.fund-1')
    expect(query.get('is_active')).toBe('eq.true')
    expect(query.get('values.limit')).toBe('1000')
    expect(query.get('values.order')).toBe('period_year.asc,period_quarter.asc.nullslast,period_month.asc.nullslast')
  })

  it('returns an empty object for a company without metrics', async () => {
    expect(await (await request()).json()).toEqual({})
  })

  it('reports a failed history query as an error, without disclosing provider details', async () => {
    failed = true
    const res = await request()
    expect(res.status).toBe(500)
    expect(await res.json()).toEqual({ error: 'An unexpected error occurred.' })
  })
})
