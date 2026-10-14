import { describe, it, expect, vi, beforeEach } from 'vitest'

/**
 * Activating an LP portal account binds an auth user to an invited lp_accounts row. The two
 * branches worth pinning are the ones an attacker would try: binding by email when the address
 * has not been confirmed, and binding an account that already belongs to someone else.
 */

const getUser = vi.hoisted(() => vi.fn())
const from = vi.hoisted(() => vi.fn())
const logLpAccessEvent = vi.hoisted(() => vi.fn(async () => {}))

vi.mock('@/lib/supabase/server', () => ({ createClient: () => ({ auth: { getUser } }) }))
vi.mock('@/lib/supabase/admin', () => ({ createAdminClient: () => ({ from }) }))
vi.mock('@/lib/lp-access-log', () => ({ logLpAccessEvent }))

import { POST } from '@/app/api/portal/activate/route'

type Account = { id: string; status: string; auth_user_id: string | null; email: string }
let accounts: Account[] = []
let updates: { id: string; patch: Record<string, unknown> }[] = []

function stub() {
  from.mockImplementation((table: string) => {
    if (table === 'lp_accounts') {
      const filters: Record<string, string> = {}
      const chain: any = {
        select: () => chain,
        eq: (col: string, val: string) => { filters[col] = val; return chain },
        maybeSingle: async () => {
          const hit = accounts.find(a =>
            (filters.auth_user_id ? a.auth_user_id === filters.auth_user_id : true) &&
            (filters.email ? a.email === filters.email : true) &&
            (filters.auth_user_id || filters.email),
          )
          return { data: hit ? { id: hit.id, status: hit.status, auth_user_id: hit.auth_user_id } : null, error: null }
        },
        update: (patch: Record<string, unknown>) => ({
          eq: async (_col: string, id: string) => { updates.push({ id, patch }); return { error: null } },
        }),
      }
      return chain
    }
    // lp_account_links
    const chain: any = {
      select: () => chain,
      eq: async () => ({ data: [{ fund_id: 'fund-1' }], error: null }),
    }
    return chain
  })
}

beforeEach(() => {
  vi.clearAllMocks()
  accounts = []
  updates = []
  stub()
})

describe('POST /api/portal/activate', () => {
  it('does not bind by email when the address is unconfirmed', async () => {
    accounts = [{ id: 'a1', status: 'invited', auth_user_id: null, email: 'lp@example.com' }]
    getUser.mockResolvedValue({ data: { user: { id: 'u1', email: 'lp@example.com', email_confirmed_at: null } } })
    const res = await POST()
    expect(res.status).toBe(403)
    expect(updates).toHaveLength(0)
  })

  it('binds and activates by confirmed email, and records the activation as a login', async () => {
    accounts = [{ id: 'a1', status: 'invited', auth_user_id: null, email: 'lp@example.com' }]
    getUser.mockResolvedValue({ data: { user: { id: 'u1', email: 'LP@example.com', email_confirmed_at: '2026-09-01T00:00:00Z' } } })
    const res = await POST()
    expect(res.status).toBe(200)
    expect(updates).toEqual([{ id: 'a1', patch: expect.objectContaining({ auth_user_id: 'u1', status: 'active' }) }])
    expect(logLpAccessEvent).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      fundId: 'fund-1', lpAccountId: 'a1', authUserId: 'u1', eventType: 'login', targetType: 'portal', metadata: { activation: true },
    }))
  })

  it('refuses to re-enable an account a GP disabled, whether bound or still unbound', async () => {
    accounts = [{ id: 'a1', status: 'disabled', auth_user_id: 'u1', email: 'lp@example.com' }]
    getUser.mockResolvedValue({ data: { user: { id: 'u1', email: 'lp@example.com', email_confirmed_at: '2026-09-01T00:00:00Z' } } })
    expect((await POST()).status).toBe(403)

    accounts = [{ id: 'a2', status: 'disabled', auth_user_id: null, email: 'lp2@example.com' }]
    getUser.mockResolvedValue({ data: { user: { id: 'u2', email: 'lp2@example.com', email_confirmed_at: '2026-09-01T00:00:00Z' } } })
    expect((await POST()).status).toBe(403)
    expect(updates).toHaveLength(0)
  })

  it('refuses to take over an account bound to a different user', async () => {
    accounts = [{ id: 'a1', status: 'invited', auth_user_id: 'someone-else', email: 'lp@example.com' }]
    getUser.mockResolvedValue({ data: { user: { id: 'u1', email: 'lp@example.com', email_confirmed_at: '2026-09-01T00:00:00Z' } } })
    const res = await POST()
    expect(res.status).toBe(409)
    expect(updates).toHaveLength(0)
  })

  it('is a no-op for an account already active for this user', async () => {
    accounts = [{ id: 'a1', status: 'active', auth_user_id: 'u1', email: 'lp@example.com' }]
    getUser.mockResolvedValue({ data: { user: { id: 'u1', email: 'lp@example.com', email_confirmed_at: '2026-09-01T00:00:00Z' } } })
    const res = await POST()
    expect(res.status).toBe(200)
    expect(updates).toHaveLength(0)
    expect(logLpAccessEvent).not.toHaveBeenCalled()
  })

  it('refuses to re-bind an active account with no auth user (needs a re-invite)', async () => {
    accounts = [{ id: 'a1', status: 'active', auth_user_id: null, email: 'lp@example.com' }]
    getUser.mockResolvedValue({ data: { user: { id: 'u1', email: 'lp@example.com', email_confirmed_at: '2026-09-01T00:00:00Z' } } })
    const res = await POST()
    expect(res.status).toBe(409)
    expect(updates).toHaveLength(0)
  })
})
