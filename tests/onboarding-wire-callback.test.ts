import { describe, it, expect, vi, beforeEach } from 'vitest'

/**
 * Wire instructions are the one onboarding document a fund pays money against, so verifying
 * them is not "the file looks right": it is a callback to a known number. The route refuses to
 * verify wire instructions without the callback, writes it into the item's note, and the batch
 * sorter files them as submitted rather than verified. And when an LP replaces verified wire
 * instructions, the fund is told loudly.
 */

const getUser = vi.hoisted(() => vi.fn())
const from = vi.hoisted(() => vi.fn())
const loadAccessContext = vi.hoisted(() => vi.fn())
const hasAccess = vi.hoisted(() => vi.fn(() => true))
const emailLpReview = vi.hoisted(() => vi.fn(async () => ({ sent: true })))

vi.mock('@/lib/supabase/server', () => ({ createClient: () => ({ auth: { getUser } }) }))
vi.mock('@/lib/supabase/admin', () => ({ createAdminClient: () => ({ from }) }))
vi.mock('@/lib/access/effective', () => ({ loadAccessContext, hasAccess }))
vi.mock('@/lib/lp-onboarding-notify', () => ({ emailLpReview }))

import { PATCH } from '@/app/api/lps/onboarding/route'

// Entity scope: these tests exercise the route's own rules, as a caller who sees every entity.
// The entity rule itself is tested in lib/access/lp-scope.test.ts.
const lpScope = vi.hoisted(() => ({ entityIds: null as string[] | null, investorIds: null as string[] | null }))
vi.mock('@/lib/access/lp-scope', async (orig) => ({
  ...(await orig<typeof import('@/lib/access/lp-scope')>()),
  loadLpScope: async () => ({ scope: { vehicleNames: null } as any, entityIds: lpScope.entityIds, investorIds: lpScope.investorIds }),
}))


let inserted: Record<string, Record<string, unknown>[]> = {}
let upserted: Record<string, unknown>[] = []

function stub() {
  from.mockImplementation((table: string) => {
    const filters: Record<string, unknown> = {}
    const chain: any = {
      select: () => chain,
      eq: (c: string, v: unknown) => { filters[c] = v; return chain },
      maybeSingle: async () => {
        if (table === 'fund_members') return { data: { fund_id: 'fund-1', role: 'admin' }, error: null }
        if (table === 'lp_entities') return { data: filters.id === 'ent-1' ? { id: 'ent-1', entity_name: 'Acme', investor_id: 'inv-1' } : null, error: null }
        if (table === 'lp_onboarding_items') return { data: { id: 'item-1', status: 'submitted' }, error: null }
        return { data: null, error: null }
      },
      insert: (row: Record<string, unknown>) => {
        ;(inserted[table] ??= []).push(row)
        return { select: () => ({ single: async () => ({ data: { id: 'x' }, error: null }) }) }
      },
      upsert: (row: Record<string, unknown>) => {
        upserted.push(row)
        return { select: () => ({ single: async () => ({ data: { id: 'item-1', status: row.status, document_id: 'doc-7' }, error: null }) }) }
      },
    }
    return chain
  })
}

const req = (body: Record<string, unknown>) => ({ json: async () => body }) as any

beforeEach(() => {
  vi.clearAllMocks()
  inserted = {}; upserted = []
  getUser.mockResolvedValue({ data: { user: { id: 'admin-1' } } })
  loadAccessContext.mockResolvedValue({ fundId: 'fund-1' })
  stub()
})

describe('PATCH /api/lps/onboarding verifying wire instructions', () => {
  it('refuses to verify without a callback', async () => {
    const res = await PATCH(req({ lp_entity_id: 'ent-1', kind: 'wire_instructions', status: 'verified' }))
    expect(res.status).toBe(400)
    expect((await res.json()).error).toMatch(/callback/i)
    expect(upserted).toHaveLength(0)
  })

  it('refuses a callback missing who was spoken to, the number, or the date', async () => {
    for (const callback of [{ phone: '+1 212 555 0100', spoke_on: '2026-09-20' }, { contact: 'Pat Lee', spoke_on: '2026-09-20' }, { contact: 'Pat Lee', phone: '+1 212 555 0100' }, { contact: 'Pat Lee', phone: '+1 212 555 0100', spoke_on: 'yesterday' }]) {
      const res = await PATCH(req({ lp_entity_id: 'ent-1', kind: 'wire_instructions', status: 'verified', callback }))
      expect(res.status).toBe(400)
    }
    expect(upserted).toHaveLength(0)
  })

  it('verifies with the callback written into the note, ahead of any note of the reviewer\'s', async () => {
    const res = await PATCH(req({ lp_entity_id: 'ent-1', kind: 'wire_instructions', status: 'verified', callback: { contact: ' Pat Lee ', phone: '+1 212 555 0100', spoke_on: '2026-09-20' }, note: 'Matches the sub doc.' }))
    expect(res.status).toBe(200)
    expect(upserted).toEqual([expect.objectContaining({
      kind: 'wire_instructions', status: 'verified', reviewed_by: 'admin-1',
      note: 'Callback verified: spoke with Pat Lee at +1 212 555 0100 on 2026-09-20. Matches the sub doc.',
    })])
    expect(inserted.lp_onboarding_events).toEqual([expect.objectContaining({ action: 'verified', note: expect.stringMatching(/^Callback verified: spoke with Pat Lee/) })])
  })

  it('needs no callback to send back, waive, or verify anything else', async () => {
    expect((await PATCH(req({ lp_entity_id: 'ent-1', kind: 'wire_instructions', status: 'rejected', note: 'Bank name is missing' }))).status).toBe(200)
    expect((await PATCH(req({ lp_entity_id: 'ent-1', kind: 'wire_instructions', status: 'waived' }))).status).toBe(200)
    expect((await PATCH(req({ lp_entity_id: 'ent-1', kind: 'side_letter', status: 'verified' }))).status).toBe(200)
    expect(upserted).toHaveLength(3)
  })
})
