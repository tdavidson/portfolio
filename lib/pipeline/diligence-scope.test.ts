import { describe, it, expect } from 'vitest'
import { loadActiveDiligenceDeals } from './matchDiligenceDeal'

const deals = [
  { id: 'g1', name: 'Acme', aliases: [], vehicle_id: 'v1' },
  { id: 'g2', name: 'Beta', aliases: [], vehicle_id: 'v2' },
]
const supabase = {
  from: (t: string) => {
    const f: Array<(r: any) => boolean> = []
    const chain: any = {
      select: () => chain, eq: () => chain, limit: () => chain,
      in: (k: string, v: any[]) => { f.push(r => v.includes(r[k])); return chain },
      then: (res: any) => res({ data: t === 'diligence_deals' ? deals.filter(r => f.every(x => x(r))) : [], error: null }),
    }
    return chain
  },
} as any

describe('loadActiveDiligenceDeals — what a forwarded email may route to', () => {
  it('a forwarding member: only diligence in their entities', async () => {
    expect((await loadActiveDiligenceDeals(supabase, 'f1', ['v1'])).map(d => d.name)).toEqual(['Acme'])
  })
  it('anyone else (the fund inbox): every active record', async () => {
    expect((await loadActiveDiligenceDeals(supabase, 'f1', null)).length).toBe(2)
  })
})
