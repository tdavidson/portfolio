import { describe, it, expect, vi, beforeEach } from 'vitest'

/**
 * The profile route writes two tables from one body. It must write the fund's own entity and
 * that entity's own investor — never an investor named in the body — and record an exclusion
 * change in the audit trail.
 */

const getUser = vi.hoisted(() => vi.fn())
const from = vi.hoisted(() => vi.fn())

vi.mock('@/lib/supabase/server', () => ({ createClient: () => ({ auth: { getUser } }) }))
vi.mock('@/lib/supabase/admin', () => ({ createAdminClient: () => ({ from }) }))

import { PATCH } from '@/app/api/lps/entities/profile/route'

// Entity scope: these tests exercise the route's own rules, as a caller who sees every entity.
// The entity rule itself is tested in lib/access/lp-scope.test.ts.
const lpScope = vi.hoisted(() => ({ entityIds: null as string[] | null, investorIds: null as string[] | null }))
vi.mock('@/lib/access/lp-scope', async (orig) => ({
  ...(await orig<typeof import('@/lib/access/lp-scope')>()),
  loadLpScope: async () => ({ scope: { vehicleNames: null } as any, entityIds: lpScope.entityIds, investorIds: lpScope.investorIds }),
}))


let updates: { table: string; patch: Record<string, unknown>; filters: Record<string, unknown> }[] = []
let inserted: Record<string, Record<string, unknown>[]> = {}

function stub() {
  from.mockImplementation((table: string) => {
    const filters: Record<string, unknown> = {}
    const chain: any = {
      select: () => chain,
      eq: (c: string, v: unknown) => { filters[c] = v; return chain },
      maybeSingle: async () => {
        if (table === 'fund_members') return { data: { fund_id: 'fund-1', role: 'admin' }, error: null }
        if (table === 'lp_entities') return { data: filters.id === 'ent-1' && filters.fund_id === 'fund-1' ? { id: 'ent-1', investor_id: 'inv-1', onboarding_excluded: false } : null, error: null }
        return { data: null, error: null }
      },
      single: async () => ({ data: { id: table === 'lp_entities' ? 'ent-1' : 'inv-1' }, error: null }),
      update: (patch: Record<string, unknown>) => {
        const u: any = {
          eq: (c: string, v: unknown) => { filters[c] = v; return u },
          then: (resolve: (v: unknown) => void) => { updates.push({ table, patch, filters: { ...filters } }); resolve({ error: null }) },
        }
        return u
      },
      insert: (row: Record<string, unknown>) => { (inserted[table] ??= []).push(row); return Promise.resolve({ error: null }) },
    }
    return chain
  })
}

const req = (body: Record<string, unknown>) => ({ json: async () => body }) as any

beforeEach(() => {
  vi.clearAllMocks()
  updates = []; inserted = {}
  getUser.mockResolvedValue({ data: { user: { id: 'admin-1' } } })
  stub()
})

describe('PATCH /api/lps/entities/profile', () => {
  it('writes the entity and its own investor, scoped to the fund', async () => {
    const res = await PATCH(req({ lp_entity_id: 'ent-1', entity: { entity_type: 'llc', city: 'Boston' }, investor: { contact_email: 'PAT@example.com' } }))
    expect(res.status).toBe(200)
    expect(updates).toEqual([
      expect.objectContaining({ table: 'lp_entities', patch: expect.objectContaining({ entity_type: 'llc', city: 'Boston' }), filters: { id: 'ent-1', fund_id: 'fund-1' } }),
      expect.objectContaining({ table: 'lp_investors', patch: expect.objectContaining({ contact_email: 'pat@example.com' }), filters: { id: 'inv-1', fund_id: 'fund-1' } }),
    ])
  })

  it('records an exclusion change in the audit trail, and only a change', async () => {
    await PATCH(req({ lp_entity_id: 'ent-1', entity: { onboarding_excluded: true } }))
    expect(inserted.lp_onboarding_events).toEqual([expect.objectContaining({ action: 'excluded', lp_entity_id: 'ent-1', actor_user_id: 'admin-1' })])
    inserted = {}
    await PATCH(req({ lp_entity_id: 'ent-1', entity: { onboarding_excluded: false } }))
    expect(inserted.lp_onboarding_events).toBeUndefined()
  })

  it('refuses a member an LP with no position in any of their entities, as not found', async () => {
    lpScope.entityIds = ['ent-2']
    try {
      expect((await PATCH(req({ lp_entity_id: 'ent-1', entity: { city: 'X' } }))).status).toBe(404)
    } finally { lpScope.entityIds = null }
  })

  it('refuses an entity outside the fund, a bad email, and an empty body', async () => {
    expect((await PATCH(req({ lp_entity_id: 'ent-9', entity: { city: 'X' } }))).status).toBe(404)
    expect((await PATCH(req({ lp_entity_id: 'ent-1', entity: { notice_email: 'nope' } }))).status).toBe(400)
    expect((await PATCH(req({ lp_entity_id: 'ent-1' }))).status).toBe(400)
    expect(updates).toHaveLength(0)
  })
})
