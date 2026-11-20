import { beforeEach, describe, expect, it, vi } from 'vitest'
import { NextRequest } from 'next/server'

// The routes' collaborators are stand-ins: what is under test is the order of the checks and what
// each route hands back. The spec validator and the drafting loop are tested in lib/custom-views.
const context = vi.fn()
vi.mock('@/lib/custom-views/http', () => ({ viewsContext: () => context() }))
const hasKey = vi.fn(async () => true)
vi.mock('@/lib/ai/keyless', () => ({ fundHasAIKey: () => hasKey() }))
const createMessage = vi.fn()
vi.mock('@/lib/ai/feature-provider', () => ({
  getFeatureProvider: async () => ({ provider: { createMessage }, model: 'model-x', providerType: 'anthropic' }),
}))
vi.mock('@/lib/rate-limit', () => ({ rateLimit: async () => null }))
const logged = vi.fn()
vi.mock('@/lib/ai/usage', () => ({ logAIUsage: (...a: unknown[]) => logged(...a) }))
const resolveView = vi.fn(async (_d: unknown, spec: any) => ({ view: 'custom', title: spec.title, data: { blocks: [] } }))
vi.mock('@/lib/custom-views/resolve', () => ({ resolveView: (...a: unknown[]) => resolveView(...(a as [unknown, unknown])) }))
const saveView = vi.fn(async (_a: unknown, _f: unknown, _u: unknown, input: any) => ({ id: 'view-1', name: input.name }))
vi.mock('@/lib/custom-views/store', async importOriginal => ({
  ...(await importOriginal<typeof import('@/lib/custom-views/store')>()),
  saveView: (...a: unknown[]) => saveView(...(a as [unknown, unknown, unknown, unknown])),
}))

import { POST as draft } from '@/app/api/views/draft/route'
import { POST as save } from '@/app/api/views/route'

const SPEC = {
  title: 'Largest positions',
  blocks: [{ type: 'table', label: 'Positions', source: { tool: 'query_portfolio', dataset: 'positions', query: { columns: ['company'] } } }],
}
const member = (role = 'member') => ({ admin: {}, fundId: 'fund-1', userId: 'user-me', access: { role } })
const post = (url: string, body: unknown) => new NextRequest(`http://localhost${url}`, { method: 'POST', body: JSON.stringify(body) })

beforeEach(() => {
  vi.clearAllMocks()
  context.mockResolvedValue(member())
  hasKey.mockResolvedValue(true)
})

describe('POST /api/views/draft', () => {
  it('builds a spec with the fund\'s model, logs the spend, and previews it as the caller', async () => {
    createMessage.mockResolvedValueOnce({ text: JSON.stringify(SPEC), usage: { inputTokens: 10, outputTokens: 5 }, truncated: false })
    const res = await draft(post('/api/views/draft', { instruction: 'largest positions' }))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.spec.title).toBe('Largest positions')
    expect(body.payload.view).toBe('custom')
    expect((resolveView.mock.calls[0] as any[])[0]).toMatchObject({ fundId: 'fund-1', userId: 'user-me' })
    expect(logged).toHaveBeenCalledWith({}, expect.objectContaining({ feature: 'custom_view_draft', model: 'model-x', userId: 'user-me' }))
  })

  it('refuses on a fund with no AI key, before calling any model', async () => {
    hasKey.mockResolvedValueOnce(false)
    const res = await draft(post('/api/views/draft', { instruction: 'x' }))
    expect(res.status).toBe(400)
    expect((await res.json()).error).toMatch(/no AI key/)
    expect(createMessage).not.toHaveBeenCalled()
  })

  it('refuses a current spec that does not validate', async () => {
    const res = await draft(post('/api/views/draft', { instruction: 'x', spec: { title: 'T', blocks: [{ type: 'iframe' }] } }))
    expect(res.status).toBe(400)
    expect(createMessage).not.toHaveBeenCalled()
  })

  it('says why when the model cannot produce a valid spec', async () => {
    createMessage.mockResolvedValue({ text: 'sorry', usage: { inputTokens: 1, outputTokens: 1 }, truncated: false })
    const res = await draft(post('/api/views/draft', { instruction: 'x' }))
    expect(res.status).toBe(422)
    expect(resolveView).not.toHaveBeenCalled()
  })

  it('is refused to a non-member', async () => {
    const { NextResponse } = await import('next/server')
    context.mockResolvedValueOnce({ error: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }) })
    expect((await draft(post('/api/views/draft', { instruction: 'x' }))).status).toBe(401)
  })
})

describe('POST /api/views', () => {
  it('saves for the caller, in the caller\'s fund', async () => {
    const res = await save(post('/api/views', { name: 'Mine', spec: SPEC, shared: true, fund_id: 'fund-other' }))
    expect(res.status).toBe(200)
    expect((await res.json()).saved).toEqual({ id: 'view-1', name: 'Mine', path: '/views/view-1' })
    expect(saveView.mock.calls[0].slice(1, 3)).toEqual(['fund-1', 'user-me'])
  })

  it('refuses the read-only viewer role', async () => {
    context.mockResolvedValueOnce(member('viewer'))
    expect((await save(post('/api/views', { name: 'Mine', spec: SPEC }))).status).toBe(403)
    expect(saveView).not.toHaveBeenCalled()
  })
})
