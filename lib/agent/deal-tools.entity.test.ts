import { describe, it, expect } from 'vitest'
import { DEALS_HANDLERS } from './deals-tools'
import { DILIGENCE_HANDLERS } from './diligence-tools'

const inbound = [
  { id: 'd1', company_name: 'Acme', vehicle_id: 'v1', created_at: '2026-01-01' },
  { id: 'd2', company_name: 'Beta', vehicle_id: 'v2', created_at: '2026-01-02' },
  { id: 'd3', company_name: 'Gamma', vehicle_id: null, created_at: '2026-01-03' },
]
const diligence = inbound.map(d => ({ id: 'g' + d.id.slice(1), name: d.company_name, vehicle_id: d.vehicle_id, aliases: [] }))

function admin() {
  return {
    from(table: string) {
      const src: any[] = table === 'inbound_deals' ? inbound : table === 'diligence_deals' ? diligence : []
      const filters: Array<(r: any) => boolean> = []
      let single = false
      const chain: any = {
        select: () => chain, order: () => chain, limit: () => chain,
        eq: (k: string, v: any) => { if (k !== 'fund_id') filters.push(r => r[k] === v); return chain },
        in: (k: string, v: any[]) => { filters.push(r => v.includes(r[k])); return chain },
        ilike: (k: string, p: string) => { const re = new RegExp('^' + p.replace(/%/g, '.*') + '$', 'i'); filters.push(r => re.test(r[k])); return chain },
        maybeSingle: () => { single = true; return chain },
        then: (res: any) => { const rows = src.filter(r => filters.every(f => f(r))); return res({ data: single ? rows[0] ?? null : rows, error: null }) },
      }
      return chain
    },
  } as any
}

const ctx = (access: any) => ({ admin: admin(), fundId: 'f1', portfolioGroup: '', userId: 'u1', access })
const member = { fundId: 'f1', vehicles: { all: false, ids: ['v1'] } }
const everyone = { fundId: 'f1', vehicles: { all: true, ids: [] } }

describe('deal agent tools — the caller\'s entities only', () => {
  it('lists only inbound deals owned by their entities (not other entities\', not unassigned)', async () => {
    const rows = await DEALS_HANDLERS.deals_list_inbound(ctx(member), {}) as any[]
    expect(rows.map(r => r.company)).toEqual(['Acme'])
    expect((await DEALS_HANDLERS.deals_list_inbound(ctx(everyone), {}) as any[]).length).toBe(3)
  })
  it('treats another entity\'s inbound deal as unknown, by id or by name', async () => {
    await expect(DEALS_HANDLERS.deals_inbound_detail(ctx(member), { deal: 'd2' })).rejects.toThrow(/No inbound deal/)
    await expect(DEALS_HANDLERS.deals_inbound_detail(ctx(member), { deal: 'Beta' })).rejects.toThrow(/No inbound deal for "Beta" in this fund/)
  })
  it('lists only diligence records owned by their entities', async () => {
    const rows = await DILIGENCE_HANDLERS.diligence_list_deals(ctx(member), {}) as any[]
    expect(rows.map(r => r.name)).toEqual(['Acme'])
  })
  it('never resolves or names another entity\'s diligence record', async () => {
    await expect(DILIGENCE_HANDLERS.diligence_deal_detail(ctx(member), { deal: 'g2' })).rejects.toThrow(/This fund has: Acme$/)
    await expect(DILIGENCE_HANDLERS.diligence_deal_detail(ctx(member), { deal: 'Gamma' })).rejects.not.toThrow(/Gamma.*Gamma/)
  })
})
