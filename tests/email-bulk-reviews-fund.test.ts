// tests/email-bulk-reviews-fund.test.ts
import { describe, expect, it, vi } from 'vitest'
import { NextRequest } from 'next/server'
import { memoryAdmin } from '@/tests/helpers/memory-admin'

const s = vi.hoisted(() => ({ m: null as any }))
vi.mock('@/lib/supabase/server', () => ({ createClient: async () => ({ auth: { getUser: async () => ({ data: { user: { id: 'u' } } }) }, from: (t: string) => s.m.admin.from(t) }) }))
vi.mock('@/lib/supabase/admin', () => ({ createAdminClient: () => s.m.admin }))
vi.mock('@/lib/api-helpers', async (orig) => ({ ...(await orig<any>()), assertWriteAccess: async () => ({ fundId: 'f', userId: 'u', role: 'admin' }) }))
vi.mock('@/lib/cache/tags', () => ({ expireTag: () => {} }))
import { POST } from '@/app/api/emails/[id]/reviews/route'

describe('approve all on an email', () => {
  it('leaves a fund review open — approving it writes the register, which a bulk action must not skip — and the email in review', async () => {
    s.m = memoryAdmin({
      inbound_emails: [{ id: 'em1', fund_id: 'f', processing_status: 'needs_review' }],
      parsing_reviews: [
        { id: 'r1', fund_id: 'f', email_id: 'em1', issue_type: 'low_confidence', resolution: null },
        { id: 'r2', fund_id: 'f', email_id: 'em1', issue_type: 'fund_nav', resolution: null, payload: { kind: 'nav' } },
      ],
      fund_settings: [{ fund_id: 'f', retain_resolved_reviews: true }],
    })
    const res = await POST(new NextRequest('http://localhost/api/emails/em1/reviews', { method: 'POST', body: JSON.stringify({ action: 'approve_all' }) }), { params: Promise.resolve({ id: 'em1' }) })
    expect(res.status).toBe(200)
    expect(s.m.tables.parsing_reviews.map((r: any) => [r.id, r.resolution])).toEqual([['r1', 'accepted'], ['r2', null]])
    expect(s.m.tables.inbound_emails[0].processing_status).toBe('needs_review')
  })
})
