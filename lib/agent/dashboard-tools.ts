// Handlers for the DASHBOARD tools. Each `show_*` tool composes the read handlers that already
// exist (portfolio_summary, company_detail, lp_live_report, the statement package) into one
// DashboardPayload, so a dashboard is those tools' figures laid out, not a second computation
// that could drift from them.
//
// ACCESS. The MCP endpoint has already cleared each `show_*` tool's own domain before its handler
// runs. Two things are left to do here, and both are done here:
//   - a payload that STRADDLES domains trims the part the caller may not see (fund performance on
//     the portfolio overview is `accounting`; the carry line in partners' capital is `gp_economics`);
//   - `open_dashboard` is a personal tool, cleared on membership alone, so it checks the saved
//     view's domain itself before building anything. See `viewDenial`.

import { carryRecipientIds, combineCarryRecipients, seesIndividualCarry } from '@/lib/access/carry-visibility'
import type { SupabaseClient } from '@supabase/supabase-js'
import type { AgentToolContext, AgentToolHandler } from '@/lib/accounting/agent-tools'
import { hasAccess, type AccessContext } from '@/lib/access/effective'
import { DOMAIN_META, type Domain } from '@/lib/access/domains'
import { PORTFOLIO_HANDLERS, resolveCompany } from './portfolio-tools'
import { LP_HANDLERS } from './lp-tools'
import { DASHBOARD_TOOL_MANIFEST, type DashboardToolMeta } from './dashboard-tools-manifest'
import { resolveVehicle } from '@/lib/accounting/vehicle-resolver'
import { fundEconomics } from '@/lib/accounting/fund-economics'
import { entityScopeFor } from '@/lib/access/entity-scope'
import { canSeeVehicle } from '@/lib/access/scope'
import { buildStatementPackage } from '@/lib/accounting/statement-package'
import { ACTIVITY_FIELDS, CAPITAL_ACCOUNT_LABELS, type CapitalAccount } from '@/lib/accounting/capital-account'
import { lpRatios } from '@/lib/lp-metrics'
import { themeCssVars, type FundTheme } from '@/lib/theme'
import { shortDate } from '@/lib/mcp-apps/app/format'
import {
  STATEMENT_PRESETS, VIEW_LABEL,
  type CompanyPayload, type DashboardBranding, type DashboardPayload, type DashboardView,
  type CallLine, type CallSummary, type CallsPayload,
  type LpPayload, type LpRow, type PartnerCapitalRow, type PortfolioPayload,
  type SavedDashboardSummary, type StatementsPayload, type VehiclePerformance,
} from '@/lib/mcp-apps/payload'
import {
  deleteDashboard, listDashboards, parseSave, resolveDashboard, sanitizeArguments, saveDashboard,
} from '@/lib/mcp-apps/saved-dashboards'
import { listVehicles } from '@/lib/accounting/load'
import { areasFor, DASHBOARD_TIPS, helpText, type CanRead } from './getting-started'
import type { HomePayload } from '@/lib/mcp-apps/payload'

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/
const r2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100
const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : Number(v) || 0)
const ratio = (v: number | null | undefined) => (v == null ? null : r2(v))

function isoDate(value: unknown, label: string): string | undefined {
  if (value === undefined || value === null || value === '') return undefined
  // A real calendar day, not just the shape of one: JavaScript reads 2026-02-31 as 3 March, and
  // a statement silently struck on a different day than the one asked for is a wrong statement.
  const parsed = typeof value === 'string' && ISO_DATE.test(value) ? new Date(`${value}T00:00:00Z`) : null
  if (!parsed || Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value) {
    throw new Error(`${label} must be a real date in ISO form (YYYY-MM-DD)`)
  }
  return value as string
}

const text = (value: unknown): string | undefined =>
  typeof value === 'string' && value.trim() ? value.trim() : undefined

/**
 * The fund's name, reporting currency and theme. One query each, in parallel; a failure of
 * either degrades to the defaults rather than failing a dashboard over its heading.
 */
async function loadBranding(admin: SupabaseClient, fundId: string): Promise<DashboardBranding> {
  const [fund, settings] = await Promise.all([
    (admin as any).from('funds').select('name').eq('id', fundId).maybeSingle(),
    (admin as any).from('fund_settings').select('currency, theme').eq('fund_id', fundId).maybeSingle(),
  ])
  const currency = typeof settings?.data?.currency === 'string' && /^[A-Za-z]{3}$/.test(settings.data.currency)
    ? settings.data.currency.toUpperCase()
    : 'USD'
  return {
    fundName: typeof fund?.data?.name === 'string' ? fund.data.name : null,
    currency,
    // themeCssVars validates every value it emits (lib/theme.ts); the view checks the shape again.
    cssVars: themeCssVars((settings?.data?.theme as FundTheme | null) ?? null),
  }
}

// ---------------------------------------------------------------------------------------------
// The four views
// ---------------------------------------------------------------------------------------------

/**
 * Committed, called, distributed and NAV per vehicle, as of a date, from the books.
 *
 * `fundEconomics` rather than the `fund_performance` tool, for two reasons. It takes an as-of, so
 * these figures are struck on the same day as the positions beside them. And it is what the app's
 * own fund overview shows (api/accounting/fund-economics), derived from the ledger the way the LP
 * dashboard is, so the two dashboards agree on called capital and NAV. Only the caller's entities.
 */
async function vehiclePerformance(ctx: AgentToolContext, vehicle: string | undefined, asOf: string | undefined): Promise<VehiclePerformance[]> {
  const all = await fundEconomics(ctx.admin, ctx.fundId, asOf)
  const wanted = vehicle?.toLowerCase()
  return all
    .filter(v => canSeeVehicle(ctx.access, v.id))
    .filter(v => !wanted || v.vehicle.toLowerCase() === wanted)
    .map(v => {
      const f = v.fund
      const called = r2(num(f.paidIn))
      return {
        vehicle: v.vehicle,
        committed: r2(num(f.committed)),
        called,
        unfunded: r2(f.uncalled == null ? num(f.committed) - called : num(f.uncalled)),
        distributed: r2(num(f.distributions)),
        nav: r2(num(f.nav)),
        dpi: ratio(f.dpi), rvpi: ratio(f.rvpi), tvpi: ratio(f.tvpi),
      }
    })
    .sort((a, b) => a.vehicle.localeCompare(b.vehicle))
}

async function portfolioView(ctx: AgentToolContext, input: any): Promise<PortfolioPayload> {
  const vehicle = text(input?.vehicle)
  const asOf = isoDate(input?.as_of, 'as_of')
  const args = { ...(vehicle ? { vehicle } : {}), ...(asOf ? { as_of: asOf } : {}) }

  // Fund performance is committed / called / distributed / NAV: the fund's financial position,
  // gated `accounting` (as fund_performance and api/accounting/fund-economics are). The overview's
  // own domain is `portfolio`, so this half is included only for a caller who holds both.
  const showPerformance = hasAccess(ctx.access, 'accounting', 'read')
  const [summary, performance, branding, allVehicles, scope] = await Promise.all([
    PORTFOLIO_HANDLERS.portfolio_summary(ctx, args),
    showPerformance ? vehiclePerformance(ctx, vehicle, asOf) : Promise.resolve(null),
    loadBranding(ctx.admin, ctx.fundId),
    listVehicles(ctx.admin, ctx.fundId).catch(() => [] as string[]),
    entityScopeFor(ctx.admin, ctx.access),
  ])
  // The entity picker offers only the member's own entities (the tool refuses any other).
  const vehicles = scope.vehicleNames === null ? allVehicles : allVehicles.filter(v => scope.vehicleNames!.includes(v))

  return {
    view: 'portfolio',
    title: VIEW_LABEL.portfolio,
    subtitle: [vehicle ?? 'All vehicles', `as of ${shortDate(summary.asOf)}`].join(' · '),
    args,
    generatedAt: new Date().toISOString(),
    branding,
    data: {
      asOf: summary.asOf,
      vehicle: summary.vehicle,
      positions: summary.positions,
      totals: summary.totals,
      performance,
      vehicles,
    },
  }
}

async function companyView(ctx: AgentToolContext, input: any): Promise<CompanyPayload> {
  const company = text(input?.company)
  if (!company) throw new Error('A company id or name is required')
  const vehicle = text(input?.vehicle)

  const [detail, metrics, branding] = await Promise.all([
    PORTFOLIO_HANDLERS.company_detail(ctx, { company, vehicle }),
    PORTFOLIO_HANDLERS.company_metrics(ctx, { company }),
    loadBranding(ctx.admin, ctx.fundId),
  ])
  const s = detail.summary ?? {}

  return {
    view: 'company',
    title: detail.name,
    subtitle: [detail.stage, ...(detail.industry ?? []).slice(0, 2), vehicle].filter(Boolean).join(' · ') || null,
    // The id, not the name the caller typed: a saved dashboard should survive a rename.
    args: { company: detail.id, ...(vehicle ? { vehicle } : {}) },
    generatedAt: new Date().toISOString(),
    branding,
    data: {
      id: detail.id,
      name: detail.name,
      status: detail.status ?? null,
      stage: detail.stage ?? null,
      industry: detail.industry ?? [],
      vehicles: detail.vehicles ?? [],
      overview: typeof detail.overview === 'string' ? detail.overview : null,
      summary: {
        invested: r2(num(s.totalInvested)),
        // The same figure portfolio_summary reports as fair value, so the two views agree.
        fairValue: r2(num(s.unrealizedValue)),
        realized: r2(num(s.totalRealized)),
        moic: ratio(s.moic),
        grossIrr: s.grossIrr == null ? null : Number(s.grossIrr),
      },
      rounds: (s.rounds ?? []).map((rd: any) => ({
        roundName: rd.roundName,
        date: rd.date ?? null,
        invested: r2(num(rd.investmentCost)),
        shares: num(rd.sharesAcquired),
        sharePrice: rd.sharePrice == null ? null : Number(rd.sharePrice),
        currentValue: r2(num(rd.currentValue)),
        realized: r2(num(rd.totalRealized)),
      })),
      metrics: (metrics.metrics ?? [])
        .map((m: any) => ({
          name: m.name,
          unit: m.unit ?? null,
          values: (m.values ?? [])
            .filter((v: any) => typeof v.value === 'number' && Number.isFinite(v.value))
            // A reading with no period label still has its place in the series.
            .map((v: any, i: number) => ({ period: typeof v.period === 'string' && v.period ? v.period : `#${i + 1}`, value: v.value })),
        }))
        .filter((m: any) => m.values.length > 0),
    },
  }
}

function capitalRow(
  name: string,
  account: CapitalAccount,
  fields: (keyof CapitalAccount)[],
): PartnerCapitalRow {
  return {
    name,
    beginning: account.beginning,
    activity: fields.map(f => ({ label: CAPITAL_ACCOUNT_LABELS[f], amount: account[f] })),
    ending: account.ending,
  }
}

async function statementsView(ctx: AgentToolContext, input: any): Promise<StatementsPayload> {
  // Validated against the registry and the caller's entities, and never a management company
  // (resolveVehicle leaves those out unless asked): an unknown name is refused, not passed on.
  const vehicle = await resolveVehicle(ctx.admin, ctx.fundId, text(input?.vehicle), { access: ctx.access })
  const start = isoDate(input?.start, 'start')
  const end = isoDate(input?.end, 'end')

  const sp = new URLSearchParams()
  const args: Record<string, string> = { vehicle }
  if (start || end) {
    if (start) { sp.set('start', start); args.start = start }
    if (end) { sp.set('end', end); args.end = end }
  } else {
    const preset = text(input?.period) ?? 'ytd'
    if (!(STATEMENT_PRESETS as readonly string[]).includes(preset)) {
      throw new Error(`period must be one of: ${STATEMENT_PRESETS.join(', ')}`)
    }
    sp.set('preset', preset)
    args.period = preset
  }

  const [pkg, branding] = await Promise.all([
    buildStatementPackage(ctx.admin, ctx.fundId, vehicle, sp),
    loadBranding(ctx.admin, ctx.fundId),
  ])
  const p = pkg.payload

  // The fund's carry — each LP's carried-interest line, the General Partner's total — is shown to
  // anyone who may read partners' capital. What each carry RECIPIENT earns is GP economics: without
  // that grant their rows are folded into one combined row, so the table still adds up and the
  // fund's carry stays visible (lib/access/carry-visibility.ts). `carryWithheld` tells the view.
  //
  // The roll-forward itself is LP capital. Holding `accounting` normally confers it (the partner
  // accounts ARE the ledger), but a fund that has switched LPs off or hidden them denies it to
  // everyone, and then this tab is left out, as capital_accounts is refused.
  const showCapital = hasAccess(ctx.access, 'lp_capital', 'read')
  const cpc = p.changesInPartnersCapital
  const { rows: partners, combined } = seesIndividualCarry(ctx.access)
    ? { rows: cpc.partners, combined: 0 }
    : combineCarryRecipients(cpc.partners, await carryRecipientIds(ctx.admin, ctx.fundId, vehicle))
  const fields = ACTIVITY_FIELDS
    // Only the lines that moved for someone, so a fund with no FX has no FX row.
    .filter(f => partners.some(row => row[f] !== 0))
  const totals = (['beginning', ...fields, 'ending'] as (keyof CapitalAccount)[]).reduce((acc, f) => {
    acc[f] = r2(partners.reduce((sum, row) => sum + row[f], 0))
    return acc
  }, {} as CapitalAccount)
  const carryWithheld = combined > 0

  const section = (s: { label: string; rows: { code: string; name: string; amount: number }[]; total: number }) => ({
    label: s.label,
    rows: s.rows.map(row => ({ code: row.code, name: row.name, amount: row.amount })),
    total: s.total,
  })
  const cashSection = (s: { label: string; lines: { name: string; amount: number }[]; total: number }) => ({
    label: s.label,
    rows: s.lines.map(line => ({ name: line.name, amount: line.amount })),
    total: s.total,
  })

  return {
    view: 'statements',
    title: VIEW_LABEL.statements,
    subtitle: `${vehicle} · ${p.period.label}`,
    args,
    generatedAt: new Date().toISOString(),
    branding,
    data: {
      vehicle,
      period: { preset: p.period.preset, label: p.period.label, start: p.period.start, end: p.period.end },
      balanceSheet: {
        assets: section(p.balanceSheet.assets),
        liabilities: section(p.balanceSheet.liabilities),
        equityLabel: p.balanceSheet.equity.label,
        equityTotal: p.balanceSheet.equity.total,
        check: p.balanceSheet.check,
        unallocatedEarnings: p.balanceSheet.partnersCapital.unallocatedEarnings,
      },
      incomeStatement: {
        income: section(p.incomeStatement.income),
        expenses: section(p.incomeStatement.expenses),
        netIncome: p.incomeStatement.netIncome,
      },
      cashFlows: p.cashFlows
        ? {
            operating: cashSection(p.cashFlows.operating),
            financing: cashSection(p.cashFlows.financing),
            netChange: p.cashFlows.netChange,
            openingCash: p.cashFlows.openingCash,
            endingCash: p.cashFlows.endingCash,
          }
        : null,
      partnersCapital: showCapital
        ? {
            partners: partners.map(row => capitalRow(row.name, row, fields)),
            totals: capitalRow('Total', totals, fields),
            carryWithheld,
          }
        : null,
    },
  }
}

async function lpView(ctx: AgentToolContext, input: any): Promise<LpPayload> {
  const vehicle = text(input?.vehicle)
  const asOf = isoDate(input?.as_of, 'as_of')
  const args = { ...(vehicle ? { vehicle } : {}), ...(asOf ? { as_of: asOf } : {}) }

  const [report, branding] = await Promise.all([
    LP_HANDLERS.lp_live_report(ctx, args),
    loadBranding(ctx.admin, ctx.fundId),
  ])

  const rows: LpRow[] = (report.rows ?? []).map((row: any) => ({
    investor: row.investor ?? row.entity,
    entity: row.entity,
    vehicle: row.vehicle,
    commitment: r2(num(row.commitment)),
    paidIn: r2(num(row.paid_in_capital)),
    distributions: r2(num(row.distributions)),
    nav: r2(num(row.nav)),
    dpi: ratio(row.dpi),
    rvpi: ratio(row.rvpi),
    tvpi: ratio(row.tvpi),
    irr: row.irr == null ? null : Number(row.irr),
  }))

  // Sum first, THEN take the ratios (lib/lp-metrics.ts). An average of per-entity TVPIs is not
  // the fund's TVPI.
  const sum = (pick: (row: LpRow) => number) => r2(rows.reduce((total, row) => total + pick(row), 0))
  const commitment = sum(row => row.commitment)
  const paidIn = sum(row => row.paidIn)
  const distributions = sum(row => row.distributions)
  const nav = sum(row => row.nav)
  const ratios = lpRatios({ commitment, paidIn, distributions, nav })

  return {
    view: 'lps',
    title: VIEW_LABEL.lps,
    subtitle: [vehicle ?? 'All vehicles', report.as_of ? `as of ${shortDate(report.as_of)}` : null].filter(Boolean).join(' · '),
    args,
    generatedAt: new Date().toISOString(),
    branding,
    data: {
      asOf: report.as_of ?? null,
      vehicle: vehicle ?? 'all',
      rows,
      totals: { commitment, paidIn, distributions, nav, dpi: ratio(ratios.dpi), rvpi: ratio(ratios.rvpi), tvpi: ratio(ratios.tvpi) },
    },
  }
}

/** Pick a call: "latest", its number ("3", "#3"), its date, or its id. */
function pickCall<C extends { id: string; number: number | null; date: string }>(calls: C[], ref: string | undefined): C {
  if (!ref || ref.toLowerCase() === 'latest') return calls[0]
  const n = ref.replace(/^#/, '')
  const hit = calls.find(c => c.id === ref)
    ?? calls.find(c => c.number != null && String(c.number) === n)
    ?? calls.find(c => c.date === ref)
  if (hit) return hit
  throw new Error(`No capital call "${ref}". This vehicle's calls: ${calls.map(c => `${c.number != null ? `#${c.number} ` : ''}${c.date}`).join(', ')}.`)
}

async function callsView(ctx: AgentToolContext, input: any): Promise<CallsPayload> {
  const call = text(input?.call)
  // lp_capital_calls resolves the vehicle against the member's entities and asks which one when
  // the fund has several.
  const [report, branding] = await Promise.all([
    LP_HANDLERS.lp_capital_calls(ctx, { vehicle: text(input?.vehicle) ?? '' }),
    loadBranding(ctx.admin, ctx.fundId),
  ])
  const vehicle: string = report.vehicle
  const calls: CallSummary[] = (report.calls ?? []).map((c: any) => ({
    id: c.id, number: c.number ?? null, date: c.date, dueDate: c.due_date ?? null, description: c.description ?? null,
    total: r2(num(c.total)), received: r2(num(c.funded)), outstanding: r2(num(c.outstanding)), status: c.status, overdue: !!c.overdue,
  }))
  const args = { vehicle, ...(call ? { call } : {}) }
  const base = { view: 'calls' as const, args, generatedAt: new Date().toISOString(), branding }
  if (calls.length === 0) {
    return { ...base, title: VIEW_LABEL.calls, subtitle: vehicle, data: { vehicle, calls, selected: null } }
  }

  const chosen = pickCall(calls, call)
  const raw = (report.calls as any[]).find(c => c.id === chosen.id)
  const lines: CallLine[] = (raw.lines ?? []).map((l: any) => ({
    lp: l.lp,
    called: r2(num(l.amount)),
    received: r2(num(l.funded)),
    outstanding: r2(num(l.outstanding)),
    status: l.status === 'settled' ? 'paid' : l.status === 'partial' ? 'partial' : l.says_wired ? 'says_wired' : 'unpaid',
    overdue: !!l.overdue,
    receivedOn: l.funded_on ?? null,
    saysWired: l.says_wired ?? null,
  }))
  const label = `${chosen.number != null ? `Call #${chosen.number}` : 'Capital call'} · ${shortDate(chosen.date)}`
  return {
    ...base,
    title: VIEW_LABEL.calls,
    subtitle: [vehicle, label].join(' · '),
    data: { vehicle, calls, selected: { ...chosen, lines } },
  }
}

const VIEW_BUILDERS: Record<DashboardView, (ctx: AgentToolContext, input: any) => Promise<DashboardPayload>> = {
  portfolio: portfolioView,
  company: companyView,
  statements: statementsView,
  lps: lpView,
  calls: callsView,
}

/**
 * The domain each view reads. MUST agree with the `show_*` tool that renders it: this is what
 * `open_dashboard` checks, and `dashboard-tools.test.ts` pins the two together so a view cannot
 * be reachable through a saved dashboard on a weaker grant than through its own tool.
 */
export const VIEW_ACCESS_DOMAIN: Record<DashboardView, Domain> = {
  portfolio: 'portfolio',
  company: 'portfolio',
  statements: 'accounting',
  lps: 'lp_capital',
  calls: 'lp_capital',
}

/** Null when the caller may open this view; otherwise the refusal to return. */
export function viewDenial(access: AccessContext, view: DashboardView): string | null {
  const domain = VIEW_ACCESS_DOMAIN[view]
  if (hasAccess(access, domain, 'read')) return null
  return `This credential's owner does not have access to ${DOMAIN_META[domain].label}.`
}

// ---------------------------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------------------------

function requireUser(ctx: AgentToolContext): string {
  // Every MCP credential resolves to a member. The context type allows null for callers that
  // have no user (none of which reach these tools), and a saved dashboard without an owner
  // would be readable by nobody and deletable by nobody.
  if (!ctx.userId) throw new Error('Saved dashboards need a signed-in member.')
  return ctx.userId
}

/**
 * Which dashboards this caller may be told about.
 *
 * Two tests, and a shared dashboard must pass both:
 *   - the view's domain (`viewDenial`), so a colleague's "Carry by partner" is not listed for a
 *     member without that area: its name alone says something;
 *   - the caller's ENTITIES. A recipe names a vehicle or a company, and a member scoped to Fund I
 *     is not shown Fund II's name by `list_vehicles` or a Fund II company by `list_companies`.
 *     A shared recipe pointing at either would show them exactly that, so it is withheld.
 *
 * The caller's own dashboards skip the second test (they wrote the names) and, when resolving,
 * the first: asking for your own dashboard after losing the grant gets the refusal that explains
 * why, not "no such dashboard".
 */
async function dashboardVisibility(ctx: AgentToolContext): Promise<{
  listed: (d: SavedDashboardSummary) => boolean
  resolvable: (d: SavedDashboardSummary) => boolean
}> {
  const scope = await entityScopeFor(ctx.admin, ctx.access)
  const vehicles = scope.vehicleNames === null ? null : new Set(scope.vehicleNames.map(n => n.toLowerCase()))
  const companies = scope.companyIds === null ? null : new Set(scope.companyIds)

  const inScope = (d: SavedDashboardSummary) => {
    const vehicle = typeof d.arguments.vehicle === 'string' ? d.arguments.vehicle : null
    const company = typeof d.arguments.company === 'string' ? d.arguments.company : null
    if (vehicle && vehicles && !vehicles.has(vehicle.toLowerCase())) return false
    // Saved as an id (see `canonical`). Anything else is not something a scoped caller can be
    // shown to be theirs, so it is not shown.
    if (company && companies && !companies.has(company)) return false
    return true
  }
  const allowed = (d: SavedDashboardSummary) => viewDenial(ctx.access, d.view) === null
  return {
    listed: d => allowed(d) && (d.kind !== 'shared' || inScope(d)),
    resolvable: d => d.kind === 'mine' || (allowed(d) && (d.kind !== 'shared' || inScope(d))),
  }
}

/**
 * A recipe with its names resolved to what they name: the vehicle's stored spelling, the
 * company's id. Both through the caller's own access, so nobody saves (or shares) a pointer to
 * something they cannot see, and a stored argument is never free text a colleague's assistant
 * would later read. A company saved by id also survives the company being renamed.
 */
async function canonical(ctx: AgentToolContext, params: Record<string, string>): Promise<Record<string, string>> {
  const out = { ...params }
  if (out.vehicle) out.vehicle = await resolveVehicle(ctx.admin, ctx.fundId, out.vehicle, { access: ctx.access })
  if (out.company) out.company = (await resolveCompany(ctx.admin, ctx.fundId, out.company, ctx.access)).id
  return out
}

/**
 * The home dashboard: what this member can open, what they saved, what to ask. Everything in it
 * is filtered by their own access — a dashboard tile only for a view `viewDenial` allows, a
 * statements tile only for an entity they can see, questions only for areas they can read.
 */
async function homeView(ctx: AgentToolContext): Promise<HomePayload> {
  const canRead: CanRead = (domain, feature) => hasAccess(ctx.access, domain, 'read', feature)
  const [branding, all, visible, scope, vehicles] = await Promise.all([
    loadBranding(ctx.admin, ctx.fundId),
    ctx.userId ? listDashboards(ctx.admin, ctx.fundId, ctx.userId) : Promise.resolve([] as SavedDashboardSummary[]),
    dashboardVisibility(ctx),
    entityScopeFor(ctx.admin, ctx.access),
    listVehicles(ctx.admin, ctx.fundId).catch(() => [] as string[]),
  ])
  const mine = scope.vehicleNames === null ? vehicles : vehicles.filter(v => scope.vehicleNames!.includes(v))

  const dashboards: HomePayload['data']['dashboards'] = []
  if (!viewDenial(ctx.access, 'portfolio')) {
    dashboards.push({ view: 'portfolio', label: VIEW_LABEL.portfolio, description: 'Cost, fair value and MOIC, by company. Click a company to drill in.', tool: 'show_portfolio_dashboard', args: {} })
  }
  if (!viewDenial(ctx.access, 'statements')) {
    // One tile per entity, up to four: the statements are always for one set of books.
    for (const v of mine.slice(0, 4)) {
      dashboards.push({ view: 'statements', label: `Statements — ${v}`, description: 'Balance sheet, income, cash flows and partners\' capital, year to date.', tool: 'show_financial_statements', args: { vehicle: v, period: 'ytd' } })
    }
  }
  if (!viewDenial(ctx.access, 'lps')) {
    dashboards.push({ view: 'lps', label: VIEW_LABEL.lps, description: 'Commitments, calls, distributions and NAV by investor.', tool: 'show_lp_dashboard', args: {} })
    // The latest call on the member's first entity; the dashboard itself switches between calls.
    const callsVehicle = mine[0]
    if (callsVehicle) dashboards.push({ view: 'calls', label: VIEW_LABEL.calls, description: 'Who has paid the latest call, who says they wired, and who still owes.', tool: 'show_capital_calls', args: { vehicle: callsVehicle } })
  }

  const saved = all.filter(d => d.kind !== 'standard' && visible.listed(d)).slice(0, 8)
  const areas = areasFor(canRead).map(a => ({ key: a.key, label: a.label, blurb: a.blurb, questions: a.questions }))
  const help = helpText({
    fundName: branding.fundName,
    canRead,
    dashboards: dashboards.map(d => d.label),
    saved: saved.map(d => d.name),
  })
  return {
    view: 'home',
    title: branding.fundName ? `${branding.fundName} — home` : 'Home',
    subtitle: 'What you can open, and what to ask',
    args: {},
    generatedAt: new Date().toISOString(),
    branding,
    data: { dashboards, saved, areas, tips: DASHBOARD_TIPS, help },
  }
}

export const DASHBOARD_HANDLERS: Record<string, AgentToolHandler> = {
  show_home: homeView,
  show_portfolio_dashboard: portfolioView,
  show_company_dashboard: companyView,
  show_financial_statements: statementsView,
  show_lp_dashboard: lpView,
  show_capital_calls: callsView,

  list_dashboards: async (ctx: AgentToolContext) => {
    const [all, visible] = await Promise.all([
      listDashboards(ctx.admin, ctx.fundId, requireUser(ctx)),
      dashboardVisibility(ctx),
    ])
    // Only what this member could actually open, and only what they may be told exists.
    return { dashboards: all.filter(visible.listed) }
  },

  open_dashboard: async (ctx: AgentToolContext, input: any) => {
    const visible = await dashboardVisibility(ctx)
    const dashboard = await resolveDashboard(ctx.admin, ctx.fundId, requireUser(ctx), input?.dashboard, visible.resolvable)
    const denied = viewDenial(ctx.access, dashboard.view)
    if (denied) throw new Error(denied)
    const payload = await VIEW_BUILDERS[dashboard.view](ctx, sanitizeArguments(dashboard.view, dashboard.arguments))
    // Under the name the member gave it, so the view's heading is the dashboard they asked for.
    return dashboard.kind === 'standard' ? payload : { ...payload, title: dashboard.name }
  },

  save_dashboard: async (ctx: AgentToolContext, input: any) => {
    const userId = requireUser(ctx)
    const recipe = parseSave(input ?? {})
    // Saving a view the member cannot open would only ever produce a refusal later.
    const denied = viewDenial(ctx.access, recipe.view)
    if (denied) throw new Error(denied)
    const saved = await saveDashboard(ctx.admin, ctx.fundId, userId, { ...recipe, params: await canonical(ctx, recipe.params) })
    return { saved, note: `Saved. Ask for "${saved.name}" in any conversation to open it with current figures.` }
  },

  delete_dashboard: async (ctx: AgentToolContext, input: any) => {
    const visible = await dashboardVisibility(ctx)
    return deleteDashboard(ctx.admin, ctx.fundId, requireUser(ctx), input?.dashboard, visible.resolvable)
  },
}

export interface DashboardTool extends DashboardToolMeta {
  handler: AgentToolHandler
}

export const DASHBOARD_TOOLS: DashboardTool[] = DASHBOARD_TOOL_MANIFEST.map(meta => {
  const handler = DASHBOARD_HANDLERS[meta.name]
  if (!handler) throw new Error(`No handler for dashboard tool ${meta.name}`)
  return { ...meta, handler }
})
