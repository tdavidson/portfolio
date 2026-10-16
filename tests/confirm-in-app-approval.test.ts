import { describe, it, expect, vi, beforeEach } from 'vitest'

// An action marked personConfirms (publishing notices to LPs) is approved only by a door a person
// stands behind, which supplies its executor: the browser's route (with the second confirmation)
// or a chat's approve_action (on its person's explicit yes). A script's key supplies none, and the
// row stays pending (lib/pending-actions/service.ts).

const m = vi.hoisted(() => ({ preview: vi.fn(), refuse: vi.fn(), executor: vi.fn() }))
vi.mock('@/lib/pending-actions/registry', () => ({
  getWriteAction: () => ({
    domain: 'lp_relations', accessFeature: 'lp_portal', entity: 'required', personConfirms: true,
    preview: m.preview, execute: m.refuse,
  }),
}))

import { approvePendingAction } from '@/lib/pending-actions/service'

const ROW = {
  id: '00000000-0000-4000-8000-000000000001', fund_id: 'f1', vehicle_id: 'v1', domain: 'lp_relations',
  action_type: 'publish_call_notices', args: { vehicle: 'Fund I', callId: 'call1', previewToken: 't' },
  preview: { summary: 'Publish 2 notices', details: {} }, status: 'pending', created_by: 'member', created_via: 'mcp',
  created_credential: 'oauth:abc', approved_by: null, approved_at: null, applied_result: null, error: null,
  created_at: '2026-10-13T00:00:00Z', updated_at: '2026-10-13T00:00:00Z',
}

function admin() {
  const updates: any[] = []
  return {
    updates,
    from: () => {
      const chain: any = {
        select: () => chain, eq: () => chain,
        update: (u: any) => { updates.push(u); return chain },
        maybeSingle: async () => ({ data: ROW, error: null }),
      }
      return chain
    },
  } as any
}

const features = new Proxy({}, { get: () => 'everyone' }) as any
const principal = (role: 'admin' | 'member') => ({
  userId: 'u1', fundId: 'f1', role,
  access: { fundId: 'f1', userId: 'u1', role, features, grants: { lp_relations: 'write' }, defaults: {}, vehicles: { all: true, ids: [] } },
}) as any

describe('approving what publishes to LPs', () => {
  beforeEach(() => {
    m.preview.mockReset().mockResolvedValue({ summary: 'ok', details: {} })
    m.refuse.mockReset().mockRejectedValue(new Error('refused'))
    m.executor.mockReset().mockResolvedValue({ published: 2 })
  })

  it('is refused where no executor is supplied (a script\'s key), leaving the row pending', async () => {
    const a = admin()
    await expect(approvePendingAction(a, principal('admin'), ROW.id)).rejects.toMatchObject({ status: 409, code: 'CONFIRM_IN_APP' })
    expect(a.updates).toEqual([])
    expect(m.refuse).not.toHaveBeenCalled()
  })

  it('needs the second confirmation even in the app', async () => {
    const a = admin()
    await expect(approvePendingAction(a, principal('admin'), ROW.id, { executors: { publish_call_notices: m.executor } }))
      .rejects.toMatchObject({ status: 428, code: 'CONFIRMATION_REQUIRED' })
    expect(a.updates).toEqual([])
    expect(m.executor).not.toHaveBeenCalled()
  })

  it('needs an admin', async () => {
    await expect(approvePendingAction(admin(), principal('member'), ROW.id, { confirmed: true, executors: { publish_call_notices: m.executor } }))
      .rejects.toMatchObject({ status: 403, code: 'ADMIN_ONLY' })
  })

  it('publishes once confirmed in the app', async () => {
    const out = await approvePendingAction(admin(), principal('admin'), ROW.id, { confirmed: true, executors: { publish_call_notices: m.executor } })
    expect(out.result).toEqual({ published: 2 })
    expect(m.executor).toHaveBeenCalledTimes(1)
    expect(m.refuse).not.toHaveBeenCalled()
  })
})

describe('approving a publish from chat (approve_action)', () => {
  const fetchMock = vi.fn()
  beforeEach(() => {
    process.env.ENCRYPTION_KEY = process.env.ENCRYPTION_KEY || 'test-key-for-report-links'
    m.preview.mockReset().mockResolvedValue({ summary: 'ok', details: {} })
    m.refuse.mockReset().mockRejectedValue(new Error('refused'))
    fetchMock.mockReset().mockResolvedValue(new Response(JSON.stringify({ ok: true, result: { callId: 'call1', published: 2, reused: 1, errors: [] } }), { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)
  })

  async function approveFrom(keyId: string, role: 'admin' | 'member' = 'admin') {
    const { getPendingTool } = await import('@/lib/agent/pending-tools')
    const p = principal(role)
    return getPendingTool('approve_action')!.run({
      admin: admin(), auth: { keyId, userId: 'u1', fundId: 'f1', role } as any, access: p.access, origin: 'https://fund.test',
    }, { id: ROW.id })
  }

  it("an admin's chat publishes through the Chromium-bundled route, with a token naming exactly what was staged", async () => {
    const out = await approveFrom('oauth:other-chat') as any
    expect(out).toMatchObject({ applied: true, result: { callId: 'call1', published: 2, reused: 1, errors: [] } })
    expect(m.refuse).not.toHaveBeenCalled()
    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe('https://fund.test/api/agent/call-notices/publish')
    expect(init.method).toBe('POST')
    const { verifyNoticePublish, bearerToken } = await import('@/lib/agent/notice-publish-link')
    expect(verifyNoticePublish(bearerToken(init.headers.authorization)!)).toMatchObject({
      mode: 'staged', fundId: 'f1', userId: 'u1', vehicle: 'Fund I', callId: 'call1', previewToken: 't', lpEntityIds: null,
    })
  })

  it('the chat that staged it may approve it on its person\'s yes', async () => {
    const out = await approveFrom('oauth:abc') as any
    expect(out.applied).toBe(true)
  })

  it("a script's key is refused, and nothing is published", async () => {
    await expect(approveFrom('lk_script')).rejects.toMatchObject({ code: 'CONFIRM_IN_APP' })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it("a member's chat cannot approve it", async () => {
    await expect(approveFrom('oauth:member-chat', 'member')).rejects.toMatchObject({ code: 'ADMIN_ONLY' })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('a refusal at the route fails the approval with its words', async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ error: 'These notices have changed since they were previewed.' }), { status: 422 }))
    await expect(approveFrom('oauth:other-chat')).rejects.toMatchObject({
      code: 'ACTION_FAILED', message: expect.stringContaining('These notices have changed since they were previewed.'),
    })
  })
})
