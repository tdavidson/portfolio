import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { AccessContext, AccessLevel } from '@/lib/access/effective'
import type { Domain } from '@/lib/access/domains'
import { DEFAULT_FEATURE_VISIBILITY, type FeatureVisibilityMap } from '@/lib/types/features'
import { memoryAdmin } from '@/tests/helpers/memory-admin'

// The view builders compose handlers and loaders that read the database. Those are tested where
// they live; here they are stand-ins, so what is under test is the composition: which halves of
// a payload a caller gets, and what a saved dashboard may open.
const portfolioSummary = vi.fn(async (_ctx: unknown, input: any) => ({
  asOf: input?.as_of ?? '2026-10-09', vehicle: input?.vehicle ?? 'all',
  positions: [{ company: 'Acme', companyId: 'c1', status: 'active', stage: 'Seed', industry: [], cost: 100, fairValue: 250, unrealized: 150, realized: 0, moic: 2.5, pctOfPortfolio: 100 }],
  totals: { cost: 100, fairValue: 250, unrealized: 150, realized: 0, grossMoic: 2.5 },
}))
const fundPerformance = vi.fn(async () => [{ vehicle: 'Fund I', committed: 1000, called: 500, unfunded: 500, distributed: 50, nav: 700, dpi: 0.1, rvpi: 1.4, tvpi: 1.5 }])
const liveReport = vi.fn(async () => ({
  as_of: '2026-10-09',
  rows: [
    { investor: 'Alder', entity: 'Alder LP', vehicle: 'Fund I', commitment: 1000, paid_in_capital: 400, distributions: 100, nav: 500, dpi: 0.25, rvpi: 1.25, tvpi: 1.5, irr: 0.2 },
    { investor: 'Birch', entity: 'Birch LP', vehicle: 'Fund I', commitment: 3000, paid_in_capital: 600, distributions: 0, nav: 1500, dpi: 0, rvpi: 2.5, tvpi: 2.5, irr: null },
  ],
}))
// Partial mocks: the shared registry (imported below for the cross-checks) binds every handler
// in these maps, so the ones not stood in for stay the real functions.
vi.mock('./portfolio-tools', async importOriginal => {
  const real = await importOriginal<typeof import('./portfolio-tools')>()
  return { ...real, PORTFOLIO_HANDLERS: {
    ...real.PORTFOLIO_HANDLERS,
    portfolio_summary: (ctx: unknown, input: unknown) => portfolioSummary(ctx, input),
    fund_performance: () => fundPerformance(),
    company_detail: async () => ({ id: 'c1', name: 'Acme', stage: 'Seed', industry: ['AI'], status: 'active', vehicles: ['Fund I'], overview: null, summary: { totalInvested: 100, unrealizedValue: 250, totalRealized: 0, moic: 2.5, grossIrr: 0.3, rounds: [] } }),
    company_metrics: async () => ({ company: 'Acme', metrics: [
      { name: 'ARR', unit: '$', values: [{ period: 'Q1', value: 10 }, { period: 'Q2', value: 'n/a' }, { period: null, value: 30 }] },
      { name: 'Notes', unit: null, values: [{ period: 'Q1', value: 'strong quarter' }] },
    ] }),
  } }
})
vi.mock('./lp-tools', async importOriginal => {
  const real = await importOriginal<typeof import('./lp-tools')>()
  return { ...real, LP_HANDLERS: { ...real.LP_HANDLERS, lp_live_report: () => liveReport() } }
})
vi.mock('@/lib/accounting/vehicle-resolver', () => ({
  resolveVehicle: async (_a: unknown, _f: unknown, requested?: string) => requested ?? 'Fund I',
}))

const account = (over: Record<string, number> = {}) => ({
  beginning: 0, contributions: 0, distributions: 0, managementFees: 0, expenses: 0, operatingIncome: 0,
  realizedGains: 0, unrealizedGains: 0, fxTranslation: 0, transfers: 0, carriedInterest: 0, unclassified: 0, ending: 0, ...over,
})
const statementPackage = vi.fn(async (_a: unknown, _f: unknown, _g: string, sp: URLSearchParams) => ({
  payload: {
    period: { preset: sp.get('preset') ?? 'custom', label: sp.get('preset') ?? 'custom', start: sp.get('start'), end: sp.get('end') },
    balanceSheet: {
      assets: { label: 'Assets', rows: [{ code: '1000', name: 'Cash', amount: 900 }], total: 900 },
      liabilities: { label: 'Liabilities', rows: [], total: 0 },
      equity: { label: "Partners' capital", rows: [], total: 900 },
      check: 0, partnersCapital: { total: 900, unallocatedEarnings: 0 },
    },
    incomeStatement: { income: { label: 'Income', rows: [], total: 0 }, expenses: { label: 'Expenses', rows: [], total: 0 }, netIncome: 0 },
    cashFlows: null,
    changesInPartnersCapital: {
      partners: [
        { id: 'lp1', name: 'Alder LP', ...account({ contributions: 800, carriedInterest: -80, ending: 720 }) },
        { id: 'gp', name: 'General Partner', ...account({ carriedInterest: 80, ending: 80 }) },
      ],
      totals: account({ contributions: 800, ending: 800 }),
    },
  },
}))
vi.mock('@/lib/accounting/statement-package', () => ({
  buildStatementPackage: (a: unknown, f: unknown, g: string, sp: URLSearchParams) => statementPackage(a, f, g, sp),
}))

import { DASHBOARD_HANDLERS, DASHBOARD_TOOLS, VIEW_ACCESS_DOMAIN, viewDenial } from './dashboard-tools'
import { AGENT_TOOLS, accessDomainFor, isLedgerTool } from '@/lib/accounting/agent-tools'
import { DASHBOARD_VIEWS, VIEW_TOOL } from '@/lib/mcp-apps/payload'

const access = (role: 'admin' | 'member' | 'viewer', grants: Partial<Record<Domain, AccessLevel>> = {}): AccessContext => ({
  fundId: 'fund-1', userId: 'user-me', vehicles: { all: true, ids: [] }, role,
  features: Object.fromEntries(Object.keys(DEFAULT_FEATURE_VISIBILITY).map(k => [k, 'everyone'])) as FeatureVisibilityMap,
  grants, defaults: {},
})

const ctx = (a: AccessContext, rows: Record<string, any>[] = []) => {
  const { admin, tables } = memoryAdmin({
    saved_dashboards: rows,
    funds: [{ id: 'fund-1', name: 'Northgate' }],
    fund_settings: [{ fund_id: 'fund-1', currency: 'eur', theme: { accent: '243 75% 59%' } }],
  })
  return { ctx: { admin, fundId: 'fund-1', portfolioGroup: '', userId: 'user-me', access: a }, tables }
}

beforeEach(() => vi.clearAllMocks())

describe('the dashboard tool registry', () => {
  it('shares no name with the registry it is appended to', () => {
    // getMcpTool finds the first match: a duplicate would dispatch one tool to the other's handler.
    const taken = new Set(AGENT_TOOLS.map(t => t.name))
    expect(DASHBOARD_TOOLS.filter(t => taken.has(t.name)).map(t => t.name)).toEqual([])
    expect(new Set(DASHBOARD_TOOLS.map(t => t.name)).size).toBe(DASHBOARD_TOOLS.length)
  })

  it('gives every tool a handler and an object schema, and none is vehicle-scoped by the dispatcher', () => {
    for (const t of DASHBOARD_TOOLS) {
      expect(typeof t.handler, t.name).toBe('function')
      expect(t.inputSchema.type, t.name).toBe('object')
      expect(t.description.length, t.name).toBeGreaterThan(20)
      // A ledger tool gets a vehicle injected and throws on a multi-vehicle fund without one.
      expect(isLedgerTool(t), t.name).toBe(false)
    }
  })

  it('has one tool per view, and every view tool draws', () => {
    for (const view of DASHBOARD_VIEWS) {
      const tool = DASHBOARD_TOOLS.find(t => t.name === VIEW_TOOL[view])
      expect(tool, view).toBeTruthy()
      expect(tool!.ui, view).toBe(true)
      expect(tool!.scope, view).toBe('read')
      expect(tool!.personal, view).toBeFalsy()
    }
  })

  it('opens a saved view on exactly the grant its own tool needs', () => {
    // open_dashboard is cleared on membership alone and checks the view itself. If the two ever
    // disagree, a saved dashboard becomes a way into a view on a weaker grant than its tool's.
    for (const view of DASHBOARD_VIEWS) {
      const tool = DASHBOARD_TOOLS.find(t => t.name === VIEW_TOOL[view])!
      expect(VIEW_ACCESS_DOMAIN[view], view).toBe(accessDomainFor(tool))
    }
  })

  it('marks only the saved-dashboard tools as personal, and only save and delete as writes', () => {
    expect(DASHBOARD_TOOLS.filter(t => t.personal).map(t => t.name).sort())
      .toEqual(['delete_dashboard', 'list_dashboards', 'open_dashboard', 'save_dashboard'])
    expect(DASHBOARD_TOOLS.filter(t => t.scope === 'write').map(t => t.name).sort())
      .toEqual(['delete_dashboard', 'save_dashboard'])
  })
})

describe('the portfolio overview straddles two domains', () => {
  it('includes fund performance for a caller who also holds accounting', async () => {
    const payload = await DASHBOARD_HANDLERS.show_portfolio_dashboard(ctx(access('member', { portfolio: 'read', accounting: 'read' })).ctx, {})
    expect(payload.data.performance).toHaveLength(1)
  })

  it('leaves it out, without calling for it, for a caller who holds portfolio only', async () => {
    const payload = await DASHBOARD_HANDLERS.show_portfolio_dashboard(ctx(access('member', { portfolio: 'read' })).ctx, {})
    expect(payload.data.performance).toBeNull()
    expect(fundPerformance).not.toHaveBeenCalled()
    expect(payload.data.positions).toHaveLength(1)
  })

  it('carries the fund\'s name, currency and validated theme', async () => {
    const payload = await DASHBOARD_HANDLERS.show_portfolio_dashboard(ctx(access('admin')).ctx, { vehicle: 'Fund I' })
    expect(payload.branding.fundName).toBe('Northgate')
    expect(payload.branding.currency).toBe('EUR')
    expect(payload.branding.cssVars).toContain('--primary:243 75% 59%')
    expect(payload.subtitle).toBe('Fund I · as of 9 Oct 2026')
    expect(payload.args).toEqual({ vehicle: 'Fund I' })
  })

  it('refuses a date that is not one before it reaches a handler', async () => {
    await expect(DASHBOARD_HANDLERS.show_portfolio_dashboard(ctx(access('admin')).ctx, { as_of: '2026-13-45' })).rejects.toThrow(/ISO date/)
    await expect(DASHBOARD_HANDLERS.show_portfolio_dashboard(ctx(access('admin')).ctx, { as_of: 'today' })).rejects.toThrow(/ISO date/)
    expect(portfolioSummary).not.toHaveBeenCalled()
  })
})

describe('the company view', () => {
  it('saves by id, keeps only plottable readings and labels one with no period', async () => {
    const payload = await DASHBOARD_HANDLERS.show_company_dashboard(ctx(access('admin')).ctx, { company: 'acme' })
    // The id, so a saved dashboard survives the company being renamed.
    expect(payload.args).toEqual({ company: 'c1' })
    expect(payload.data.metrics).toEqual([{ name: 'ARR', unit: '$', values: [{ period: 'Q1', value: 10 }, { period: '#2', value: 30 }] }])
    expect(payload.data.summary).toEqual({ invested: 100, fairValue: 250, realized: 0, moic: 2.5, grossIrr: 0.3 })
  })

  it('needs a company', async () => {
    await expect(DASHBOARD_HANDLERS.show_company_dashboard(ctx(access('admin')).ctx, {})).rejects.toThrow(/company id or name is required/)
  })
})

describe('partners\' capital and GP economics', () => {
  it('shows the carry line and the General Partner to a caller who holds gp_economics', async () => {
    const payload = await DASHBOARD_HANDLERS.show_financial_statements(ctx(access('admin')).ctx, {})
    const pc = payload.data.partnersCapital
    expect(pc.carryWithheld).toBe(false)
    expect(pc.partners.map((p: any) => p.name)).toEqual(['Alder LP', 'General Partner'])
    expect(pc.totals.activity.map((a: any) => a.label)).toContain('Carried interest accrued')
  })

  it('drops both for a caller who does not, and says it did', async () => {
    const payload = await DASHBOARD_HANDLERS.show_financial_statements(ctx(access('member', { accounting: 'read' })).ctx, {})
    const pc = payload.data.partnersCapital
    expect(pc.carryWithheld).toBe(true)
    expect(pc.partners.map((p: any) => p.name)).toEqual(['Alder LP'])
    expect(JSON.stringify(pc)).not.toMatch(/Carried interest/)
    // The total is of the rows shown, so the table adds up on its own terms.
    expect(pc.totals.ending).toBe(720)
  })

  it('defaults to year to date, and a custom window replaces the preset', async () => {
    const a = await DASHBOARD_HANDLERS.show_financial_statements(ctx(access('admin')).ctx, {})
    expect(a.args).toEqual({ vehicle: 'Fund I', period: 'ytd' })
    const b = await DASHBOARD_HANDLERS.show_financial_statements(ctx(access('admin')).ctx, { period: 'itd', start: '2026-01-01', end: '2026-03-31' })
    expect(b.args).toEqual({ vehicle: 'Fund I', start: '2026-01-01', end: '2026-03-31' })
    expect(statementPackage.mock.calls[1][3].get('preset')).toBeNull()
  })

  it('refuses a period it does not know', async () => {
    await expect(DASHBOARD_HANDLERS.show_financial_statements(ctx(access('admin')).ctx, { period: 'forever' })).rejects.toThrow(/period must be one of/)
  })
})

describe('the LP view', () => {
  it('takes the ratios of the sums, never an average of the rows\' ratios', async () => {
    const payload = await DASHBOARD_HANDLERS.show_lp_dashboard(ctx(access('admin')).ctx, {})
    const t = payload.data.totals
    expect(t).toMatchObject({ commitment: 4000, paidIn: 1000, distributions: 100, nav: 2000 })
    // (100 + 2000) / 1000. The average of 1.5 and 2.5 would be 2.0.
    expect(t.tvpi).toBe(2.1)
    expect(t.dpi).toBe(0.1)
  })
})

describe('saved dashboards go through the view\'s own access check', () => {
  const rows = [
    { id: 'lp-dash', fund_id: 'fund-1', user_id: 'user-colleague', name: 'LP review', view: 'lps', params: { vehicle: 'Fund I' }, shared: true, updated_at: null },
    { id: 'pf-dash', fund_id: 'fund-1', user_id: 'user-me', name: 'My portfolio', view: 'portfolio', params: {}, shared: false, updated_at: null },
  ]

  it('opens a shared dashboard for a member who holds its domain, under the name it was saved as', async () => {
    const payload = await DASHBOARD_HANDLERS.open_dashboard(ctx(access('member', { lp_capital: 'read' }), rows).ctx, { dashboard: 'LP review' })
    expect(payload.view).toBe('lps')
    expect(payload.title).toBe('LP review')
  })

  it('refuses it, before reading a figure, for a member who does not', async () => {
    await expect(DASHBOARD_HANDLERS.open_dashboard(ctx(access('member', { portfolio: 'read' }), rows).ctx, { dashboard: 'lp-dash' }))
      .rejects.toThrow(/does not have access to/)
    expect(liveReport).not.toHaveBeenCalled()
  })

  it('does not even list a dashboard the member could not open', async () => {
    const { dashboards } = await DASHBOARD_HANDLERS.list_dashboards(ctx(access('member', { portfolio: 'read' }), rows).ctx, {})
    const names = dashboards.map((d: any) => d.name)
    expect(names).toContain('My portfolio')
    expect(names).toContain('Portfolio overview')
    expect(names).not.toContain('LP review')
    expect(names).not.toContain('LP capital')
    expect(names).not.toContain('Financial statements')
  })

  it('will not save a view the member cannot open', async () => {
    const { ctx: c, tables } = ctx(access('member', { portfolio: 'read' }))
    await expect(DASHBOARD_HANDLERS.save_dashboard(c, { name: 'Books', view: 'statements' })).rejects.toThrow(/does not have access to/)
    expect(tables.saved_dashboards).toHaveLength(0)
  })

  it('saves for the caller and tells them how to get it back', async () => {
    const { ctx: c, tables } = ctx(access('member', { portfolio: 'read' }))
    const result = await DASHBOARD_HANDLERS.save_dashboard(c, { name: 'Board', view: 'portfolio', arguments: { vehicle: 'Fund I' } })
    expect(result.saved).toMatchObject({ name: 'Board', kind: 'mine' })
    expect(tables.saved_dashboards[0]).toMatchObject({ user_id: 'user-me', fund_id: 'fund-1' })
  })

  it('replays a stored recipe only as the keys its view takes', async () => {
    const tampered = [{ ...rows[1], params: { vehicle: 'Fund I', as_of: 'DROP TABLE', extra: { nested: true } } }]
    // A malformed stored value makes the row unreadable, so it is not offered at all.
    const { dashboards } = await DASHBOARD_HANDLERS.list_dashboards(ctx(access('admin'), tampered).ctx, {})
    expect(dashboards.map((d: any) => d.id)).not.toContain('pf-dash')
  })

  it('needs a member behind the credential', async () => {
    const c = ctx(access('admin')).ctx
    await expect(DASHBOARD_HANDLERS.list_dashboards({ ...c, userId: null }, {})).rejects.toThrow(/signed-in member/)
  })
})

describe('viewDenial', () => {
  it('follows the fund-level switch as well as the grant', () => {
    const hidden = { ...access('admin'), features: { ...access('admin').features, accounting: 'hidden' } as FeatureVisibilityMap }
    // Hidden means nobody, admins included.
    expect(viewDenial(hidden, 'statements')).toMatch(/Fund accounting/)
    expect(viewDenial(access('admin'), 'statements')).toBeNull()
  })

  it('lets accounting open LP capital, as it does everywhere else', () => {
    // DOMAIN_META.lp_capital.impliedBy: the partner accounts ARE the ledger.
    expect(viewDenial(access('member', { accounting: 'read' }), 'lps')).toBeNull()
    expect(viewDenial(access('member', { portfolio: 'read' }), 'lps')).toMatch(/does not have access/)
  })
})
