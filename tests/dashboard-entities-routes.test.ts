import { describe, it, expect, vi, beforeEach } from 'vitest'

// The dashboard's entity selection: a person writes only their own preference, and only ids of
// entities they can see; the fund default is admin-only.

const m = vi.hoisted(() => ({
  user: { id: 'u1' } as { id: string } | null,
  role: 'member',
  access: { vehicles: { all: false, ids: ['v1', 'v2'] } } as any,
  upserts: [] as { table: string; row: any; opts: any }[],
  updates: [] as { table: string; row: any; eqs: [string, unknown][] }[],
  deletes: [] as { table: string; eqs: [string, unknown][] }[],
  fundDefault: ['v3'] as string[],
}))

function chain(table: string) {
  const eqs: [string, unknown][] = []
  let op: 'select' | 'update' | 'delete' = 'select'
  let updateRow: any = null
  const c: any = {
    select: () => c,
    in: () => c,
    eq: (k: string, v: unknown) => { eqs.push([k, v]); return c },
    update: (row: any) => { op = 'update'; updateRow = row; return c },
    delete: () => { op = 'delete'; return c },
    upsert: async (row: any, opts: any) => { m.upserts.push({ table, row, opts }); return { error: null } },
    maybeSingle: async () => ({
      data: table === 'fund_members' ? { fund_id: 'f1', role: m.role }
        : table === 'fund_settings' ? { dashboard_excluded_vehicle_ids: m.fundDefault } : null,
      error: null,
    }),
    then: (res: any) => {
      if (op === 'update') m.updates.push({ table, row: updateRow, eqs })
      if (op === 'delete') m.deletes.push({ table, eqs })
      const data = table === 'fund_vehicles' ? [{ id: 'v1' }, { id: 'v2' }, { id: 'v3' }] : []
      return res({ data, error: null })
    },
  }
  return c
}

vi.mock('@/lib/supabase/server', () => ({ createClient: async () => ({ auth: { getUser: async () => ({ data: { user: m.user } }) } }) }))
vi.mock('@/lib/supabase/admin', () => ({ createAdminClient: () => ({ from: (t: string) => chain(t) }) }))
vi.mock('@/lib/access/entity-scope', () => ({ loadEntityScope: async () => ({ access: m.access, vehicleNames: [], companyIds: [] }) }))
vi.mock('@/lib/access/effective', async (orig) => ({ ...(await orig<any>()), loadAccessContext: async () => ({ fundId: 'f1', vehicles: { all: true, ids: [] } }) }))
vi.mock('@/lib/dashboard/entity-selection-load', () => ({
  loadActiveEntityOptions: async () => [{ id: 'v3', name: '3SE Holdings LP', names: ['3SE Holdings LP'] }],
  loadFundDefaultExcluded: async () => m.fundDefault,
}))
vi.mock('@/lib/cache/tags', () => ({ expireTag: () => {} }))

import { PUT as putMine, DELETE as deleteMine } from '@/app/api/dashboard/entities/route'
import { GET as getDefault, PUT as putDefault } from '@/app/api/settings/dashboard-entities/route'

const req = (body: unknown) => new Request('http://x', { method: 'PUT', body: JSON.stringify(body) }) as any

beforeEach(() => {
  m.user = { id: 'u1' }; m.role = 'member'; m.fundDefault = ['v3']
  m.upserts = []; m.updates = []; m.deletes = []
})

describe('PUT/DELETE /api/dashboard/entities — the caller\'s own selection', () => {
  it('requires a signed-in user', async () => {
    m.user = null
    expect((await putMine(req({ excluded: [] }))).status).toBe(401)
    expect((await deleteMine()).status).toBe(401)
    expect(m.upserts).toEqual([])
  })

  it('saves to the caller\'s own row, keyed on the session user — never one the body names', async () => {
    const res = await putMine(req({ excluded: ['v2'], user_id: 'someone-else' }))
    expect(res.status).toBe(200)
    expect(m.upserts).toHaveLength(1)
    expect(m.upserts[0].table).toBe('dashboard_preferences')
    expect(m.upserts[0].row).toMatchObject({ user_id: 'u1', fund_id: 'f1', excluded_vehicle_ids: ['v2'] })
    expect(m.upserts[0].opts).toEqual({ onConflict: 'user_id' })
  })

  it('drops ids of entities the caller cannot see, or that are not the fund\'s', async () => {
    await putMine(req({ excluded: ['v1', 'v3', 'other-fund'] }))
    expect(m.upserts[0].row.excluded_vehicle_ids).toEqual(['v1'])
  })

  it('the read-only demo (viewer) applies its selection but never stores it: one shared login, one row', async () => {
    m.role = 'viewer'
    const res = await putMine(req({ excluded: ['v2'] }))
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true, excluded: ['v2'], saved: false })
    expect(m.upserts).toEqual([])
    const del = await deleteMine()
    expect(del.status).toBe(200)
    expect(m.deletes).toEqual([])
  })

  it('rejects a body that is not a list of ids', async () => {
    expect((await putMine(req({ excluded: 'v1' }))).status).toBe(400)
    expect((await putMine(req({ excluded: [1] }))).status).toBe(400)
    expect(m.upserts).toEqual([])
  })

  it('DELETE forgets only the caller\'s row and returns the fund default to fall back to — only the ids they can see', async () => {
    m.fundDefault = ['v1', 'v3']
    const res = await deleteMine()
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true, fundDefault: ['v1'] })
    expect(m.deletes).toEqual([{ table: 'dashboard_preferences', eqs: [['user_id', 'u1']] }])
  })
})

describe('/api/settings/dashboard-entities — the fund default', () => {
  it('requires a signed-in user', async () => {
    m.user = null
    expect((await getDefault()).status).toBe(401)
    expect((await putDefault(req({ excluded: [] }))).status).toBe(401)
  })

  it('is admin-only, read and write', async () => {
    m.role = 'member'
    expect((await getDefault()).status).toBe(403)
    expect((await putDefault(req({ excluded: ['v3'] }))).status).toBe(403)
    expect(m.updates).toEqual([])
  })

  it('an admin reads the options and the current default', async () => {
    m.role = 'admin'
    const res = await getDefault()
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ options: [{ id: 'v3', name: '3SE Holdings LP', names: ['3SE Holdings LP'] }], excluded: ['v3'] })
  })

  it('an admin sets it on their own fund, keeping only the fund\'s entity ids', async () => {
    m.role = 'admin'
    const res = await putDefault(req({ excluded: ['v3', 'not-ours'] }))
    expect(res.status).toBe(200)
    expect(m.updates).toEqual([{ table: 'fund_settings', row: { dashboard_excluded_vehicle_ids: ['v3'] }, eqs: [['fund_id', 'f1']] }])
  })

  it('rejects a body that is not a list of ids', async () => {
    m.role = 'admin'
    expect((await putDefault(req({ excluded: null }))).status).toBe(400)
  })
})
