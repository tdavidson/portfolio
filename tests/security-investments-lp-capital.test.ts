import { describe, it, expect, vi } from 'vitest'
import { NextRequest } from 'next/server'
import { memoryAdmin } from '@/tests/helpers/memory-admin'
import { DEFAULT_FEATURE_VISIBILITY } from '@/lib/types/features'

/**
 * /api/portfolio/investments is gated on portfolio + investments, but a deal vehicle with no
 * recorded holdings is carried at its LPs' paid-in, distributions and NAV — partner capital, the
 * figures /api/lps/live-report serves under `lp_capital`. A portfolio-only member must not get them
 * through this side door, neither as a row nor folded into the portfolio totals.
 */
const s = vi.hoisted(() => ({ m: null as any, grants: {} as Record<string, string>, liveCalls: 0 }))
vi.mock('@/lib/supabase/server', () => ({ createClient: async () => ({ auth: { getUser: async () => ({ data: { user: { id: 'u' } } }) } }) }))
vi.mock('@/lib/supabase/admin', () => ({ createAdminClient: () => s.m.admin }))
vi.mock('@/lib/access/entity-scope', () => ({ loadEntityScopeForUser: async () => ({ access: {}, vehicleNames: null, writableNames: null, companyIds: null }) }))
vi.mock('@/lib/access/effective', async orig => ({
  ...(await orig<typeof import('@/lib/access/effective')>()),
  loadAccessContext: async () => ({
    fundId: 'f', userId: 'u', role: 'member',
    features: { ...DEFAULT_FEATURE_VISIBILITY, investments: 'everyone', lps: 'everyone', lp_tracking: 'everyone', accounting: 'everyone' },
    grants: s.grants, defaults: {}, vehicles: { all: true, ids: [] },
  }),
}))
vi.mock('@/lib/accounting/live-report', () => ({
  generateLiveReport: async () => {
    s.liveCalls++
    return { rows: [{ portfolio_group: 'Deal SPV', paid_in_capital: 1_000_000, distributions: 250_000, nav: 900_000 }] }
  },
}))
import { GET } from '@/app/api/portfolio/investments/route'

function setup(grants: Record<string, string>) {
  s.grants = grants
  s.liveCalls = 0
  s.m = memoryAdmin({
    fund_members: [{ user_id: 'u', fund_id: 'f', role: 'member' }],
    companies: [],
    investment_transactions: [],
    fund_vehicles: [{ id: 'v1', fund_id: 'f', name: 'Deal SPV', kind: 'spv', active: true }],
  })
}

describe('GET /api/portfolio/investments — deal-vehicle LP figures', () => {
  it('omits the LP-position row and its totals for a caller without lp_capital', async () => {
    setup({ portfolio: 'read' })
    const body = await (await GET(new NextRequest('http://x/api/portfolio/investments'))).json()
    expect(body.companies.find((c: any) => c.companyName === 'Deal SPV')).toBeUndefined()
    expect(JSON.stringify(body)).not.toContain('1000000')
    expect(JSON.stringify(body)).not.toContain('900000')
    expect(s.liveCalls).toBe(0)
  })

  it('includes it for a caller who can read partner capital', async () => {
    setup({ portfolio: 'read', lp_capital: 'read' })
    const body = await (await GET(new NextRequest('http://x/api/portfolio/investments'))).json()
    const row = body.companies.find((c: any) => c.companyName === 'Deal SPV')
    expect(row).toMatchObject({ holdingType: 'vehicle', totalInvested: 1_000_000, totalRealized: 250_000, fmv: 900_000 })
  })
})
