import { describe, it, expect } from 'vitest'
import { resolveCompany, executeRecordInvestment, PORTFOLIO_HANDLERS } from './portfolio-tools'

// companies: Acme (linked to v1), Beta (linked to v2). company_vehicles drives visibility.
const companies = [{ id: 'c1', name: 'Acme', fund_id: 'f1', portfolio_group: ['Fund I', 'Fund II'] }, { id: 'c2', name: 'Beta', fund_id: 'f1' }]
const links = [{ company_id: 'c1', vehicle_id: 'v1' }, { company_id: 'c2', vehicle_id: 'v2' }]
const vehicles = [{ id: 'v1', name: 'Fund I', aliases: [] }, { id: 'v2', name: 'Fund II', aliases: [] }]

function admin() {
  return {
    from(table: string) {
      const filters: Array<(r: any) => boolean> = []
      let single = false
      const rows = () => (table === 'companies' ? companies : table === 'company_vehicles' ? links : table === 'fund_vehicles' ? vehicles : [])
        .filter(r => filters.every(f => f(r)))
      const chain: any = {
        select: () => chain,
        eq: (k: string, v: any) => { if (k !== 'fund_id') filters.push(r => r[k] === v); return chain },
        in: (k: string, v: any[]) => { filters.push(r => v.includes(r[k])); return chain },
        ilike: (k: string, p: string) => { const re = new RegExp('^' + p.replace(/%/g, '.*') + '$', 'i'); filters.push(r => re.test(r[k])); return chain },
        limit: () => chain,
        maybeSingle: () => { single = true; return chain },
        then: (res: any) => res({ data: single ? rows()[0] ?? null : rows(), error: null }),
      }
      return chain
    },
  } as any
}

const member = { fundId: 'f1', vehicles: { all: false, ids: ['v1'] } } as any

describe('portfolio agent tools — the caller\'s entities only', () => {
  it('resolves a company linked to one of their entities', async () => {
    expect((await resolveCompany(admin(), 'f1', 'acme', member)).id).toBe('c1')
  })
  it('treats a company outside their entities as unknown, by name or by id, and never suggests it', async () => {
    await expect(resolveCompany(admin(), 'f1', 'Beta', member)).rejects.toThrow(/No company named "Beta" in this fund/)
    await expect(resolveCompany(admin(), 'f1', 'c2', member)).rejects.toThrow(/No company named/)
    await expect(resolveCompany(admin(), 'f1', 'et', member)).rejects.not.toThrow(/Beta/)
  })
  it('refuses to record an investment into an entity they cannot see', async () => {
    await expect(executeRecordInvestment({ admin: admin(), fundId: 'f1', userId: 'u1', access: member },
      { company: 'Acme', vehicle: 'Fund II', transaction_type: 'investment', transaction_date: '2026-01-01' }))
      .rejects.toThrow(/entit/i)
  })
  it('company_detail names only their entities for a shared company', async () => {
    const out: any = await PORTFOLIO_HANDLERS.company_detail({ admin: admin(), fundId: 'f1', portfolioGroup: '', userId: 'u1', access: member }, { company: 'Acme' })
    expect(out.vehicles).toEqual(['Fund I'])
  })
})
