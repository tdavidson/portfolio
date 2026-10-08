// tests/review-list-fund.test.ts
import { describe, expect, it, vi } from 'vitest'
import { memoryAdmin } from '@/tests/helpers/memory-admin'

const s = vi.hoisted(() => ({ m: null as any }))
vi.mock('@/lib/supabase/server', () => ({ createClient: async () => ({ auth: { getUser: async () => ({ data: { user: { id: 'u' } } }) }, from: (t: string) => s.m.admin.from(t) }) }))
vi.mock('@/lib/supabase/admin', () => ({ createAdminClient: () => s.m.admin }))
vi.mock('@/lib/access/entity-scope', () => ({
  loadEntityScopeForUser: async () => ({ access: { vehicles: { all: false, ids: ['v1'] } }, companyIds: ['h1'], vehicleNames: ['Fund I'] }),
}))
import { GET } from '@/app/api/review/route'

describe('the review queue', () => {
  it('shows a member their entity\'s fund reviews with the proposal, and not another entity\'s or an unassigned one', async () => {
    s.m = memoryAdmin({
      parsing_reviews: [
        { id: 'r1', fund_id: 'f', company_id: 'h1', vehicle_id: 'v1', issue_type: 'fund_nav', resolution: null, payload: { kind: 'nav' } },
        { id: 'r2', fund_id: 'f', company_id: 'h1', vehicle_id: 'v2', issue_type: 'fund_nav', resolution: null, payload: { kind: 'nav' } },
        { id: 'r3', fund_id: 'f', company_id: 'h1', vehicle_id: null, issue_type: 'fund_capital_call', resolution: null, payload: { kind: 'call' } },
        { id: 'r4', fund_id: 'f', company_id: 'h1', vehicle_id: null, issue_type: 'low_confidence', resolution: null, payload: null },
      ],
      inbound_emails: [],
    })
    const json = await (await GET()).json()
    expect(json.items.map((i: any) => i.id).sort()).toEqual(['r1', 'r4'])
    expect(json.items.find((i: any) => i.id === 'r1').payload).toEqual({ kind: 'nav' })
  })
})
