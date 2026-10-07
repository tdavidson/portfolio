import { describe, it, expect, vi, beforeEach } from 'vitest'

/**
 * Filing a sorted batch is the one place a reviewer's confirmation turns uploads into records.
 * What it must hold: paths stay inside this fund's folder, entities are this fund's, every row
 * has an entity and a kind, the document is investor-scoped and unindexed, the item is verified
 * by the caller, and discards are actually deleted.
 */

const getUser = vi.hoisted(() => vi.fn())
const from = vi.hoisted(() => vi.fn())
const storageRemove = vi.hoisted(() => vi.fn(async () => ({ error: null })))
const storageDownload = vi.hoisted(() => vi.fn())

vi.mock('@/lib/supabase/server', () => ({ createClient: () => ({ auth: { getUser } }) }))
vi.mock('@/lib/supabase/admin', () => ({
  createAdminClient: () => ({ from, storage: { from: () => ({ remove: storageRemove, download: storageDownload }) } }),
}))

import { POST } from '@/app/api/lps/onboarding/sort/confirm/route'

// Entity scope: these tests exercise the route's own rules, as a caller who sees every entity.
// The entity rule itself is tested in lib/access/lp-scope.test.ts.
const lpScope = vi.hoisted(() => ({ entityIds: null as string[] | null, investorIds: null as string[] | null }))
vi.mock('@/lib/access/lp-scope', async (orig) => ({
  ...(await orig<typeof import('@/lib/access/lp-scope')>()),
  loadLpScope: async () => ({ scope: {} as any, entityIds: lpScope.entityIds, investorIds: lpScope.investorIds }),
}))


let inserted: Record<string, Record<string, unknown>[]> = {}
let upserted: Record<string, unknown>[] = []
let fundEntities: { id: string; investor_id: string; entity_name: string }[] = []

function stub() {
  from.mockImplementation((table: string) => {
    const filters: Record<string, unknown> = {}
    const chain: any = {
      select: () => chain,
      eq: (c: string, v: unknown) => { filters[c] = v; return chain },
      in: (c: string, v: unknown) => { filters[`in:${c}`] = v; return chain },
      maybeSingle: async () => {
        if (table === 'fund_members') return { data: { fund_id: 'fund-1', role: 'admin' }, error: null }
        return { data: null, error: null }
      },
      then: (resolve: (v: unknown) => void) => {
        if (table === 'lp_entities') {
          const wanted = (filters['in:id'] as string[]) ?? []
          resolve({ data: fundEntities.filter(e => wanted.includes(e.id) && filters.fund_id === 'fund-1'), error: null })
        } else resolve({ data: [], error: null })
      },
      insert: (row: Record<string, unknown>) => {
        ;(inserted[table] ??= []).push(row)
        const p: any = Promise.resolve({ data: null, error: null })
        p.select = () => ({ single: async () => ({ data: { id: `doc-${inserted[table].length}` }, error: null }) })
        return p
      },
      upsert: (row: Record<string, unknown>) => {
        if (table === 'lp_onboarding_items') upserted.push(row)
        else (inserted[table] ??= []).push(row)
        return { select: () => ({ single: async () => ({ data: { id: `item-${upserted.length}` }, error: null }) }) }
      },
    }
    return chain
  })
}

const req = (body: Record<string, unknown>) => ({ json: async () => body }) as any
const row = (over: Record<string, unknown> = {}) => ({
  storage_path: 'fund-1/123_sub.pdf', file_name: 'sub.pdf', mime_type: 'application/pdf', size_bytes: 1000,
  lp_entity_id: 'ent-1', kind: 'subscription_agreement', doc_date: '2026-06-12', ...over,
})

beforeEach(() => {
  vi.clearAllMocks()
  inserted = {}; upserted = []
  fundEntities = [{ id: 'ent-1', investor_id: 'inv-1', entity_name: 'Acme Capital LP' }]
  getUser.mockResolvedValue({ data: { user: { id: 'admin-1' } } })
  storageRemove.mockResolvedValue({ error: null })
  storageDownload.mockResolvedValue({ data: { arrayBuffer: async () => new TextEncoder().encode('%PDF-1.4 executed').buffer }, error: null })
  stub()
})

describe('POST /api/lps/onboarding/sort/confirm', () => {
  it('files a confirmed row as an investor-scoped, unindexed document and a verified item, and deletes discards', async () => {
    const res = await POST(req({ rows: [row()], discard: ['fund-1/456_junk.jpg'] }))
    expect(res.status).toBe(200)
    expect(inserted.lp_documents).toEqual([expect.objectContaining({
      fund_id: 'fund-1', scope: 'investor', category: 'Onboarding', doc_date: '2026-06-12', title: 'Subscription agreement — Acme Capital LP', uploaded_by: 'admin-1',
    })])
    expect(inserted.lp_documents[0]).not.toHaveProperty('extracted_text')
    expect(inserted.lp_document_shares).toEqual([expect.objectContaining({ document_id: 'doc-1', lp_investor_id: 'inv-1', fund_id: 'fund-1' })])
    expect(upserted).toEqual([expect.objectContaining({
      fund_id: 'fund-1', lp_entity_id: 'ent-1', kind: 'subscription_agreement', status: 'verified', document_id: 'doc-1', reviewed_by: 'admin-1', submitted_by_account: null,
    })])
    expect(storageRemove).toHaveBeenCalledWith(['fund-1/456_junk.jpg'])
    expect(await res.json()).toMatchObject({ ok: true, discarded: 1 })
    expect(inserted.lp_onboarding_item_documents).toEqual([expect.objectContaining({ item_id: 'item-1', document_id: 'doc-1', added_by_user: 'admin-1' })])
    expect(inserted.lp_onboarding_events).toEqual([expect.objectContaining({ action: 'filed', to_status: 'verified', actor_user_id: 'admin-1' })])
  })

  it('rejects a row that fails the safety scan, deletes it, and files nothing', async () => {
    storageDownload.mockResolvedValue({ data: { arrayBuffer: async () => new TextEncoder().encode('X5O!P%@AP[4\\PZX54(P^)7CC)7}$EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*').buffer }, error: null })
    const res = await POST(req({ rows: [row()] }))
    expect(res.status).toBe(400)
    expect(storageRemove).toHaveBeenCalledWith(['fund-1/123_sub.pdf'])
    expect(inserted.lp_documents).toBeUndefined()
  })

  it('refuses a path outside the fund\'s folder, for a row or a discard', async () => {
    expect((await POST(req({ rows: [row({ storage_path: 'fund-2/123_sub.pdf' })] }))).status).toBe(400)
    expect((await POST(req({ rows: [], discard: ['fund-2/456_junk.jpg'] }))).status).toBe(400)
    expect(inserted.lp_documents).toBeUndefined()
    expect(storageRemove).not.toHaveBeenCalled()
  })

  it('refuses an entity that is not the fund\'s', async () => {
    const res = await POST(req({ rows: [row({ lp_entity_id: 'ent-other' })] }))
    expect(res.status).toBe(400)
    expect(inserted.lp_documents).toBeUndefined()
  })

  it('refuses a row with no entity or an unknown kind', async () => {
    expect((await POST(req({ rows: [row({ lp_entity_id: '' })] }))).status).toBe(400)
    expect((await POST(req({ rows: [row({ kind: 'bank_statement' })] }))).status).toBe(400)
    expect(upserted).toHaveLength(0)
  })
})
