import { beforeEach, describe, expect, it, vi } from 'vitest'
import { NextRequest } from 'next/server'
import type { AccessContext } from '@/lib/access/effective'
import { DEFAULT_FEATURE_VISIBILITY, type FeatureVisibilityMap } from '@/lib/types/features'
import { memoryAdmin } from './helpers/memory-admin'

/**
 * Publishing a capital call's notices from chat. The chat's function ships no Chromium, so it asks
 * app/api/agent/call-notices/publish (which does) with a signed five-minute token naming the fund,
 * the member and exactly what to publish. The route trusts the token for nothing else: it re-checks,
 * live, that the member is still an admin with the access the publish needs, then runs what the app
 * runs. lp_proposed_call_approve uses it to approve and publish in one step, as the app's button does.
 */

process.env.ENCRYPTION_KEY = process.env.ENCRYPTION_KEY || 'test-key-for-report-links'

const FUND = 'fund-1'
const store = memoryAdmin()
let access: AccessContext
let agentOn = true

const m = vi.hoisted(() => ({
  executePublish: vi.fn(),
  publishCallNotices: vi.fn(),
  approveProposedCall: vi.fn(),
  getProposedCall: vi.fn(),
  source: vi.fn(),
}))

vi.mock('@/lib/supabase/admin', () => ({ createAdminClient: () => store.admin }))
vi.mock('@/lib/oauth/enabled', () => ({ agentApiEnabled: async () => agentOn }))
vi.mock('@/lib/access/effective', async importOriginal => ({
  ...(await importOriginal<typeof import('@/lib/access/effective')>()),
  loadAccessContext: async () => access,
}))
vi.mock('@/lib/pending-actions/call-notices-publish', async () => {
  const { currentChangeSource } = await import('@/lib/audit/source')
  return {
    executePublishCallNotices: async (...a: unknown[]) => { m.source(currentChangeSource()); return m.executePublish(...a) },
  }
})
vi.mock('@/lib/accounting/proposed-call-publish', () => ({ publishCallNotices: (...a: unknown[]) => m.publishCallNotices(...a) }))
vi.mock('@/lib/accounting/proposed-calls', async importOriginal => ({
  ...(await importOriginal<typeof import('@/lib/accounting/proposed-calls')>()),
  approveProposedCall: (...a: unknown[]) => m.approveProposedCall(...a),
  getProposedCall: (...a: unknown[]) => m.getProposedCall(...a),
}))

import { POST } from '@/app/api/agent/call-notices/publish/route'
import {
  NOTICE_PUBLISH_TTL_SECONDS, publishNoticesRemotely, signNoticePublish, verifyNoticePublish, type NoticePublishRequest,
} from '@/lib/agent/notice-publish-link'
import { signReportLink } from '@/lib/agent/report-links'
import { getTool } from '@/lib/accounting/agent-tools'
import { withChangeSource } from '@/lib/audit/source'
import { matchRoute } from '@/lib/access/match-route'
import { UNGATED_ROUTES } from '@/lib/access/route-domains'
import { PDF_ROUTES } from '@/lib/pdf-routes.mjs'

const ctxAccess = (role: 'admin' | 'member', features: Partial<FeatureVisibilityMap> = {}): AccessContext => ({
  fundId: FUND, userId: 'u1', vehicles: { all: true, ids: [] }, role, grants: {}, defaults: {},
  features: { ...Object.fromEntries(Object.keys(DEFAULT_FEATURE_VISIBILITY).map(k => [k, 'everyone'])), ...features } as FeatureVisibilityMap,
})

const staged: NoticePublishRequest = {
  mode: 'staged', fundId: FUND, userId: 'u1', vehicle: 'Fund I', callId: 'call-1', lpEntityIds: ['ent-1'], previewToken: 'pt-1',
}
const proposed: NoticePublishRequest = {
  mode: 'proposed_call', fundId: FUND, userId: 'u1', vehicle: 'Fund I', callId: 'call-1', proposedCallId: 'prop-1',
}

const post = (token: string | null) => POST(new NextRequest('https://fund.test/api/agent/call-notices/publish', {
  method: 'POST', headers: token ? { authorization: `Bearer ${token}` } : {}, body: '{}',
}))

/** fetch, answered by the route itself. */
const viaRoute = vi.fn(async (url: string, init: RequestInit) => POST(new NextRequest(url, init as any)))

beforeEach(() => {
  for (const k of Object.keys(store.tables)) delete store.tables[k]
  Object.assign(store.tables, {
    fund_members: [{ fund_id: FUND, user_id: 'u1', role: 'admin' }],
    fund_vehicles: [{ id: 'v1', fund_id: FUND, name: 'Fund I', active: true, kind: 'fund', aliases: null }],
  })
  access = ctxAccess('admin')
  agentOn = true
  vi.clearAllMocks()
  m.executePublish.mockResolvedValue({ callId: 'call-1', published: 2, reused: 1, errors: [] })
  m.publishCallNotices.mockResolvedValue({ published: 3, reused: 1, errors: [] })
  m.getProposedCall.mockResolvedValue({ ok: true, value: { id: 'prop-1', status: 'approved', capitalCallId: 'call-1' } })
  m.approveProposedCall.mockResolvedValue({ ok: true, value: { id: 'prop-1', capitalCallId: 'call-1', issued: true, advancesApplied: {} } })
})

describe('the publish token', () => {
  it('round-trips a whole request until it expires', () => {
    const now = Date.UTC(2026, 9, 14, 12)
    const token = signNoticePublish(staged, now)
    expect(verifyNoticePublish(token, now)).toMatchObject(staged)
    expect(verifyNoticePublish(token, now + NOTICE_PUBLISH_TTL_SECONDS * 1000)).toBeNull()
  })

  it('refuses an edited claim, a report link, and a request missing what it publishes', () => {
    const [, sig] = signNoticePublish(staged).split('.')
    const forged = Buffer.from(JSON.stringify({ ...staged, callId: 'call-2', exp: 9e9 })).toString('base64url')
    expect(verifyNoticePublish(`${forged}.${sig}`)).toBeNull()
    // Same secret, another purpose: a report link is never a publish token.
    expect(verifyNoticePublish(signReportLink({ fundId: FUND, userId: 'u1', kind: 'lp_letter', args: { letter: 'l' } }).token)).toBeNull()
    expect(verifyNoticePublish(signNoticePublish({ ...staged, previewToken: '' } as any))).toBeNull()
    expect(verifyNoticePublish(signNoticePublish({ ...proposed, proposedCallId: '' } as any))).toBeNull()
    expect(verifyNoticePublish(signNoticePublish({ ...staged, mode: 'everything' } as any))).toBeNull()
  })
})

describe('POST /api/agent/call-notices/publish', () => {
  it('is let through by the proxy (it authenticates by its token) and ships Chromium', () => {
    const key = matchRoute('/api/agent/call-notices/publish')
    expect(key).toBe('api/agent/call-notices/publish')
    expect(UNGATED_ROUTES[key!]).toMatch(/signed five-minute token/)
    expect(PDF_ROUTES).toContain('/api/agent/call-notices/publish')
  })

  it('refuses a missing or forged token', async () => {
    expect((await post(null)).status).toBe(401)
    expect((await post('abc.def')).status).toBe(401)
    expect(m.executePublish).not.toHaveBeenCalled()
  })

  it("runs the app's executor for a staged publish, as the admin, with exactly what was approved", async () => {
    const res = await withChangeSource('mcp', async () => post(signNoticePublish({ ...staged, source: 'mcp' })))
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true, result: { callId: 'call-1', published: 2, reused: 1, errors: [] } })
    expect(m.executePublish).toHaveBeenCalledWith(
      { admin: store.admin, fundId: FUND, userId: 'u1', access },
      { vehicle: 'Fund I', callId: 'call-1', lpEntityIds: ['ent-1'], previewToken: 'pt-1' },
    )
    // The audit trail says it came through MCP, not the web.
    expect(m.source).toHaveBeenCalledWith('mcp')
  })

  it('re-checks live: a member who left, lost admin, lost the access, or whose fund turned agents off is refused', async () => {
    const token = signNoticePublish(staged)
    store.tables.fund_members = []
    expect((await post(token)).status).toBe(403)
    store.tables.fund_members = [{ fund_id: FUND, user_id: 'u1', role: 'member' }]
    const res = await post(token)
    expect(res.status).toBe(403)
    expect((await res.json()).error).toBe('Only an admin can publish notices to LPs.')
    store.tables.fund_members = [{ fund_id: FUND, user_id: 'u1', role: 'admin' }]
    agentOn = false
    expect((await post(token)).status).toBe(403)
    agentOn = true
    access = ctxAccess('admin', { lp_portal: 'off' })
    expect((await post(token)).status).toBe(403)
    expect(m.executePublish).not.toHaveBeenCalled()
  })

  it('answers a refused publish (a stale preview, a blocker) with its words', async () => {
    m.executePublish.mockRejectedValue(new Error('These notices have changed since they were previewed.'))
    const res = await post(signNoticePublish(staged))
    expect(res.status).toBe(422)
    expect((await res.json()).error).toBe('These notices have changed since they were previewed.')
  })

  it("publishes a proposed call's notices only for the call that proposal issued", async () => {
    const res = await post(signNoticePublish(proposed))
    expect(await res.json()).toEqual({ ok: true, result: { callId: 'call-1', published: 2, reused: 1, errors: [] } })
    expect(m.publishCallNotices).toHaveBeenCalledWith(store.admin, { fundId: FUND, group: 'Fund I', userId: 'u1' }, 'call-1')

    m.getProposedCall.mockResolvedValue({ ok: true, value: { id: 'prop-1', status: 'approved', capitalCallId: 'call-OTHER' } })
    expect((await post(signNoticePublish(proposed))).status).toBe(409)
    m.getProposedCall.mockResolvedValue({ ok: true, value: { id: 'prop-1', status: 'proposed', capitalCallId: null } })
    expect((await post(signNoticePublish(proposed))).status).toBe(409)
    expect(m.publishCallNotices).toHaveBeenCalledTimes(1)
  })

  it("gates a proposed call's notices as the proposed-calls route is gated (LP capital), not by the portal switch", async () => {
    access = ctxAccess('admin', { lp_portal: 'off' })
    expect((await post(signNoticePublish(proposed))).status).toBe(200)
    access = ctxAccess('admin', { lps: 'off' })
    expect((await post(signNoticePublish(proposed))).status).toBe(403)
    expect(m.publishCallNotices).toHaveBeenCalledTimes(1)
  })
})

describe('the client', () => {
  it('posts the token in the Authorization header, never the URL, to this deployment', async () => {
    const f = vi.fn(async () => new Response(JSON.stringify({ ok: true, result: { callId: 'call-1', published: 1, reused: 0, errors: [] } })))
    await publishNoticesRemotely(staged, { origin: 'https://fund.test/', fetch: f as any })
    const [url, init] = f.mock.calls[0] as any
    expect(url).toBe('https://fund.test/api/agent/call-notices/publish')
    expect(verifyNoticePublish(init.headers.authorization.replace('Bearer ', ''))).toMatchObject({ ...staged, source: 'web' })
  })

  it('throws with the route\'s refusal, or when the route cannot be reached', async () => {
    const refused = vi.fn(async () => new Response(JSON.stringify({ error: 'Only an admin can publish notices to LPs.' }), { status: 403 }))
    await expect(publishNoticesRemotely(staged, { fetch: refused as any }))
      .rejects.toThrow('The notices were not published (HTTP 403: Only an admin can publish notices to LPs.).')
    await expect(publishNoticesRemotely(staged, { fetch: (async () => { throw new Error('ECONNRESET') }) as any }))
      .rejects.toThrow('Could not reach the notice publisher: ECONNRESET.')
  })
})

describe('lp_proposed_call_approve: approve, issue and publish in one step', () => {
  const ctx = () => ({ admin: store.admin, fundId: FUND, portfolioGroup: '', userId: 'u1', access, origin: 'https://fund.test' }) as any

  beforeEach(() => { vi.stubGlobal('fetch', viaRoute) })

  it("issues the call, then publishes every LP's notice, as the app's Approve button does", async () => {
    const out = await getTool('lp_proposed_call_approve')!.handler(ctx(), { vehicle: 'Fund I', id: 'prop-1' })
    expect(out).toMatchObject({
      capitalCallId: 'call-1', issued: true, vehicle: 'Fund I', noticesPublished: 2, noticesReused: 1, publishErrors: [],
    })
    expect(out.publishFailed).toBeUndefined()
    expect(m.approveProposedCall).toHaveBeenCalledWith(store.admin, { fundId: FUND, group: 'Fund I', userId: 'u1' }, 'prop-1', { role: 'admin', acknowledge: false })
    expect(viaRoute.mock.calls[0][0]).toBe('https://fund.test/api/agent/call-notices/publish')
    expect(m.publishCallNotices).toHaveBeenCalledWith(store.admin, { fundId: FUND, group: 'Fund I', userId: 'u1' }, 'call-1')
  })

  it('reports partner errors, and says a second call retries them', async () => {
    m.publishCallNotices.mockResolvedValue({ published: 1, reused: 0, errors: ['Beta LLC: no portal account'] })
    const out = await getTool('lp_proposed_call_approve')!.handler(ctx(), { vehicle: 'Fund I', id: 'prop-1' })
    expect(out).toMatchObject({ noticesPublished: 1, publishErrors: ['Beta LLC: no portal account'] })
    expect(out.next).toMatch(/again with the same id retries them/)
  })

  it('when publishing fails after the call is issued, it says so and returns the callId to retry with', async () => {
    m.publishCallNotices.mockRejectedValue(new Error('Chromium missing'))
    const out = await getTool('lp_proposed_call_approve')!.handler(ctx(), { vehicle: 'Fund I', id: 'prop-1' })
    expect(out).toMatchObject({ capitalCallId: 'call-1', issued: true, noticesPublished: 0 })
    expect(out.publishFailed).toBe('The notices were not published (HTTP 422: Chromium missing).')
    expect(out.next).toMatch(/^The call is issued \(capitalCallId call-1\), but its notices were NOT published/)
    expect(out.next).toMatch(/lp_proposed_call_approve again with the same id/)
  })

  it('publishes nothing when the approval is refused', async () => {
    m.approveProposedCall.mockResolvedValue({ ok: false, status: 403, error: 'Only an admin can approve a capital call notice.' })
    await expect(getTool('lp_proposed_call_approve')!.handler(ctx(), { vehicle: 'Fund I', id: 'prop-1' })).rejects.toThrow('Only an admin')
    expect(viaRoute).not.toHaveBeenCalled()
  })
})
