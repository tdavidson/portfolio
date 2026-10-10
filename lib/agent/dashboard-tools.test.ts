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
const metrics = (committed: number, paidIn: number, distributions: number, nav: number) => ({
  committed, paidIn, uncalled: committed - paidIn, distributions, nav, totalValue: distributions + nav,
  dpi: distributions / paidIn, rvpi: nav / paidIn, tvpi: (distributions + nav) / paidIn, irr: null,
})
const fundEconomics = vi.fn(async (_admin: unknown, _fundId: string, _asOf?: string) => [
  { vehicle: 'Fund II', id: 'v2', fund: metrics(9000, 3000, 0, 4500) },
  { vehicle: 'Fund I', id: 'v1', fund: metrics(1000, 500, 50, 700) },
])
vi.mock('@/lib/accounting/fund-economics', () => ({
  fundEconomics: (a: unknown, f: string, asOf?: string) => fundEconomics(a, f, asOf),
}))
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
  return { ...real,
    // Names resolve to ids through the caller's access; a name outside it does not resolve.
    resolveCompany: async (_a: unknown, _f: unknown, ref: string) => {
      if (ref.toLowerCase() === 'acme' || ref === 'c1') return { id: 'c1', name: 'Acme' }
      throw new Error(`No company named "${ref}" in this fund.`)
    },
    PORTFOLIO_HANDLERS: {
    ...real.PORTFOLIO_HANDLERS,
    portfolio_summary: (ctx: unknown, input: unknown) => portfolioSummary(ctx, input),
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
// Stands in for the registry lookup, and honours the caller's entities as the real one does: a
// name outside `access.vehicles` is unknown. Recording the call is the point of the stand-in: the
// handlers must hand it the caller's access, or a scoped member reads any vehicle's books.
const VEHICLE_IDS: Record<string, string> = { 'fund i': 'v1', 'fund ii': 'v2' }
const resolveVehicle = vi.fn(async (_a: unknown, _f: unknown, requested: string | undefined, opts?: { access?: AccessContext }) => {
  const name = requested ?? 'Fund I'
  const id = VEHICLE_IDS[name.toLowerCase()]
  const visible = opts?.access ? (opts.access.vehicles.all || opts.access.vehicles.ids.includes(id)) : true
  if (!id || !visible) throw new Error(`Unknown vehicle "${name}".`)
  return name.toLowerCase() === 'fund i' ? 'Fund I' : 'Fund II'
})
vi.mock('@/lib/accounting/vehicle-resolver', () => ({
  resolveVehicle: (a: unknown, f: unknown, requested: string | undefined, opts?: { access?: AccessContext }) => resolveVehicle(a, f, requested, opts),
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

/** A member who may see Fund I only. */
const scoped = (grants: Partial<Record<Domain, AccessLevel>>): AccessContext => ({ ...access('member', grants), vehicles: { all: false, ids: ['v1'] } })

const ctx = (a: AccessContext, rows: Record<string, any>[] = []) => {
  const { admin, tables } = memoryAdmin({
    saved_dashboards: rows,
    fund_members: [{ fund_id: 'fund-1', user_id: 'user-me' }, { fund_id: 'fund-1', user_id: 'user-colleague' }],
    fund_vehicles: [{ id: 'v1', fund_id: 'fund-1', name: 'Fund I', aliases: null }, { id: 'v2', fund_id: 'fund-1', name: 'Fund II', aliases: null }],
    company_vehicles: [{ fund_id: 'fund-1', vehicle_id: 'v1', company_id: 'c1' }, { fund_id: 'fund-1', vehicle_id: 'v2', company_id: 'c2' }],
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
    expect(payload.data.performance.map((v: any) => v.vehicle)).toEqual(['Fund I', 'Fund II'])
    expect(payload.data.performance[0]).toEqual({ vehicle: 'Fund I', committed: 1000, called: 500, unfunded: 500, distributed: 50, nav: 700, dpi: 0.1, rvpi: 1.4, tvpi: 1.5 })
  })

  it('leaves it out, without reading it, for a caller who holds portfolio only', async () => {
    const payload = await DASHBOARD_HANDLERS.show_portfolio_dashboard(ctx(access('member', { portfolio: 'read' })).ctx, {})
    expect(payload.data.performance).toBeNull()
    expect(fundEconomics).not.toHaveBeenCalled()
    expect(payload.data.positions).toHaveLength(1)
  })

  it('strikes fund performance on the same day as the positions', async () => {
    // The heading says "as of 31 Dec 2025". Current called capital beside it would be a lie.
    await DASHBOARD_HANDLERS.show_portfolio_dashboard(ctx(access('admin')).ctx, { as_of: '2025-12-31' })
    expect(fundEconomics.mock.calls[0][2]).toBe('2025-12-31')
    expect(portfolioSummary.mock.calls[0][1]).toEqual({ as_of: '2025-12-31' })
  })

  it('shows a member scoped to one entity that entity only', async () => {
    const payload = await DASHBOARD_HANDLERS.show_portfolio_dashboard(ctx(scoped({ portfolio: 'read', accounting: 'read' })).ctx, {})
    expect(payload.data.performance.map((v: any) => v.vehicle)).toEqual(['Fund I'])
  })

  it('narrows performance to the vehicle asked for', async () => {
    const payload = await DASHBOARD_HANDLERS.show_portfolio_dashboard(ctx(access('admin')).ctx, { vehicle: 'fund ii' })
    expect(payload.data.performance.map((v: any) => v.vehicle)).toEqual(['Fund II'])
  })

  it('carries the fund\'s name, currency and validated theme', async () => {
    const payload = await DASHBOARD_HANDLERS.show_portfolio_dashboard(ctx(access('admin')).ctx, { vehicle: 'Fund I' })
    expect(payload.branding.fundName).toBe('Northgate')
    expect(payload.branding.currency).toBe('EUR')
    expect(payload.branding.cssVars).toContain('--primary:243 75% 59%')
    expect(payload.subtitle).toBe('Fund I · as of 9 Oct 2026')
    expect(payload.args).toEqual({ vehicle: 'Fund I' })
  })

  it('refuses a date that is not a real one before it reaches a handler', async () => {
    // 2026-02-31 has the right shape, and JavaScript would quietly read it as 3 March.
    for (const as_of of ['2026-13-45', '2026-02-31', 'today', '2026-1-5']) {
      await expect(DASHBOARD_HANDLERS.show_portfolio_dashboard(ctx(access('admin')).ctx, { as_of }), as_of).rejects.toThrow(/real date/)
    }
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

  it('resolves the vehicle through the caller\'s own entities', async () => {
    const c = ctx(scoped({ accounting: 'read' })).ctx
    await DASHBOARD_HANDLERS.show_financial_statements(c, { vehicle: 'Fund I' })
    // The access goes with the lookup. Drop it and a scoped member reads any vehicle's books.
    expect(resolveVehicle.mock.calls[0][3]).toEqual({ access: c.access })
    await expect(DASHBOARD_HANDLERS.show_financial_statements(c, { vehicle: 'Fund II' })).rejects.toThrow(/Unknown vehicle/)
    expect(statementPackage).toHaveBeenCalledTimes(1)
  })

  it('leaves partners\' capital out when the fund has hidden LPs, as capital_accounts is refused', async () => {
    const base = access('member', { accounting: 'read' })
    const hidden = { ...base, features: { ...base.features, lps: 'hidden' } as FeatureVisibilityMap }
    const payload = await DASHBOARD_HANDLERS.show_financial_statements(ctx(hidden).ctx, {})
    expect(payload.data.partnersCapital).toBeNull()
    expect(JSON.stringify(payload.data)).not.toContain('Alder LP')
    // The statements themselves are accounting, and still there.
    expect(payload.data.balanceSheet.assets.total).toBe(900)
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

  it('does not list a dashboard the member could not open', async () => {
    const { dashboards } = await DASHBOARD_HANDLERS.list_dashboards(ctx(access('member', { portfolio: 'read' }), rows).ctx, {})
    const names = dashboards.map((d: any) => d.name)
    expect(names).toContain('My portfolio')
    expect(names).toContain('Portfolio overview')
    expect(names).not.toContain('LP review')
    expect(names).not.toContain('LP capital')
    expect(names).not.toContain('Financial statements')
  })

  it('does not find it either, by name or by id, and does not name it in the refusal', async () => {
    // list_dashboards withholds it because its name alone says something. An error that recited
    // the available dashboards, or confirmed the id exists, would hand the same thing over.
    const c = ctx(access('member', { portfolio: 'read' }), rows).ctx
    for (const dashboard of ['LP review', 'lp-dash', 'nothing like it']) {
      const error = await DASHBOARD_HANDLERS.open_dashboard(c, { dashboard }).then(() => null, (e: Error) => e.message)
      expect(error, dashboard).toMatch(/^No dashboard called/)
      expect(error!.replace(`"${dashboard}"`, ''), dashboard).not.toMatch(/LP review|lp-dash|LP capital/)
    }
    expect(liveReport).not.toHaveBeenCalled()
  })

  it('tells a member why their OWN dashboard no longer opens, after the grant is gone', async () => {
    const mine = [{ ...rows[0], id: 'mine-lp', user_id: 'user-me', name: 'My LPs', shared: false }]
    await expect(DASHBOARD_HANDLERS.open_dashboard(ctx(access('member', { portfolio: 'read' }), mine).ctx, { dashboard: 'My LPs' }))
      .rejects.toThrow(/does not have access to/)
    expect(liveReport).not.toHaveBeenCalled()
  })

  it('will not save a view the member cannot open', async () => {
    const { ctx: c, tables } = ctx(access('member', { portfolio: 'read' }))
    await expect(DASHBOARD_HANDLERS.save_dashboard(c, { name: 'Books', view: 'statements' })).rejects.toThrow(/does not have access to/)
    expect(tables.saved_dashboards).toHaveLength(0)
  })

  it('saves names as what they name: the vehicle\'s stored spelling, the company\'s id', async () => {
    const { ctx: c, tables } = ctx(access('member', { portfolio: 'read' }))
    const a = await DASHBOARD_HANDLERS.save_dashboard(c, { name: 'Board', view: 'portfolio', arguments: { vehicle: 'fund i' } })
    expect(a.saved).toMatchObject({ name: 'Board', kind: 'mine', arguments: { vehicle: 'Fund I' } })
    await DASHBOARD_HANDLERS.save_dashboard(c, { name: 'Acme', view: 'company', arguments: { company: 'ACME' } })
    expect(tables.saved_dashboards.map(r => r.params)).toEqual([{ vehicle: 'Fund I' }, { company: 'c1' }])
    expect(tables.saved_dashboards.every(r => r.user_id === 'user-me' && r.fund_id === 'fund-1')).toBe(true)
  })

  it('will not save a pointer to a vehicle or company the member cannot see', async () => {
    const { ctx: c, tables } = ctx(scoped({ portfolio: 'read' }))
    await expect(DASHBOARD_HANDLERS.save_dashboard(c, { name: 'x', view: 'portfolio', arguments: { vehicle: 'Fund II' } })).rejects.toThrow(/Unknown vehicle/)
    await expect(DASHBOARD_HANDLERS.save_dashboard(c, { name: 'y', view: 'company', arguments: { company: 'Globex' } })).rejects.toThrow(/No company named/)
    expect(tables.saved_dashboards).toHaveLength(0)
  })

  it('replays a stored recipe only as the keys its view takes', async () => {
    const stored = [{ ...rows[1], params: { vehicle: 'Fund I', as_of: '2026-06-30', role: 'admin', extra: { nested: true } } }]
    const payload = await DASHBOARD_HANDLERS.open_dashboard(ctx(access('admin'), stored).ctx, { dashboard: 'pf-dash' })
    expect(portfolioSummary.mock.calls[0][1]).toEqual({ vehicle: 'Fund I', as_of: '2026-06-30' })
    expect(payload.args).toEqual({ vehicle: 'Fund I', as_of: '2026-06-30' })
  })

  it('does not offer a stored recipe it cannot read', async () => {
    const tampered = [{ ...rows[1], params: { as_of: 'DROP TABLE' } }]
    const c = ctx(access('admin'), tampered).ctx
    expect((await DASHBOARD_HANDLERS.list_dashboards(c, {})).dashboards.map((d: any) => d.id)).not.toContain('pf-dash')
    await expect(DASHBOARD_HANDLERS.open_dashboard(c, { dashboard: 'pf-dash' })).rejects.toThrow(/No dashboard called/)
    expect(portfolioSummary).not.toHaveBeenCalled()
  })

  it('needs a member behind the credential', async () => {
    const c = ctx(access('admin')).ctx
    await expect(DASHBOARD_HANDLERS.list_dashboards({ ...c, userId: null }, {})).rejects.toThrow(/signed-in member/)
  })
})

describe('a shared dashboard does not show a scoped member another entity', () => {
  // list_vehicles hides Fund II from this member and list_companies hides its companies. A
  // colleague's shared recipe names one or the other.
  const rows = [
    { id: 'f1', fund_id: 'fund-1', user_id: 'user-colleague', name: 'Fund I holdings', view: 'portfolio', params: { vehicle: 'Fund I' }, shared: true, updated_at: null },
    { id: 'f2', fund_id: 'fund-1', user_id: 'user-colleague', name: 'Fund II holdings', view: 'portfolio', params: { vehicle: 'Fund II' }, shared: true, updated_at: null },
    { id: 'c1d', fund_id: 'fund-1', user_id: 'user-colleague', name: 'Acme', view: 'company', params: { company: 'c1' }, shared: true, updated_at: null },
    { id: 'c2d', fund_id: 'fund-1', user_id: 'user-colleague', name: 'Globex', view: 'company', params: { company: 'c2' }, shared: true, updated_at: null },
    { id: 'all', fund_id: 'fund-1', user_id: 'user-colleague', name: 'Everything', view: 'portfolio', params: {}, shared: true, updated_at: null },
  ]
  const ids = async (a: AccessContext) =>
    (await DASHBOARD_HANDLERS.list_dashboards(ctx(a, rows).ctx, {})).dashboards.filter((d: any) => d.kind === 'shared').map((d: any) => d.id).sort()

  it('lists only the shared dashboards that point inside their entities', async () => {
    expect(await ids(scoped({ portfolio: 'read' }))).toEqual(['all', 'c1d', 'f1'])
  })

  it('lists them all for a member who sees every entity', async () => {
    expect(await ids(access('member', { portfolio: 'read' }))).toEqual(['all', 'c1d', 'c2d', 'f1', 'f2'])
  })

  it('does not open, or admit to, the ones outside', async () => {
    const c = ctx(scoped({ portfolio: 'read' }), rows).ctx
    for (const dashboard of ['f2', 'Fund II holdings', 'c2d', 'Globex']) {
      const error = await DASHBOARD_HANDLERS.open_dashboard(c, { dashboard }).then(() => null, (e: Error) => e.message)
      expect(error, dashboard).toMatch(/^No dashboard called/)
      expect(error!.replace(`"${dashboard}"`, ''), dashboard).not.toMatch(/Fund II|Globex/)
    }
    expect(portfolioSummary).not.toHaveBeenCalled()
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
