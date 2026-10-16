import { beforeEach, afterEach, expect, it, vi } from 'vitest'
import { createClient } from '@supabase/supabase-js'
import { NextRequest } from 'next/server'
const m = vi.hoisted(() => ({ client: null as unknown, fail: false }))
vi.mock('@/lib/supabase/server', () => ({ createClient: async () => ({ auth: { getUser: async () => ({ data: { user: { id: 'user-a' } } }) } }) }))
vi.mock('@/lib/supabase/admin', () => ({ createAdminClient: () => m.client }))
import { GET as usage } from '@/app/api/usage/route'
import { GET as analytics } from '@/app/api/diligence/analytics/route'
let urls: URL[]
beforeEach(() => {
  vi.useFakeTimers(); vi.setSystemTime(new Date('2026-10-15T12:00:00Z'))
  urls = []; m.fail = false
  m.client = createClient('https://synthetic.invalid', 'synthetic', { auth: { persistSession: false }, global: { fetch: async input => {
    const url = new URL(String(input)); urls.push(url)
    const table = url.pathname.split('/').at(-1)
    if (m.fail && table?.startsWith('reporting_')) return new Response(JSON.stringify({ message: 'private database detail' }), { status: 500 })
    let data: unknown = []
    if (table === 'fund_members' && url.searchParams.has('user_id')) data = { fund_id: 'fund-a', role: 'admin' }
    if (table === 'fund_settings') data = { disable_user_tracking: true }
    if (table === 'reporting_usage_daily') data = [{ created_at: '2026-10-01T00:00:00+00:00', provider: 'openai', model: 'gpt-4o', input_tokens: 1000000, output_tokens: 0, audio_seconds: 0, web_searches: 10 }]
    if (table === 'diligence_deals') data = [{ id: 'deal-a', sector: 'Synthetic', deal_status: 'active', created_at: '2026-10-01T00:00:00Z' }]
    if (table === 'reporting_diligence_drafts') data = [{ id: 'draft-a', deal_id: 'deal-a', has_ingestion: true, has_research: false, has_qa: true, has_memo_draft: true, is_draft: false, created_at: '2026-10-03T00:00:00Z', finalized_at: '2026-10-05T00:00:00Z' }]
    return new Response(JSON.stringify(data))
  } } })
})
afterEach(() => { vi.useRealTimers() })
it('preserves usage totals and pricing from compact daily rows', async () => {
  const body = await (await usage()).json()
  expect(body.monthly[0].input_tokens).toBe(1000000)
  expect(body.mtd.total_estimated_cost).toBeCloseTo(2.6)
  expect(body.activity).toBeNull()
  const summary = urls.find(u => u.pathname.endsWith('reporting_usage_daily'))!
  expect(summary.searchParams.get('fund_id')).toBe('eq.fund-a')
  expect(urls.some(u => u.pathname.endsWith('/ai_usage_logs'))).toBe(false)
})
it('preserves analytics funnel and timing without downloading memo bodies', async () => {
  const body = await (await analytics(new NextRequest('https://synthetic.invalid/api/diligence/analytics'))).json()
  expect(body.funnel).toMatchObject({ created: 1, has_ingestion: 1, has_research: 0, has_qa: 1, has_memo_draft: 1, finalized: 1 })
  expect(body.time_in_stage).toMatchObject({ median_days_created_to_draft: 2, median_days_draft_to_final: 2 })
  const summary = urls.find(u => u.pathname.endsWith('reporting_diligence_drafts'))!
  expect(summary.searchParams.get('fund_id')).toBe('eq.fund-a')
  expect(summary.searchParams.get('select')).not.toContain('memo_draft_output')
})
it('surfaces a missing or failed summary view rather than reporting false zero totals', async () => {
  m.fail = true
  expect((await usage()).status).toBe(500)
  const response = await analytics(new NextRequest('https://synthetic.invalid/api/diligence/analytics'))
  expect(response.status).toBe(500)
  expect(JSON.stringify(await response.json())).not.toContain('private database detail')
})
