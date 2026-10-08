// tests/email-bulk-reviews-fund.test.ts
import { describe, expect, it, vi } from 'vitest'
import { NextRequest } from 'next/server'
import { memoryAdmin } from '@/tests/helpers/memory-admin'

const s = vi.hoisted(() => ({ investments: true, m: null as any, hide: null as null | ((t: string) => any) }))
vi.mock('@/lib/supabase/server', () => ({ createClient: async () => ({ auth: { getUser: async () => ({ data: { user: { id: 'u' } } }) }, from: (t: string) => (s.hide ?? s.m.admin.from)(t) }) }))
vi.mock('@/lib/supabase/admin', () => ({ createAdminClient: () => s.m.admin }))
vi.mock('@/lib/api-helpers', async (orig) => ({ ...(await orig<any>()), assertWriteAccess: async () => ({ fundId: 'f', userId: 'u', role: 'admin' }), assertReadAccess: async () => ({ fundId: 'f', userId: 'u', role: 'member' }) }))
vi.mock('@/lib/access/effective', () => ({
  loadAccessContext: async () => ({}),
  hasAccess: (_a: unknown, _d: string, _l: string, feature?: string) => feature !== 'investments' || s.investments,
}))
vi.mock('@/lib/cache/tags', () => ({ expireTag: () => {} }))
import { GET, POST } from '@/app/api/emails/[id]/reviews/route'

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

  const post = (action: string) => POST(new NextRequest('http://localhost/api/emails/em1/reviews', { method: 'POST', body: JSON.stringify({ action }) }), { params: Promise.resolve({ id: 'em1' }) })

  it('dismiss all resolves fund reviews too — dismissing writes nothing — and the email leaves review', async () => {
    s.m = memoryAdmin({
      inbound_emails: [{ id: 'em1', fund_id: 'f', processing_status: 'needs_review' }],
      parsing_reviews: [
        { id: 'r1', fund_id: 'f', email_id: 'em1', issue_type: 'low_confidence', resolution: null },
        { id: 'r2', fund_id: 'f', email_id: 'em1', issue_type: 'fund_nav', resolution: null, payload: { kind: 'nav' } },
      ],
      fund_settings: [{ fund_id: 'f', retain_resolved_reviews: true }],
    })
    const res = await post('dismiss_all')
    expect(await res.json()).toMatchObject({ ok: true, resolved: 2, leftOpen: 0 })
    expect(s.m.tables.parsing_reviews.map((r: any) => r.resolution)).toEqual(['rejected', 'rejected'])
    expect(s.m.tables.inbound_emails[0].processing_status).toBe('success')
  })

  it('a review the caller cannot see keeps the email in review', async () => {
    s.m = memoryAdmin({
      inbound_emails: [{ id: 'em1', fund_id: 'f', processing_status: 'needs_review' }],
      parsing_reviews: [
        { id: 'r1', fund_id: 'f', email_id: 'em1', issue_type: 'low_confidence', resolution: null },
        { id: 'r2', fund_id: 'f', email_id: 'em1', issue_type: 'fund_nav', resolution: null, vehicle_id: 'v2', payload: { kind: 'nav' } },
      ],
      fund_settings: [{ fund_id: 'f', retain_resolved_reviews: true }],
    })
    // The caller's client stands in for RLS: it does not return the other entity's review.
    const from = s.m.admin.from
    s.hide = (t: string) => {
      const q = from(t)
      return t === 'parsing_reviews' ? q.neq('id', 'r2') : q
    }
    try {
      const res = await post('dismiss_all')
      expect(await res.json()).toMatchObject({ ok: true, resolved: 1 })
      expect(s.m.tables.parsing_reviews.map((r: any) => r.resolution)).toEqual(['rejected', null])
      expect(s.m.tables.inbound_emails[0].processing_status).toBe('needs_review')
    } finally {
      s.hide = null
    }
  })

  const seedMixed = () => {
    s.m = memoryAdmin({
      inbound_emails: [{ id: 'em1', fund_id: 'f', processing_status: 'needs_review' }],
      parsing_reviews: [
        { id: 'r1', fund_id: 'f', email_id: 'em1', issue_type: 'low_confidence', resolution: null },
        { id: 'r2', fund_id: 'f', email_id: 'em1', issue_type: 'fund_nav', resolution: null, payload: { kind: 'nav' } },
      ],
      fund_settings: [{ fund_id: 'f', retain_resolved_reviews: true }],
    })
  }
  const get = () => GET(new NextRequest('http://localhost/api/emails/em1/reviews'), { params: Promise.resolve({ id: 'em1' }) })

  it('a member below investments read is not shown fund reviews; with it they are', async () => {
    seedMixed()
    s.investments = false
    try {
      expect((await (await get()).json()).items.map((i: any) => i.id)).toEqual(['r1'])
    } finally {
      s.investments = true
    }
    expect((await (await get()).json()).items.map((i: any) => i.id).sort()).toEqual(['r1', 'r2'])
  })

  it('dismiss all leaves fund reviews open for a caller below investments write, and counts them', async () => {
    seedMixed()
    s.investments = false
    try {
      const res = await post('dismiss_all')
      expect(await res.json()).toMatchObject({ ok: true, resolved: 1, leftOpen: 1 })
      expect(s.m.tables.parsing_reviews.map((r: any) => r.resolution)).toEqual(['rejected', null])
      expect(s.m.tables.inbound_emails[0].processing_status).toBe('needs_review')
    } finally {
      s.investments = true
    }
  })

  it('the bulk write is held to the caller\'s fund, whatever the read returned', async () => {
    s.m = memoryAdmin({
      inbound_emails: [{ id: 'em1', fund_id: 'f', processing_status: 'needs_review' }],
      parsing_reviews: [
        { id: 'r1', fund_id: 'f', email_id: 'em1', issue_type: 'low_confidence', resolution: null },
        // Another fund's row the caller's read should never have returned (here the test's client has no RLS).
        { id: 'r9', fund_id: 'g', email_id: 'em1', issue_type: 'low_confidence', resolution: null },
      ],
      fund_settings: [{ fund_id: 'f', retain_resolved_reviews: false }],
    })
    const res = await post('dismiss_all')
    expect(res.status).toBe(200)
    expect(s.m.tables.parsing_reviews.map((r: any) => [r.id, r.resolution])).toEqual([['r9', null]])
  })

  it('a failed bulk update is an error, and the email stays in review', async () => {
    seedMixed()
    s.m.failNext('parsing_reviews', 'update', 'boom')
    const res = await post('dismiss_all')
    expect(res.status).toBe(500)
    expect(s.m.tables.parsing_reviews.map((r: any) => r.resolution)).toEqual([null, null])
    expect(s.m.tables.inbound_emails[0].processing_status).toBe('needs_review')
  })
})
