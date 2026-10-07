import { describe, it, expect } from 'vitest'
import { buildDiligenceContext } from './analyst-context'

const deals = [
  { name: 'Acme', vehicle_id: 'v1', deal_status: 'active', current_memo_stage: 'draft', created_at: '2026-01-01' },
  { name: 'Beta', vehicle_id: 'v2', deal_status: 'active', current_memo_stage: 'draft', created_at: '2026-01-02' },
  { name: 'Gamma', vehicle_id: null, deal_status: 'active', current_memo_stage: 'draft', created_at: '2026-01-03' },
]

function admin() {
  return {
    from() {
      const filters: Array<(r: any) => boolean> = []
      const chain: any = {
        select: () => chain, order: () => chain, eq: () => chain,
        in: (k: string, v: any[]) => { filters.push(r => v.includes(r[k])); return chain },
        then: (res: any) => res({ data: deals.filter(r => filters.every(f => f(r))), error: null }),
      }
      return chain
    },
  } as any
}

describe('buildDiligenceContext — the caller\'s entities only', () => {
  it('lists only records owned by their entities', async () => {
    const block = await buildDiligenceContext(admin(), 'f1', { vehicles: { all: false, ids: ['v1'] } })
    expect(block).toContain('Acme')
    expect(block).not.toMatch(/Beta|Gamma/)
    expect(block).toContain('PIPELINE: 1 deals')
  })
  it('lists every record for an unscoped caller', async () => {
    expect(await buildDiligenceContext(admin(), 'f1', { vehicles: { all: true, ids: [] } })).toContain('PIPELINE: 3 deals')
  })
})
