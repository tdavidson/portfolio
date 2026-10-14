import { describe, it, expect, vi, beforeEach } from 'vitest'

/**
 * The API boundary.
 *
 * This is the test for the claim the whole access model rests on: that a member without a grant
 * cannot reach a domain's data THROUGH THE API, regardless of what the route handler does. 137 of
 * 263 routes never checked role — the point of gating in middleware is that those routes do not
 * have to be trusted, or even edited, to be closed.
 *
 * The cases below are written as the attacks they prevent: a viewer POSTing a deal (which the
 * route itself still permits), a member curling the carry endpoint, a member fetching an
 * interactions API whose feature the fund switched off.
 */

const getUser = vi.hoisted(() => vi.fn())
const from = vi.hoisted(() => vi.fn())
const rpc = vi.hoisted(() => vi.fn())
const getAuthenticatorAssuranceLevel = vi.hoisted(() => vi.fn(async () => ({ data: null })))

vi.mock('@supabase/ssr', () => ({
  createServerClient: () => ({
    auth: { getUser, mfa: { getAuthenticatorAssuranceLevel } },
    from,
    rpc,
  }),
}))

import { proxy as middleware } from '@/proxy'
import { DEFAULT_FEATURE_VISIBILITY } from '@/lib/types/features'

let role = 'member'
let features: Record<string, string> = {}
let grants: { domain: string; level: string }[] = []
let defaults: { domain: string; level: string }[] = []

/**
 * The `access_context` RPC (migration 20260716000009) — the one call the gate makes. `member` is
 * null when the caller belongs to no fund.
 */
let member: boolean = true

function stubRpc() {
  rpc.mockImplementation(async () => ({
    data: member
      ? {
          fund_id: 'f1',
          role,
          features: { ...DEFAULT_FEATURE_VISIBILITY, ...features },
          grants: Object.fromEntries(grants.map(g => [g.domain, g.level])),
          defaults: Object.fromEntries(defaults.map(d => [d.domain, d.level])),
        }
      : null,
    error: null,
  }))
  from.mockImplementation(() => {
    const chain: any = {
      select: () => chain,
      eq: () => chain,
      maybeSingle: async () => ({ data: null, error: null }),
    }
    return chain
  })
}

const req = (pathname: string, method = 'GET') =>
  ({
    nextUrl: { pathname, search: '', clone: () => new URL(`https://x${pathname}`) },
    cookies: { getAll: () => [], set: () => {} },
    method,
    headers: new Headers(),
  }) as any

beforeEach(() => {
  vi.clearAllMocks()
  role = 'member'
  member = true
  features = {}
  grants = []
  defaults = []
  getUser.mockResolvedValue({ data: { user: { id: 'u1' } } })
  getAuthenticatorAssuranceLevel.mockResolvedValue({ data: null })
  stubRpc()
})

describe('middleware API gate — closes routes that never checked role themselves', () => {
  it('blocks a viewer from POSTing a deal, which the route itself would allow', () => {
    // app/api/deals/route.ts does a membership lookup and stops — a viewer can create a deal
    // today. The boundary refuses before the handler ever runs.
    role = 'viewer'
    features = { deals: 'everyone' }
    return expect(middleware(req('/api/deals', 'POST'))).resolves.toMatchObject({ status: 403 })
  })

  it('blocks a member with no grant from reading GP carry', async () => {
    features = { gp_economics: 'everyone' }
    defaults = [{ domain: 'gp_economics', level: 'none' }]
    const res = await middleware(req('/api/accounting/deal-carry'))
    expect(res.status).toBe(403)
    expect(await res.json()).toMatchObject({ error: expect.stringContaining('GP economics') })
  })

  it('lets a granted member read GP carry', async () => {
    features = { gp_economics: 'everyone' }
    grants = [{ domain: 'gp_economics', level: 'read' }]
    const res = await middleware(req('/api/accounting/deal-carry'))
    expect(res.status).not.toBe(403)
  })

  it('lets a granted member read but not write', async () => {
    features = { accounting: 'everyone' }
    grants = [{ domain: 'accounting', level: 'read' }]
    expect((await middleware(req('/api/accounting/journal'))).status).not.toBe(403)
    expect((await middleware(req('/api/accounting/journal', 'POST'))).status).toBe(403)
  })

  it('blocks a hidden area at the API, not just in the nav — the gap being closed', async () => {
    // The old behaviour: "Hidden — removed from sidebar, still accessible via URL". A member with
    // a write grant could curl the API all day.
    features = { interactions: 'hidden' }
    grants = [{ domain: 'relationships', level: 'write' }]
    expect((await middleware(req('/api/interactions'))).status).toBe(403)
    expect((await middleware(req('/api/companies/c1/interactions'))).status).toBe(403)
  })

  it('blocks a hidden area for an admin too', async () => {
    role = 'admin'
    features = { accounting: 'hidden' }
    expect((await middleware(req('/api/accounting/journal'))).status).toBe(403)
  })

  it('uses the route\'s own feature key, so sibling features gate independently', async () => {
    // Both routes are in `relationships`, but a fund can switch interactions off and leave notes on.
    features = { interactions: 'off', notes: 'everyone' }
    grants = [{ domain: 'relationships', level: 'write' }]
    expect((await middleware(req('/api/interactions'))).status).toBe(403)
    expect((await middleware(req('/api/notes'))).status).not.toBe(403)
  })
})

describe('middleware API gate — what it must not break', () => {
  it('lets an admin through everywhere that is switched on', async () => {
    role = 'admin'
    features = { accounting: 'admin', gp_economics: 'admin', deals: 'admin' }
    expect((await middleware(req('/api/accounting/journal', 'POST'))).status).not.toBe(403)
    expect((await middleware(req('/api/accounting/gp-economics'))).status).not.toBe(403)
    expect((await middleware(req('/api/deals', 'POST'))).status).not.toBe(403)
  })

  it('lets any member reach their own data and the Analyst, with no grants at all', async () => {
    // The Analyst gates each domain block internally; gating the route on one domain would deny a
    // member who holds a different one.
    expect((await middleware(req('/api/analyst', 'POST'))).status).not.toBe(403)
    expect((await middleware(req('/api/analyst/conversations'))).status).not.toBe(403)
    expect((await middleware(req('/api/settings/theme', 'PATCH'))).status).not.toBe(403)
    expect((await middleware(req('/api/settings'))).status).not.toBe(403)
  })

  it('leaves credential-authenticated surfaces alone — they gate per tool', async () => {
    expect((await middleware(req('/api/mcp', 'POST'))).status).not.toBe(403)
    expect((await middleware(req('/api/agent', 'POST'))).status).not.toBe(403)
  })

  it('leaves the LP portal to its own identity model', async () => {
    expect((await middleware(req('/api/portal/overview'))).status).not.toBe(403)
  })

  it('does not gate a signed-out request — the route answers 401 itself', async () => {
    getUser.mockResolvedValue({ data: { user: null } })
    expect((await middleware(req('/api/accounting/journal'))).status).not.toBe(403)
  })

  it('refuses a domain route when access_context is empty: no membership, or access that has expired', async () => {
    // access_context returns NULL once fund_members.access_expires_at passes, while the row itself
    // survives until the hourly sweep. Handlers only check fund_members and rely on this gate for the
    // domain, so letting a NULL through handed an expired member every route this gate protects.
    // Routes that serve non-members are UNGATED or `level: 'any'` and never reach this check.
    member = false
    expect((await middleware(req('/api/accounting/journal'))).status).toBe(403)
    expect((await middleware(req('/api/portal/overview'))).status).not.toBe(403)
  })

  it('resolves access in ONE round trip — this runs on every API request', async () => {
    // The gate is on the hot path, so its cost is the app's cost. It used to take four PostgREST
    // calls across two sequential round trips; access_context does the join server-side.
    features = { accounting: 'everyone' }
    grants = [{ domain: 'accounting', level: 'read' }]
    await middleware(req('/api/accounting/journal'))
    expect(rpc).toHaveBeenCalledTimes(1)
    expect(rpc).toHaveBeenCalledWith('access_context', {})
    expect(from).not.toHaveBeenCalled()
  })

  it('costs nothing at all for an "any" route — no query before the level check', async () => {
    await middleware(req('/api/analyst', 'POST'))
    expect(rpc).not.toHaveBeenCalled()
  })

  it('404s an /api path the registry has never heard of, rather than passing it through', async () => {
    const res = await middleware(req('/api/not-a-real-route'))
    expect(res.status).toBe(404)
  })
})
