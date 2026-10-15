import { beforeEach, describe, expect, it, vi } from 'vitest'
const s = vi.hoisted(() => ({ user: { id: 'u1' } as { id: string } | null, rpc: vi.fn(), table: vi.fn(), scope: vi.fn() }))
vi.mock('@/lib/supabase/server', () => ({ createClient: async () => ({
  auth: { getUser: async () => ({ data: { user: s.user } }) }, rpc: s.rpc,
}) }))
vi.mock('@/lib/supabase/admin', () => ({ createAdminClient: () => ({}) }))
vi.mock('@/lib/access/entity-scope', () => ({ entityScopeFor: s.scope }))
vi.mock('@/lib/dashboard/table', () => ({ loadDashboardTable: s.table }))
import { GET } from './route'

beforeEach(() => {
  s.user = { id: 'u1' }
  s.rpc.mockReset().mockResolvedValue({ data: { fund_id: 'f1', role: 'member', grants: { portfolio: 'read' }, vehicles: ['v1'], vehicles_all: false } })
  s.scope.mockReset().mockResolvedValue({ companyIds: ['c1'], vehicleNames: ['Fund I'] })
  s.table.mockReset().mockResolvedValue([{ id: 'c1' }])
})

describe('dashboard table access', () => {
  it('authenticates before any access/data query', async () => {
    s.user = null
    expect((await GET()).status).toBe(401)
    expect(s.rpc).not.toHaveBeenCalled()
    expect(s.table).not.toHaveBeenCalled()
  })

  it('uses a single live membership/grants RPC and passes scoped inputs to the loader', async () => {
    expect(await (await GET()).json()).toEqual({ companies: [{ id: 'c1' }] })
    expect(s.rpc).toHaveBeenCalledExactlyOnceWith('access_context', {})
    expect(s.scope.mock.calls[0][1]).toMatchObject({ fundId: 'f1', vehicles: { ids: ['v1'], all: false } })
    expect(s.table.mock.calls[0][1]).toEqual({ companyIds: ['c1'], vehicleNames: ['Fund I'] })
  })

  it('applies revoked grants on the next request, without reading table data', async () => {
    expect((await GET()).status).toBe(200)
    s.rpc.mockResolvedValue({ data: { fund_id: 'f1', role: 'member', grants: {} } })
    expect((await GET()).status).toBe(403)
    expect(s.table).toHaveBeenCalledTimes(1)
  })

  it('fails closed on unavailable access context', async () => {
    s.rpc.mockResolvedValue({ data: null, error: { message: 'private detail' } })
    expect((await GET()).status).toBe(500)
    expect(s.table).not.toHaveBeenCalled()
  })
})
