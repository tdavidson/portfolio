import { describe, it, expect } from 'vitest'
import { buildDealContext } from './context-builder'

const deals: Record<string, any> = {
  d1: { id: 'd1', fund_id: 'f1', email_id: 'e1', company_name: 'Acme', vehicle_id: 'v1', prior_deal_id: 'd0' },
  d0: { id: 'd0', fund_id: 'f1', company_name: 'Acme (2025)', vehicle_id: 'v2', status: 'passed', thesis_fit_score: 'weak', created_at: '2025-03-01' },
}
const admin = {
  from: (t: string) => {
    let id: string | null = null
    const chain: any = {
      select: () => chain,
      eq: (k: string, v: any) => { if (k === 'id') id = v; return chain },
      maybeSingle: async () => ({ data: t === 'inbound_deals' ? deals[id!] ?? null : null, error: null }),
    }
    return chain
  },
} as any

describe('buildDealContext — a prior pitch is shown only when its entity is the caller\'s', () => {
  it('omits a prior pitch owned by another entity', async () => {
    const ctx = await buildDealContext(admin, 'd1', { vehicles: { all: false, ids: ['v1'] } })
    expect(ctx!.dealBlock).not.toContain('Prior pitch')
  })
  it('shows it to a caller who can see it', async () => {
    const ctx = await buildDealContext(admin, 'd1', { vehicles: { all: true, ids: [] } })
    expect(ctx!.dealBlock).toContain('Prior pitch from same founder/company: Acme (2025) (status: passed')
  })
})
