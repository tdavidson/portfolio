import { describe, it, expect, vi } from 'vitest'

const m = vi.hoisted(() => ({ live: vi.fn() }))
vi.mock('@/lib/accounting/live-report', () => ({ generateLiveReport: m.live }))
// A member granted Fund I: LP entity e1 (Cranmore) has a position there; e2 (Aldis) only in Fund II.
vi.mock('@/lib/access/entity-scope', () => ({
  entityScopeFor: async (_a: any, access: any) => access.vehicles.all
    ? { access, vehicleNames: null, companyIds: null }
    : { access, vehicleNames: ['Fund I'], companyIds: [] },
}))
vi.mock('@/lib/access/lp-scope', async orig => ({
  ...(await orig<typeof import('@/lib/access/lp-scope')>()),
  visibleLpEntityIds: async (_a: any, scope: any) => scope.vehicleNames === null ? null : ['e1'],
}))

import { LP_HANDLERS } from './lp-tools'

const entities = [
  { id: 'e1', entity_name: 'Cranmore Trust', investor_id: 'i1', lp_investors: { id: 'i1', name: 'Cranmore' } },
  { id: 'e2', entity_name: 'Aldis Family Office', investor_id: 'i2', lp_investors: { id: 'i2', name: 'Aldis' } },
]
const stored = [
  { entity_id: 'e1', portfolio_group: 'Fund I', commitment: 100, nav: 10 },
  { entity_id: 'e2', portfolio_group: 'Fund II', commitment: 999, nav: 99 },
]
const admin = {
  from: (t: string) => {
    const data = t === 'lp_entities' ? entities : t === 'lp_snapshots' ? [{ id: 's1', name: 'Q2', as_of_date: '2026-06-30' }] : t === 'lp_investments' ? stored : []
    const chain: any = { select: () => chain, eq: () => chain, in: () => chain, then: (res: any) => res({ data, error: null }) }
    return chain
  },
} as any

const live = () => ({
  asOf: '2026-06-30',
  rows: stored.map(r => ({ ...r, commitment: r.commitment + 20, paid_in_capital: 0, distributions: 0, outstanding_balance: 0 })),
  vehicles: [{ group: 'Fund I', source: 'ledger', lps: 1 }, { group: 'Fund II', source: 'ledger', lps: 1 }],
  entityNames: new Map([['e1', 'Cranmore Trust'], ['e2', 'Aldis Family Office']]),
})
const member = { fundId: 'f1', vehicles: { all: false, ids: ['v1'] } }
const ctx = { admin, fundId: 'f1', portfolioGroup: '', userId: 'u1', access: member } as any
const hidden = /Aldis|Fund II|999/

describe('LP agent tools — the caller\'s entities only', () => {
  it('lp_list_investors lists only LPs with a position in their entities', async () => {
    expect(JSON.stringify(await LP_HANDLERS.lp_list_investors(ctx, {}))).not.toMatch(hidden)
  })
  it('lp_reconcile_snapshot compares only their entities\' rows', async () => {
    m.live.mockResolvedValue(live())
    const out = JSON.stringify(await LP_HANDLERS.lp_reconcile_snapshot(ctx, {}))
    expect(out).toContain('Cranmore')
    expect(out).not.toMatch(hidden)
  })
  it('lp_live_report does not list other entities in its provenance', async () => {
    m.live.mockResolvedValue(live())
    expect(JSON.stringify(await LP_HANDLERS.lp_live_report(ctx, {}))).not.toMatch(hidden)
  })
  it('resolving an LP name never matches, or names, an LP they cannot see', async () => {
    m.live.mockResolvedValue(live())
    await expect(LP_HANDLERS.lp_live_report(ctx, { lp: 'Aldis' })).rejects.toThrow(/No LP matching "Aldis"/)
  })
})

describe('LP document links', () => {
  it('issues a report card link for an investor they can see, on the origin they reached, scoped to their entities', async () => {
    process.env.ENCRYPTION_KEY = process.env.ENCRYPTION_KEY || 'test-key-for-report-links'
    const { verifyReportLink } = await import('./report-links')
    const out = await LP_HANDLERS.lp_report_card_pdf({ ...ctx, origin: 'https://fund.test' }, { investor: 'Cranmore' })
    expect(out).toMatchObject({ investor: 'Cranmore', vehicles: ['Fund I'] })
    expect(out.url).toMatch(/^https:\/\/fund\.test\/api\/agent\/reports\//)
    expect(verifyReportLink(out.url.split('/').pop())).toMatchObject({ fundId: 'f1', userId: 'u1', kind: 'lp_report_card', args: { investor: 'i1' } })
  })
  it('never issues one for an LP outside their entities, or for a credential with no member', async () => {
    await expect(LP_HANDLERS.lp_report_card_pdf(ctx, { investor: 'Aldis' })).rejects.toThrow(/No LP matching "Aldis"/)
    await expect(LP_HANDLERS.lp_report_card_pdf({ ...ctx, userId: null }, { investor: 'Cranmore' })).rejects.toThrow(/signed-in member/)
  })
})
