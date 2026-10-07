import { describe, it, expect } from 'vitest'
import { companyIdForRoute, companyEntityDenial } from './entity-gate'

describe('companyIdForRoute — which company a request is about', () => {
  it('reads the company from a company route', () => {
    expect(companyIdForRoute('api/companies/[id]/investments', '/api/companies/c1/investments')).toBe('c1')
    expect(companyIdForRoute('api/companies/[id]', '/api/companies/c1')).toBe('c1')
  })

  it('reads the company from a fund holding route — a fund holding is a company row', () => {
    expect(companyIdForRoute('api/portfolio/fund-holdings/[id]/nav', '/api/portfolio/fund-holdings/c2/nav')).toBe('c2')
  })

  it('is null for a route about no single company', () => {
    expect(companyIdForRoute('api/companies', '/api/companies')).toBeNull()
    expect(companyIdForRoute('api/deals/[id]', '/api/deals/d1')).toBeNull()
  })
})

/** The user's own client: RLS on company_vehicles already limits rows to their entities. */
function client(visibleLinks: { company_id: string }[]) {
  const chain: any = {
    select: () => chain,
    eq: (_k: string, v: string) => { chain.id = v; return chain },
    limit: () => chain,
    then: (res: any) => res({ data: visibleLinks.filter(l => l.company_id === chain.id), error: null }),
  }
  return { from: () => chain } as any
}

describe('companyEntityDenial — the gate for every /api/companies/[id]/** route', () => {
  const member = { vehicles: { all: false, ids: ['v1'] } }

  it('lets a caller who sees every entity through without a query', async () => {
    const supabase = { from: () => { throw new Error('should not query') } } as any
    expect(await companyEntityDenial(supabase, 'api/companies/[id]', '/api/companies/c9', { vehicles: { all: true, ids: [] } })).toBeNull()
  })

  it('lets a member reach a company one of their entities holds', async () => {
    expect(await companyEntityDenial(client([{ company_id: 'c1' }]), 'api/companies/[id]', '/api/companies/c1', member)).toBeNull()
  })

  it('answers 404 for a company none of their entities holds — not 403, which would confirm it exists', async () => {
    const r = await companyEntityDenial(client([]), 'api/companies/[id]/investments', '/api/companies/c2/investments', member)
    expect(r?.status).toBe(404)
  })

  it('ignores routes about no single company', async () => {
    expect(await companyEntityDenial(client([]), 'api/companies', '/api/companies', member)).toBeNull()
  })
})
