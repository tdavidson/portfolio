// The document tools (report-tools-manifest.ts). Each resolves and validates what to render, with
// the caller's access, and returns a signed link; the document is built when the link is opened,
// after the member's access is checked again (app/api/agent/reports/[token]). Validation happens
// here so a bad request fails in the conversation, not on a link that 404s later.

import { hasAccess } from '@/lib/access/effective'
import { canSeeVehicle } from '@/lib/access/scope'
import type { AgentToolContext, AgentToolHandler } from '@/lib/accounting/agent-tools'
import { resolveVehicle } from '@/lib/accounting/vehicle-resolver'
import { vehicleIdByName } from '@/lib/accounting/vehicle-id'
import { lastQuarterEnd, PERFORMANCE_GROUPINGS, type PerformanceGrouping } from '@/lib/accounting/fund-performance'
import { customPeriod, resolvePeriod, type PeriodPreset } from '@/lib/accounting/statement-period'
import { linkNote, reportLinkUrl, signReportLink, type ReportKind } from '@/lib/agent/report-links'
import { loadIdentities, lpToolScope, resolveLp, resolveSnapshot } from '@/lib/agent/lp-tools'
import { siteOrigin } from '@/lib/site-links'
import { listPlans } from '@/lib/forecast/service'
import { monthDiff } from '@/lib/forecast/months'

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/
const MONTH = /^\d{4}-(0[1-9]|1[0-2])$/
const STATEMENT_PRESETS: PeriodPreset[] = ['this_quarter', 'last_quarter', 'ytd', 'prior_year', 'itd']
const NOTE = linkNote('It opens the document for an hour, and only for this member. If they ask again later, call this tool again rather than re-sharing this link.')

function isoDate(v: unknown, label: string): string | null {
  if (v === undefined || v === null || v === '') return null
  const s = String(v)
  if (!ISO_DATE.test(s)) throw new Error(`${label} must be an ISO date (YYYY-MM-DD)`)
  return s
}

function taxYear(v: unknown): number {
  if (v === undefined || v === null || v === '') return new Date().getUTCFullYear() - 1
  const n = Number(v)
  if (!Number.isInteger(n) || n < 1990 || n > 2100) throw new Error('year must be a four-digit year, e.g. 2025')
  return n
}

function requireUser(userId: string | null | undefined): string {
  if (!userId) throw new Error('Documents are issued to a signed-in member; this credential has no user.')
  return userId
}

function link(ctx: AgentToolContext, userId: string, kind: ReportKind, args: Record<string, string | null>) {
  const { token, expiresAt } = signReportLink({ fundId: ctx.fundId, userId, kind, args })
  return { url: reportLinkUrl(ctx.origin ?? siteOrigin(), token), expires_at: expiresAt, note: NOTE }
}

export const REPORT_HANDLERS: Record<string, AgentToolHandler> = {
  fund_performance_pdf: async (ctx: AgentToolContext, input: any) => {
    const userId = requireUser(ctx.userId)
    const vehicle = await resolveVehicle(ctx.admin, ctx.fundId, input?.vehicle ? String(input.vehicle) : undefined, { access: ctx.access })
    const asOf = isoDate(input?.as_of, 'as_of') ?? lastQuarterEnd(new Date().toISOString().slice(0, 10))
    const grouping = (input?.group_by ? String(input.group_by) : 'month') as PerformanceGrouping
    if (!PERFORMANCE_GROUPINGS.includes(grouping)) throw new Error('group_by must be date, month or quarter')
    return {
      document: 'Fund performance report (PDF)', vehicle, as_of: asOf,
      ...link(ctx, userId, 'fund_performance', { vehicle, as_of: asOf, group_by: grouping }),
    }
  },

  financial_statements_pdf: async (ctx: AgentToolContext, input: any) => {
    const userId = requireUser(ctx.userId)
    const vehicle = await resolveVehicle(ctx.admin, ctx.fundId, input?.vehicle ? String(input.vehicle) : undefined, { access: ctx.access })
    const start = isoDate(input?.start, 'start')
    const end = isoDate(input?.end, 'end')
    const preset = (input?.period ? String(input.period) : 'ytd') as PeriodPreset
    if (!start && !end && !STATEMENT_PRESETS.includes(preset)) throw new Error(`period must be one of ${STATEMENT_PRESETS.join(', ')}`)
    // Resolved now, so "last quarter" cannot become a different quarter between the conversation and the click.
    const period = start || end ? customPeriod(start, end) : resolvePeriod(preset)
    const compare = input?.compare === undefined || input?.compare === null ? 0 : Number(input.compare)
    if (!Number.isInteger(compare) || compare < 0 || compare > 4) throw new Error('compare must be a whole number from 0 to 4')
    const basis = input?.basis ? String(input.basis) : 'book'
    if (basis !== 'book' && basis !== 'tax') throw new Error('basis must be book or tax')
    return {
      document: 'Financial statements (PDF)', vehicle, period: period.label, basis,
      ...link(ctx, userId, 'financial_statements', {
        vehicle, start: period.start, end: period.end,
        compare: compare > 0 ? String(compare) : null, basis: basis === 'tax' ? 'tax' : null,
      }),
    }
  },

  forecast_workbook: async (ctx: AgentToolContext, input: any) => {
    const userId = requireUser(ctx.userId)
    if (typeof input?.vehicle !== 'string' || !input.vehicle.trim()) throw new Error('vehicle is required')
    const year = new Date().getUTCFullYear()
    const start = input?.start ? String(input.start) : `${year}-01`
    const end = input?.end ? String(input.end) : `${year}-12`
    if (!MONTH.test(start) || !MONTH.test(end)) throw new Error('start and end must be months, YYYY-MM')
    if (end < start) throw new Error('end is before start')
    if (monthDiff(start, end) > 240) throw new Error('The range is at most 240 months')
    const interval = input?.interval ? String(input.interval) : 'month'
    if (!['month', 'quarter', 'year'].includes(interval)) throw new Error('interval must be month, quarter or year')
    const view = input?.view ? String(input.view) : null
    if (view && !['actual', 'plan', 'combined'].includes(view)) throw new Error('view must be actual, plan or combined')
    // The forecast service's own checks, now: accounting, the entity, a management company's grant.
    const { vehicle, plans } = await listPlans({ admin: ctx.admin, fundId: ctx.fundId, userId, access: ctx.access }, { vehicle: input.vehicle })
    const plan = view === 'actual' ? null
      : input?.planId ? plans.find(p => p.id === String(input.planId)) ?? null
      : plans.find(p => p.isPrimary) ?? null
    if (input?.planId && view !== 'actual' && !plan) throw new Error(`No plan ${input.planId} for ${vehicle}; forecast_list_plans lists them.`)
    if (input?.versionId && !plan?.versions.some(v => v.id === String(input.versionId))) throw new Error('That version is not one of the plan\'s; forecast_list_plans lists them.')
    return {
      document: 'Forecast workbook (Excel)', vehicle, plan: plan ? plan.name : 'Actuals only', range: `${start} – ${end}`, interval,
      ...link(ctx, userId, 'forecast_workbook', {
        vehicle, plan: plan?.id ?? null, version: plan && input?.versionId ? String(input.versionId) : null,
        view: plan ? view : 'actual', start, end, interval,
      }),
    }
  },

  tax_package_zip: async (ctx: AgentToolContext, input: any) => {
    const userId = requireUser(ctx.userId)
    const vehicle = await resolveVehicle(ctx.admin, ctx.fundId, input?.vehicle ? String(input.vehicle) : undefined, { access: ctx.access })
    const year = taxYear(input?.year)
    const k1 = hasAccess(ctx.access, 'gp_economics', 'read') && hasAccess(ctx.access, 'lp_capital', 'read')
    return {
      document: 'Tax package (ZIP)', vehicle, year,
      k1_workbook: k1 ? 'included when the year has a final K-1 package' : "left out: it holds each partner's figures and the carry, which this member's access does not cover",
      ...link(ctx, userId, 'tax_package', { vehicle, year: String(year) }),
    }
  },

  schedule_k_pdf: async (ctx: AgentToolContext, input: any) => {
    const userId = requireUser(ctx.userId)
    // The K-1 route's own check (lib/tax/access.ts): a K-1 holds the carried-interest allocation.
    if (!hasAccess(ctx.access, 'gp_economics', 'read')) {
      throw new Error('K-1s include the carried-interest allocation, which requires GP economics access.')
    }
    const vehicle = await resolveVehicle(ctx.admin, ctx.fundId, input?.vehicle ? String(input.vehicle) : undefined, { access: ctx.access })
    const vehicleId = await vehicleIdByName(ctx.admin, ctx.fundId, vehicle)
    const year = taxYear(input?.tax_year)
    const { data: pkg } = vehicleId
      ? await (ctx.admin as any).from('k1_packages').select('id, version, status, vehicle_id')
        .eq('fund_id', ctx.fundId).eq('vehicle_id', vehicleId).eq('tax_year', year)
        .order('version', { ascending: false }).limit(1).maybeSingle()
      : { data: null }
    if (!pkg || !canSeeVehicle(ctx.access, pkg.vehicle_id ?? null)) throw new Error(`${vehicle} has no K-1 package for ${year}.`)

    const scope = await lpToolScope(ctx.admin, ctx.access)
    const matches = resolveLp(await loadIdentities(ctx.admin, ctx.fundId, scope.entityIds), String(input?.lp ?? ''))
    const { data: partners } = await (ctx.admin as any).from('k1_partners').select('lp_entity_id')
      .eq('fund_id', ctx.fundId).eq('package_id', pkg.id)
    const inPackage = new Set(((partners as any[]) ?? []).map(p => p.lp_entity_id as string))
    const hits = matches.filter(m => inPackage.has(m.entityId))
    if (hits.length === 0) throw new Error(`"${input?.lp}" is not a partner in the ${year} K-1 package for ${vehicle}.`)
    if (hits.length > 1) {
      throw new Error(`"${input.lp}" matches ${hits.length} partners (${hits.map(h => h.entityName).join(', ')}). A K-1 is per entity, so pass one.`)
    }
    return {
      document: 'Schedule K-1 (PDF)', vehicle, tax_year: year, partner: hits[0].entityName,
      package: { version: pkg.version, status: pkg.status },
      ...link(ctx, userId, 'k1', { package: pkg.id, lp: hits[0].entityId }),
    }
  },

  lp_snapshot_pdf: async (ctx: AgentToolContext, input: any) => {
    const userId = requireUser(ctx.userId)
    // The preview route's own check: the report shows the investor everything they hold.
    if (!canSeeVehicle(ctx.access, null)) throw new Error('The investor report shows every entity the investor holds, so it needs access to every entity.')
    const snapshot = await resolveSnapshot(ctx.admin, ctx.fundId, input?.snapshot ? String(input.snapshot) : undefined)
    const identities = await loadIdentities(ctx.admin, ctx.fundId, null)
    const matches = resolveLp(identities, String(input?.investor ?? ''))
    const investors = new Map<string, string>()
    for (const m of matches) if (m.investorId) investors.set(m.investorId, m.investorName ?? m.entityName)
    if (investors.size === 0) throw new Error(`"${input?.investor}" has no investor record to report on.`)
    if (investors.size > 1) throw new Error(`"${input.investor}" matches ${investors.size} investors (${[...investors.values()].join(', ')}). Pass one.`)
    const [[investorId, investorName]] = [...investors]
    const entityIds = [...identities.values()].filter(i => i.investorId === investorId).map(i => i.entityId)
    const { data: held } = await (ctx.admin as any).from('lp_investments').select('id')
      .eq('fund_id', ctx.fundId).eq('snapshot_id', snapshot.id).in('entity_id', entityIds).limit(1)
    if (!held || held.length === 0) throw new Error(`${investorName} has no positions in the snapshot "${snapshot.name}".`)
    return {
      document: 'Investor report (PDF)', investor: investorName, snapshot: snapshot.name, as_of: snapshot.as_of_date,
      ...link(ctx, userId, 'lp_snapshot', { snapshot: snapshot.id, investor: investorId }),
    }
  },
}
