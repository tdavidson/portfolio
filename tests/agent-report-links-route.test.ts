import { beforeEach, describe, expect, it, vi } from 'vitest'
import { NextRequest } from 'next/server'
import type { AccessContext, AccessLevel } from '@/lib/access/effective'
import type { Domain } from '@/lib/access/domains'
import { DEFAULT_FEATURE_VISIBILITY, type FeatureVisibilityMap } from '@/lib/types/features'
import { memoryAdmin } from './helpers/memory-admin'

/**
 * The download behind a document link an assistant handed over. The link names the member and the
 * document; everything else is decided again at the click, against their access NOW.
 */

process.env.ENCRYPTION_KEY = process.env.ENCRYPTION_KEY || 'test-key-for-report-links'

let access: AccessContext
let agentOn = true
const store = memoryAdmin({
  fund_members: [{ fund_id: 'fund-1', user_id: 'user-me', role: 'member' }],
  fund_vehicles: [
    { id: 'v1', fund_id: 'fund-1', name: 'Fund I', active: true, kind: 'fund', aliases: null },
    { id: 'v2', fund_id: 'fund-1', name: 'Fund II', active: true, kind: 'fund', aliases: null },
  ],
})
const statementPdf = vi.fn(async () => ({ pdf: Buffer.from('%PDF-statement'), fileName: 'Acme LP - Capital Account Statement - Q3 2026.pdf', partnerName: 'Acme LP' }))
const cardPdf = vi.fn(async () => ({ pdf: Buffer.from('%PDF-card'), fileName: 'Acme - Capital Statement.pdf' }))

vi.mock('@/lib/supabase/admin', () => ({ createAdminClient: () => store.admin }))
vi.mock('@/lib/oauth/enabled', () => ({ agentApiEnabled: async () => agentOn }))
vi.mock('@/lib/rate-limit', () => ({ rateLimit: async () => null }))
vi.mock('@/lib/access/effective', async importOriginal => ({
  ...(await importOriginal<typeof import('@/lib/access/effective')>()),
  loadAccessContext: async () => access,
}))
vi.mock('@/lib/access/entity-scope', () => ({
  entityScopeFor: async (_: unknown, a: AccessContext) => ({ access: a, vehicleNames: a.vehicles.all ? null : ['Fund I'], companyIds: null }),
}))
vi.mock('@/lib/access/lp-scope', () => ({
  visibleLpEntityIds: async (_: unknown, scope: { vehicleNames: string[] | null }) => (scope.vehicleNames === null ? null : ['ent-1']),
}))
vi.mock('@/lib/accounting/lp-statement-pdf', () => ({ generateLpStatementPdf: (...a: unknown[]) => (statementPdf as any)(...a) }))
vi.mock('@/lib/lp-report-pdf', () => ({ generateLiveInvestorReportPdf: (...a: unknown[]) => (cardPdf as any)(...a) }))

import { GET } from '@/app/api/agent/reports/[token]/route'
import { signReportLink } from '@/lib/agent/report-links'

const member = (grants: Partial<Record<Domain, AccessLevel>>, all = true): AccessContext => ({
  fundId: 'fund-1', userId: 'user-me', vehicles: { all, ids: all ? [] : ['v1'] }, role: 'member',
  features: Object.fromEntries(Object.keys(DEFAULT_FEATURE_VISIBILITY).map(k => [k, 'everyone'])) as FeatureVisibilityMap,
  grants, defaults: {},
})

const statement = (lp = 'ent-1', vehicle = 'Fund I') => signReportLink({
  fundId: 'fund-1', userId: 'user-me', kind: 'lp_statement',
  args: { vehicle, lp, start: '2026-07-01', end: '2026-09-30', label: 'Q3 2026' },
}).token
const card = () => signReportLink({ fundId: 'fund-1', userId: 'user-me', kind: 'lp_report_card', args: { investor: 'inv-1' } }).token

const open = (token: string) => GET(new NextRequest(`https://fund.test/api/agent/reports/${token}`), { params: Promise.resolve({ token }) })

beforeEach(() => {
  access = member({ lp_capital: 'read' })
  agentOn = true
  store.tables.fund_members = [{ fund_id: 'fund-1', user_id: 'user-me', role: 'member' }]
  vi.clearAllMocks()
})

describe('a document link', () => {
  it('opens the capital account statement it names, for the period it was made for', async () => {
    const res = await open(statement())
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toBe('application/pdf')
    expect(res.headers.get('cache-control')).toContain('no-store')
    expect(statementPdf).toHaveBeenCalledWith(store.admin, expect.objectContaining({
      fundId: 'fund-1', group: 'Fund I', lpEntityId: 'ent-1',
      period: expect.objectContaining({ start: '2026-07-01', end: '2026-09-30', label: 'Q3 2026' }),
    }))
  })

  it('opens a report card of every vehicle — or only the entities a scoped member can see', async () => {
    access = member({ lp_capital: 'read', gp_economics: 'read' })
    expect((await open(card())).status).toBe(200)
    expect(cardPdf).toHaveBeenLastCalledWith(store.admin, { fundId: 'fund-1', investorIds: ['inv-1'], groups: null })
    access = member({ lp_capital: 'read', gp_economics: 'read' }, false)
    expect((await open(card())).status).toBe(200)
    expect(cardPdf).toHaveBeenLastCalledWith(store.admin, { fundId: 'fund-1', investorIds: ['inv-1'], groups: ['Fund I'] })
  })

  it('stops working when the member loses the grant, the fund, or agent access', async () => {
    access = member({})
    expect((await open(card())).status).toBe(404)
    access = member({ lp_capital: 'read' })
    agentOn = false
    expect((await open(card())).status).toBe(404)
    agentOn = true
    store.tables.fund_members = []
    expect((await open(statement())).status).toBe(404)
    expect(statementPdf).not.toHaveBeenCalled()
    expect(cardPdf).not.toHaveBeenCalled()
  })

  it('refuses a vehicle or an LP outside a scoped member\'s entities', async () => {
    access = member({ lp_capital: 'read' }, false)
    expect((await open(statement('ent-1', 'Fund II'))).status).toBe(404)
    expect((await open(statement('ent-9', 'Fund I'))).status).toBe(404)
    expect(statementPdf).not.toHaveBeenCalled()
  })

  it("without gp_economics: no carry recipient's statement, and no position on which an investor earns carry", async () => {
    store.tables.vehicle_waterfall_terms = [{ fund_id: 'fund-1', vehicle_id: 'v1', kind: 'european', carry_rate: 0.2, gp_entity_id: null, carry_recipients: [{ lpEntityId: 'ent-gp', pct: 100 }] }]
    try {
      expect((await open(statement('ent-gp'))).status).toBe(404)
      expect((await open(statement('ent-1'))).status).toBe(200)   // an LP's statement, carry charge and all
      expect((await open(card())).status).toBe(200)
      const omit = (cardPdf.mock.calls.at(-1) as any)[1].omit as Map<string, Set<string>>
      expect([...omit.get('Fund I')!]).toEqual(['ent-gp'])
      access = member({ lp_capital: 'read', gp_economics: 'read' })
      expect((await open(statement('ent-gp'))).status).toBe(200)
    } finally {
      store.tables.vehicle_waterfall_terms = []
    }
  })

  it('refuses anything not signed here', async () => {
    expect((await open('nope')).status).toBe(404)
    expect((await open(`${statement()}x`)).status).toBe(404)
  })
})
