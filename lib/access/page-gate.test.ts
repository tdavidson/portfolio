import { beforeEach, describe, expect, it, vi } from 'vitest'

const rpc = vi.hoisted(() => vi.fn())
vi.mock('@/lib/supabase/server', () => ({ createClient: async () => ({ rpc }) }))

import { canViewPage, resolvePageAccess } from './page-gate'

const row = {
  fund_id: 'fund-1', role: 'member', features: {},
  grants: { portfolio: 'read' }, defaults: {}, vehicles: ['entity-1'], vehicles_all: false,
}

beforeEach(() => rpc.mockReset())

describe('live page access context', () => {
  it('resolves membership and entity/domain grants in one own-session RPC', async () => {
    rpc.mockResolvedValue({ data: row, error: null })
    const page = await resolvePageAccess('user-1')
    expect(rpc).toHaveBeenCalledExactlyOnceWith('access_context', {})
    expect(page).toMatchObject({ fundId: 'fund-1', role: 'member', isAdmin: false,
      access: { vehicles: { all: false, ids: ['entity-1'] } } })
    expect(canViewPage(page!, 'portfolio')).toBe(true)
    expect(canViewPage(page!, 'accounting')).toBe(false)
  })

  it('does not reuse revoked permissions on a subsequent resolution', async () => {
    rpc.mockResolvedValueOnce({ data: row }).mockResolvedValueOnce({ data: { ...row, grants: {} } })
    expect(canViewPage((await resolvePageAccess('user-1'))!, 'portfolio')).toBe(true)
    expect(canViewPage((await resolvePageAccess('user-1'))!, 'portfolio')).toBe(false)
  })

  it('returns no page context for a removed member', async () => {
    rpc.mockResolvedValue({ data: null, error: null })
    expect(await resolvePageAccess('user-1')).toBeNull()
  })

  it('fails closed on an RPC error, without treating it as absent membership', async () => {
    rpc.mockResolvedValue({ data: null, error: { message: 'sensitive provider detail' } })
    await expect(resolvePageAccess('user-1')).rejects.toThrow(/^Could not resolve access context$/)
  })

  it('honours hard feature denials for admins as well', async () => {
    rpc.mockResolvedValue({ data: { ...row, role: 'admin', features: { accounting: 'hidden' } } })
    const page = (await resolvePageAccess('user-1'))!
    expect(page.isAdmin).toBe(true)
    expect(canViewPage(page, 'accounting')).toBe(false)
  })
})
