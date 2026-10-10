import { describe, expect, it, vi } from 'vitest'
import { memoryAdmin } from '../../../tests/helpers/memory-admin'

// Unscoped (null) or one company (c1): the member-entity question is entity-scope's, tested there.
let companyIds: string[] | null = null
vi.mock('@/lib/access/entity-scope', () => ({ entityScopeFor: async () => ({ vehicleNames: null, companyIds }) }))
// The memory client has no `.or`; the scoped case only needs "their companies", which `.in` gives.
vi.mock('@/lib/access/scope', () => ({ filterByCompany: (q: any, ids: string[] | null) => (ids === null ? q : q.in('company_id', ids)) }))

import { loadInteractionsPage } from './load'

const C1 = '11111111-1111-4111-8111-111111111111'
const C2 = '22222222-2222-4222-8222-222222222222'
const { admin } = memoryAdmin({
  companies: [{ id: C1, fund_id: 'f1', name: 'Acme' }, { id: C2, fund_id: 'f1', name: 'Borealis' }],
  interactions: [
    { id: 'i1', fund_id: 'f1', company_id: C1, subject: 'Acme intro', interaction_date: '2026-10-01' },
    { id: 'i2', fund_id: 'f1', company_id: C2, subject: 'Borealis hiring', interaction_date: '2026-10-02' },
    { id: 'i3', fund_id: 'f1', company_id: null, subject: 'LP lunch', interaction_date: '2026-10-03' },
  ],
})
const ctx = { admin, supabase: admin, user: { id: 'u1' }, page: { fundId: 'f1', access: {} } } as any
const subjects = (d: any) => d.interactions.map((i: any) => i.subject)

describe("a company page's View all", () => {
  it("lists that company's interactions, and names it", async () => {
    companyIds = null
    const data = await loadInteractionsPage(ctx, C1)
    expect(subjects(data)).toEqual(['Acme intro'])
    expect(data.company).toEqual({ id: C1, name: 'Acme' })
  })

  it('lists everything without one', async () => {
    companyIds = null
    const data = await loadInteractionsPage(ctx)
    expect(subjects(data)).toEqual(['LP lunch', 'Borealis hiring', 'Acme intro'])
    expect(data.company).toBeNull()
  })

  it("ignores a company outside the member's entities, or a malformed id — the ordinary list, not a confirmation", async () => {
    companyIds = [C1]
    for (const id of [C2, 'not-a-uuid']) {
      const data = await loadInteractionsPage(ctx, id)
      expect(data.company).toBeNull()
      expect(subjects(data)).not.toContain('Borealis hiring')
    }
  })
})
