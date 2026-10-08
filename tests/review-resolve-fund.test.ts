// tests/review-resolve-fund.test.ts
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { NextRequest } from 'next/server'
import { memoryAdmin } from '@/tests/helpers/memory-admin'

const s = vi.hoisted(() => ({ m: null as any, approve: vi.fn(), access: null as any, raced: false }))
vi.mock('@/lib/supabase/server', () => ({ createClient: async () => ({ auth: { getUser: async () => ({ data: { user: { id: 'u' } } }) }, from: (t: string) => s.m.admin.from(t) }) }))
vi.mock('@/lib/supabase/admin', () => ({ createAdminClient: () => s.m.admin }))
vi.mock('@/lib/api-helpers', async (orig) => ({ ...(await orig<any>()), assertWriteAccess: async () => ({ fundId: 'f', userId: 'u', role: 'member' }) }))
vi.mock('@/lib/access/effective', async (orig) => ({ ...(await orig<any>()), loadAccessContext: async () => s.access }))
vi.mock('@/lib/portfolio/fof-reviews', () => ({ approveFundReview: s.approve }))
vi.mock('@/lib/activity', () => ({ logActivity: () => {} }))
vi.mock('@/lib/cache/tags', () => ({ expireTag: () => {} }))
import { POST } from '@/app/api/review/[id]/resolve/route'

const fundReview = (over: Record<string, unknown> = {}) => ({
  id: 'r1', fund_id: 'f', email_id: 'em1', company_id: 'h1', vehicle_id: null, metric_id: null, issue_type: 'fund_nav', resolution: null,
  extracted_value: '9445000', payload: { kind: 'nav', asOfDate: '2025-09-30', reportedNav: 9_445_000 },
  ...over,
})
const seed = (review = fundReview(), opts = {}) => {
  s.m = memoryAdmin({
    parsing_reviews: [review],
    inbound_emails: [{ id: 'em1', fund_id: 'f', processing_status: 'needs_review' }],
    fund_settings: [{ fund_id: 'f', retain_resolved_reviews: true }],
  }, opts)
}

/** A member who may write the portfolio, over these entities; `over` changes the rest. */
const ctx = (vehicles: { all: boolean; ids: string[] }, over: Record<string, unknown> = {}) => ({
  fundId: 'f', userId: 'u', role: 'member', features: {}, grants: { portfolio: 'write' }, defaults: {}, vehicles, ...over,
})

beforeEach(() => {
  s.access = ctx({ all: true, ids: [] })
  s.approve.mockReset().mockResolvedValue({ ok: true, vehicleId: 'v1', message: 'Saved, and its mark posted to the ledger.', booking: { status: 'booked', message: 'Saved, and its mark posted to the ledger.' } })
  seed()
})
const post = (body: object) => POST(new NextRequest('http://localhost/api/review/r1/resolve', { method: 'POST', body: JSON.stringify(body) }), { params: Promise.resolve({ id: 'r1' }) })

describe('resolving a fund review', () => {
  it('approving writes through approveFundReview and records the entity chosen', async () => {
    const res = await post({ resolution: 'accepted', vehicleId: 'v1' })
    expect(res.status).toBe(200)
    expect((await res.json()).message).toMatch(/posted/)
    expect(s.approve).toHaveBeenCalledWith(s.m.admin, { fundId: 'f', userId: 'u', access: s.access },
      expect.objectContaining({ id: 'r1', payload: expect.any(Object) }), { vehicleId: 'v1', edits: undefined })
    expect(s.m.tables.parsing_reviews[0]).toMatchObject({ resolution: 'accepted', vehicle_id: 'v1' })
    expect(s.m.tables.inbound_emails[0].processing_status).toBe('success')
  })

  it('approving with corrections is recorded as corrected, with the corrections', async () => {
    await post({ resolution: 'accepted', edits: { reportedNav: 9_400_000 } })
    expect(s.m.tables.parsing_reviews[0]).toMatchObject({ resolution: 'manually_corrected', resolved_value: JSON.stringify({ reportedNav: 9_400_000 }) })
  })

  it('a refused approval leaves the review open, with the reason', async () => {
    s.approve.mockResolvedValue({ ok: false, status: 400, error: 'Choose which entity holds this fund.' })
    const res = await post({ resolution: 'accepted' })
    expect(res.status).toBe(400)
    expect(s.m.tables.parsing_reviews[0]).toMatchObject({ resolution: null, resolved_value: null, resolved_at: null })
    expect(s.m.tables.inbound_emails[0].processing_status).toBe('needs_review')
  })

  it('dismissing writes nothing to the register', async () => {
    await post({ resolution: 'rejected' })
    expect(s.approve).not.toHaveBeenCalled()
    expect(s.m.tables.parsing_reviews[0].resolution).toBe('rejected')
  })
})

describe('who may resolve a fund review', () => {
  it('a member cannot approve or dismiss another entity\'s review', async () => {
    s.access = ctx({ all: false, ids: ['v1'] })
    seed(fundReview({ vehicle_id: 'v2' }))
    for (const resolution of ['accepted', 'rejected']) {
      expect((await post({ resolution, vehicleId: 'v1' })).status).toBe(404)
    }
    expect(s.approve).not.toHaveBeenCalled()
    expect(s.m.tables.parsing_reviews[0]).toMatchObject({ resolution: null, vehicle_id: 'v2' })
  })

  it('a member cannot resolve an unassigned fund review — assigning it is for unscoped callers', async () => {
    s.access = ctx({ all: false, ids: ['v1'] })
    for (const resolution of ['accepted', 'rejected']) {
      expect((await post({ resolution, vehicleId: 'v1' })).status).toBe(404)
    }
    expect(s.approve).not.toHaveBeenCalled()
    expect(s.m.tables.parsing_reviews[0]).toMatchObject({ resolution: null, vehicle_id: null })
  })

  it('a member approves their own entity\'s review', async () => {
    s.access = ctx({ all: false, ids: ['v1'] })
    seed(fundReview({ vehicle_id: 'v1' }))
    expect((await post({ resolution: 'accepted' })).status).toBe(200)
    expect(s.m.tables.parsing_reviews[0]).toMatchObject({ resolution: 'accepted', vehicle_id: 'v1' })
  })

  it('another fund\'s review is not found', async () => {
    seed(fundReview({ fund_id: 'g' }))
    expect((await post({ resolution: 'accepted' })).status).toBe(404)
    expect(s.approve).not.toHaveBeenCalled()
  })
})

describe('approving twice', () => {
  it('a resolved review is not approved again', async () => {
    expect((await post({ resolution: 'accepted' })).status).toBe(200)
    expect((await post({ resolution: 'accepted' })).status).toBe(409)
    expect(s.approve).toHaveBeenCalledTimes(1)
  })

  it('a concurrent approval that resolves it first wins, and this one writes nothing', async () => {
    // Another request resolves the review after this one has read it as open.
    seed(fundReview(), {
      before: (table: string, op: string, _payload: unknown, tables: Record<string, any[]>) => {
        if (table === 'parsing_reviews' && op === 'update' && tables.parsing_reviews[0].resolution === null && !s.raced) {
          s.raced = true
          tables.parsing_reviews[0].resolution = 'accepted'
        }
      },
    })
    s.raced = false
    const res = await post({ resolution: 'accepted' })
    expect(res.status).toBe(409)
    expect(s.approve).not.toHaveBeenCalled()
    expect(s.m.tables.parsing_reviews[0].resolution).toBe('accepted')
  })
})

describe('an approval that fails outright', () => {
  it('leaves the review resolved — the write may have committed — and says to check the holding', async () => {
    s.approve.mockRejectedValue(new Error('connection reset'))
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const res = await post({ resolution: 'accepted' })
    expect(res.status).toBe(500)
    expect((await res.json()).error).toMatch(/Check the holding/)
    expect(s.m.tables.parsing_reviews[0].resolution).toBe('accepted')
  })

  it('a refusal whose reopen fails says the review could not be reopened', async () => {
    s.approve.mockResolvedValue({ ok: false, status: 400, error: 'Choose which entity holds this fund.' })
    vi.spyOn(console, 'error').mockImplementation(() => {})
    // The first update is the claim; the second, the reopen.
    s.m = memoryAdmin({ ...s.m.tables }, {
      before: (table: string, op: string) => {
        if (table === 'parsing_reviews' && op === 'update' && s.m.tables.parsing_reviews[0].resolution !== null) {
          s.m.failNext('parsing_reviews', 'update', 'connection reset')
        }
      },
    })
    const res = await post({ resolution: 'accepted' })
    expect(res.status).toBe(400)
    expect((await res.json()).error).toMatch(/could not be reopened/)
  })

  it('an approval whose entity cannot be recorded still reports the save, with a warning', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    s.m = memoryAdmin({ ...s.m.tables }, {
      before: (table: string, op: string, payload: any) => {
        if (table === 'parsing_reviews' && op === 'update' && payload && 'vehicle_id' in payload) {
          s.m.failNext('parsing_reviews', 'update', 'connection reset')
        }
      },
    })
    const res = await post({ resolution: 'accepted', vehicleId: 'v1' })
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ message: expect.stringMatching(/posted/), warning: expect.stringMatching(/entity/) })
  })
})

describe('the generic email review modal\'s "Edit & Accept" on a fund review', () => {
  it('is refused before anything is written: a fund proposal is corrected on its review card', async () => {
    seed(fundReview(), {})
    s.m.tables.fund_nav_statements = []
    s.m.tables.fund_capital_events = []
    // Exactly what components/email-review-modal.tsx sends: one free-text value, no edits.
    const res = await post({ resolution: 'manually_corrected', resolved_value: '9500000' })
    expect(res.status).toBe(400)
    expect((await res.json()).error).toBe('Correct it on the review card.')
    expect(s.approve).not.toHaveBeenCalled()
    expect(s.m.tables.parsing_reviews[0]).toMatchObject({ resolution: null })
    expect(s.m.tables.parsing_reviews[0].resolved_value ?? null).toBeNull()
    expect(s.m.tables.fund_nav_statements).toEqual([])
    expect(s.m.tables.fund_capital_events).toEqual([])
    expect(s.m.tables.inbound_emails[0].processing_status).toBe('needs_review')
  })
})

describe('the fund register\'s feature switch', () => {
  it('a fund review cannot be resolved by a member without write on fund holdings', async () => {
    s.access = ctx({ all: true, ids: [] }, { features: { investments: 'admin' } })
    for (const resolution of ['accepted', 'rejected']) {
      expect((await post({ resolution, vehicleId: 'v1' })).status).toBe(403)
    }
    expect(s.approve).not.toHaveBeenCalled()
    expect(s.m.tables.parsing_reviews[0].resolution).toBeNull()
  })

  it('with fund holdings switched off, not even an admin resolves one', async () => {
    s.access = ctx({ all: true, ids: [] }, { role: 'admin', features: { investments: 'off' } })
    expect((await post({ resolution: 'accepted', vehicleId: 'v1' })).status).toBe(403)
    expect(s.approve).not.toHaveBeenCalled()
  })

  it('a read-only grant on the portfolio cannot approve', async () => {
    s.access = ctx({ all: true, ids: [] }, { grants: { portfolio: 'read' } })
    expect((await post({ resolution: 'accepted', vehicleId: 'v1' })).status).toBe(403)
  })
})
