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

import { dealIdForRoute, dealEntityDenial } from './entity-gate'

describe('dealEntityDenial — the gate for every /api/deals/[id]/** route', () => {
  const deals = (rows: { id: string; vehicle_id: string | null }[]) => {
    const chain: any = {
      select: () => chain,
      eq: (_k: string, v: string) => { chain.id = v; return chain },
      maybeSingle: async () => ({ data: rows.find(r => r.id === chain.id) ?? null, error: null }),
    }
    return { from: () => chain } as any
  }
  const member = { vehicles: { all: false, ids: ['v1'] } }

  it('reads the deal from deal routes only', () => {
    expect(dealIdForRoute('api/deals/[id]/research', '/api/deals/d1/research')).toBe('d1')
    expect(dealIdForRoute('api/deals/manual', '/api/deals/manual')).toBeNull()
  })

  it('lets a member reach a deal owned by their entity', async () => {
    expect(await dealEntityDenial(deals([{ id: 'd1', vehicle_id: 'v1' }]), 'api/deals/[id]', '/api/deals/d1', member)).toBeNull()
  })

  it('answers 404 for a deal of another entity, or one no entity owns yet', async () => {
    expect((await dealEntityDenial(deals([{ id: 'd1', vehicle_id: 'v2' }]), 'api/deals/[id]', '/api/deals/d1', member))?.status).toBe(404)
    expect((await dealEntityDenial(deals([{ id: 'd1', vehicle_id: null }]), 'api/deals/[id]', '/api/deals/d1', member))?.status).toBe(404)
  })

  it('lets a caller who sees everything through without a query', async () => {
    const none = { from: () => { throw new Error('should not query') } } as any
    expect(await dealEntityDenial(none, 'api/deals/[id]', '/api/deals/d1', { vehicles: { all: true, ids: [] } })).toBeNull()
  })
})

import { letterEntityDenial } from './entity-gate'
describe('letterEntityDenial — the gate for every /api/lp-letters/[id]/** route', () => {
  // The caller's client: RLS on lp_letters returns only their entities' letters.
  const client = (visible: string[]) => {
    const chain: any = {
      select: () => chain,
      eq: (_k: string, v: string) => { chain.id = v; return chain },
      maybeSingle: async () => ({ data: visible.includes(chain.id) ? { id: chain.id } : null, error: null }),
    }
    return { from: () => chain } as any
  }
  const member = { vehicles: { all: false, ids: ['v1'] } }

  it('lets a member reach a letter their entity\'s', async () => {
    expect(await letterEntityDenial(client(['l1']), 'api/lp-letters/[id]/generate', '/api/lp-letters/l1/generate', member)).toBeNull()
  })
  it('answers 404 for another entity\'s letter', async () => {
    expect((await letterEntityDenial(client([]), 'api/lp-letters/[id]', '/api/lp-letters/l2', member))?.status).toBe(404)
  })
  it('ignores the list route and letter templates', async () => {
    expect(await letterEntityDenial(client([]), 'api/lp-letters', '/api/lp-letters', member)).toBeNull()
    expect(await letterEntityDenial(client([]), 'api/lp-letters/templates/[id]', '/api/lp-letters/templates/t1', member)).toBeNull()
  })
})

import { rowCompanyDenial } from './entity-gate'
describe('rowCompanyDenial — routes about one email, metric, review or note', () => {
  // The caller's client: `rows` answers the table lookup; `links` is company_vehicles under RLS.
  const client = (rows: Record<string, { company_id: string | null } | null>, links: string[]) => {
    const from = (t: string) => {
      const chain: any = {
        select: () => chain, limit: () => chain,
        eq: (_k: string, v: string) => { chain.v = v; return chain },
        maybeSingle: async () => ({ data: rows[chain.v] ?? null, error: null }),
        then: (res: any) => res({ data: t === 'company_vehicles' && links.includes(chain.v) ? [{ company_id: chain.v }] : [], error: null }),
      }
      return chain
    }
    return { from } as any
  }
  const member = { vehicles: { all: false, ids: ['v1'] } }

  it('lets a member reach an email about a company their entity holds', async () => {
    expect(await rowCompanyDenial(client({ e1: { company_id: 'c1' } }, ['c1']), 'api/emails/[id]/reviews', '/api/emails/e1/reviews', member)).toBeNull()
  })
  it('answers 404 for an email about a company they cannot see', async () => {
    expect((await rowCompanyDenial(client({ e1: { company_id: 'c2' } }, ['c1']), 'api/emails/[id]', '/api/emails/e1', member))?.status).toBe(404)
  })
  it('answers 404 for an email matched to no company — admins triage those', async () => {
    expect((await rowCompanyDenial(client({ e1: { company_id: null } }, []), 'api/emails/[id]', '/api/emails/e1', member))?.status).toBe(404)
  })
  it('lets a member reach a fund-wide note (no company)', async () => {
    expect(await rowCompanyDenial(client({ n1: { company_id: null } }, []), 'api/dashboard/notes/[noteId]', '/api/dashboard/notes/n1', member)).toBeNull()
  })
  it('lets a caller who sees every entity through without a query', async () => {
    const none = { from: () => { throw new Error('should not query') } } as any
    expect(await rowCompanyDenial(none, 'api/metrics/[id]', '/api/metrics/m1', { vehicles: { all: true, ids: [] } })).toBeNull()
  })
})
