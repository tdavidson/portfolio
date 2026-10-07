import { describe, it, expect, vi } from 'vitest'

const loadEntityScopeForUser = vi.hoisted(() => vi.fn())
vi.mock('@/lib/access/entity-scope', () => ({ loadEntityScopeForUser }))

import { companiesForSender } from './processEmail'

const companies = [{ id: 'c1', name: 'Acme', aliases: [] }, { id: 'c2', name: 'Beta', aliases: [] }]
const supabase = {
  from: () => {
    const chain: any = { select: () => chain, eq: () => chain, then: (res: any) => res({ data: companies, error: null }) }
    return chain
  },
} as any

describe('companiesForSender — what an inbound email may attach to', () => {
  it('a member who forwarded it: only the companies of their entities', async () => {
    loadEntityScopeForUser.mockResolvedValue({ companyIds: ['c1'], vehicleNames: ['Fund I'] })
    expect((await companiesForSender(supabase, 'f1', { userId: 'u1' })).map(c => c.name)).toEqual(['Acme'])
  })
  it('an unscoped member: every company', async () => {
    loadEntityScopeForUser.mockResolvedValue({ companyIds: null, vehicleNames: null })
    expect((await companiesForSender(supabase, 'f1', { userId: 'u1' })).length).toBe(2)
  })
  it('a member whose membership vanished: nothing', async () => {
    loadEntityScopeForUser.mockResolvedValue(null)
    expect(await companiesForSender(supabase, 'f1', { userId: 'u1' })).toEqual([])
  })
  it('not a member (a founder writing in): every company — the fund\'s inbox, not a person\'s', async () => {
    loadEntityScopeForUser.mockClear()
    expect((await companiesForSender(supabase, 'f1', null)).length).toBe(2)
    expect(loadEntityScopeForUser).not.toHaveBeenCalled()
  })
})
