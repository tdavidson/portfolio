// The query tools' loaders (catalog.ts names the datasets). Each loads its rows through the handler
// a named tool already uses, so the same entity scope, the same carry folding and the same figures;
// the query handler has checked that tool's access before calling it.

import type { AgentToolContext } from '@/lib/accounting/agent-tools'
import { visibleCompanyIds } from '@/lib/access/scope'
import { carryRecipientIds, seesIndividualCarry } from '@/lib/access/carry-visibility'
import { vehicleIdByName } from '@/lib/accounting/vehicle-id'
import { fetchAllRows } from '@/lib/accounting/load'
import { ACTUAL_BOOK } from '@/lib/accounting/books'
import { PORTFOLIO_HANDLERS } from '@/lib/agent/portfolio-tools'
import { LP_HANDLERS } from '@/lib/agent/lp-tools'
import { DEALS_HANDLERS } from '@/lib/agent/deals-tools'
import { DILIGENCE_HANDLERS } from '@/lib/agent/diligence-tools'
import { resolveVehicle } from '@/lib/accounting/vehicle-resolver'
import { loadPostedLedger, loadEntityNames } from '@/lib/accounting/load'
import { computeCapitalAccounts } from '@/lib/accounting/capital-account'
import { combineCarryRecipients } from '@/lib/access/carry-visibility'
import { getSeries, listPlans, type ForecastServiceContext } from '@/lib/forecast/service'
import { entityScopeFor } from '@/lib/access/entity-scope'
import { holdingTypeLabel, loadHoldingMarks, markChangeOf, markSourceOf, daysBetween } from '@/lib/portfolio/mark-status'

export interface DatasetParams { vehicle?: string; as_of?: string }
type Loader = (ctx: AgentToolContext, params: DatasetParams) => Promise<Record<string, unknown>[]>

type Row = Record<string, unknown>
const num = (v: unknown) => (v === null || v === undefined || v === '' ? null : Number(v))
const date = (v: unknown) => (v ? String(v).slice(0, 10) : null)

// ---------------------------------------------------------------------------------------------
// Portfolio
// ---------------------------------------------------------------------------------------------

const positions: Loader = async (ctx, p) => {
  const out = await PORTFOLIO_HANDLERS.portfolio_summary(ctx, { vehicle: p.vehicle, as_of: p.as_of })
  const rows = out.positions as any[]
  // When each was last marked, by the holding page's rule (lib/portfolio/mark-status.ts).
  const scope = await entityScopeFor(ctx.admin, ctx.access)
  const vehicleId = p.vehicle ? await vehicleIdByName(ctx.admin, ctx.fundId, p.vehicle) : null
  const marks = await loadHoldingMarks(ctx.admin, ctx.fundId, rows.map(r => r.companyId), {
    access: ctx.access, vehicleNames: scope.vehicleNames, vehicle: p.vehicle ?? null, vehicleId, asOf: out.asOf,
  })
  return rows.map(r => {
    const m = marks.get(r.companyId)
    return {
      company: r.company, company_id: r.companyId, holding_type: holdingTypeLabel(r.kind), status: r.status, stage: r.stage, industry: r.industry ?? [],
      invested: r.invested, cost: r.cost, fair_value: r.fairValue, unrealized: r.unrealized, realized: r.realized,
      moic: r.moic, pct_of_portfolio: r.pctOfPortfolio,
      last_mark_date: m?.lastMarkDate ?? null, last_mark_source: m?.lastMarkSource ?? null,
      last_nav_statement_date: m?.lastNavStatementDate ?? null, last_nav_statement_nav: m?.lastNavStatementNav ?? null,
      mark_age_days: m?.lastMarkDate ? daysBetween(m.lastMarkDate, out.asOf) : null,
    }
  })
}

const companies: Loader = async (ctx, p) => {
  const rows = await PORTFOLIO_HANDLERS.list_companies(ctx, { vehicle: p.vehicle }) as any[]
  return rows.map(c => ({ company: c.name, company_id: c.id, status: c.status, stage: c.stage, industry: c.industry ?? [], vehicles: c.vehicles ?? [] }))
}

/**
 * Every holding's name and kind, whatever its kind: companies, fund holdings and digital assets.
 * list_companies lists companies only, so naming transactions from it left every fund holding's
 * and digital asset's rows with no name.
 */
async function holdingNames(ctx: AgentToolContext): Promise<Map<string, { name: string; type: string }>> {
  const visible = await visibleCompanyIds(ctx.admin, ctx.access)
  const rows = await fetchAllRows<any>((f, t) => {
    let q = (ctx.admin as any).from('companies').select('id, name, holding_type').eq('fund_id', ctx.fundId)
    if (visible !== null) q = q.in('id', visible.length ? visible : ['00000000-0000-0000-0000-000000000000'])
    return q.order('id').range(f, t)
  })
  return new Map(rows.map(c => [c.id, { name: c.name, type: holdingTypeLabel(c.holding_type) }]))
}

const transactions: Loader = async (ctx, p) => {
  const [rows, names, navs] = await Promise.all([
    PORTFOLIO_HANDLERS.list_investments(ctx, { vehicle: p.vehicle }) as Promise<any[]>,
    holdingNames(ctx),
    // Which value changes a manager NAV statement booked (mark_source nav_statement).
    fetchAllRows<any>((f, t) => (ctx.admin as any).from('fund_nav_statements').select('investment_transaction_id')
      .eq('fund_id', ctx.fundId).not('investment_transaction_id', 'is', null).order('investment_transaction_id').range(f, t)),
  ])
  const navTxnIds = new Set<string>(navs.map(n => n.investment_transaction_id))
  return rows.map(t => ({
    date: date(t.transaction_date), company: names.get(t.company_id)?.name ?? null, company_id: t.company_id,
    holding_type: names.get(t.company_id)?.type ?? null, vehicle: t.portfolio_group ?? null,
    type: t.transaction_type, round: t.round_name ?? null, security: t.security_type ?? null,
    invested: num(t.investment_cost), shares: num(t.shares_acquired), share_price: num(t.share_price),
    postmoney: num(t.postmoney_valuation), proceeds: num(t.proceeds_received), ownership_pct: num(t.ownership_pct),
    mark_change: markChangeOf(t), mark_source: markSourceOf(t, navTxnIds),
  }))
}

const kpis: Loader = async (ctx) => {
  const db = ctx.admin as any
  const visible = await visibleCompanyIds(ctx.admin, ctx.access)
  let q = db.from('companies').select('id, name').eq('fund_id', ctx.fundId).eq('holding_type', 'company')
  if (visible !== null) q = q.in('id', visible.length ? visible : ['00000000-0000-0000-0000-000000000000'])
  const { data: cos } = await q
  const names = new Map(((cos ?? []) as any[]).map(c => [c.id, c.name]))
  if (names.size === 0) return []
  const metrics = await fetchAllRows<any>((f, t) => db.from('metrics').select('id, name, unit, company_id').in('company_id', [...names.keys()]).order('id').range(f, t))
  const byId = new Map(metrics.map(m => [m.id, m]))
  if (byId.size === 0) return []
  const values: any[] = []
  const ids = [...byId.keys()]
  for (let i = 0; i < ids.length; i += 200) {
    const chunk = ids.slice(i, i + 200)
    values.push(...await fetchAllRows<any>((f, t) => db.from('metric_values')
      .select('metric_id, period_label, period_year, period_quarter, period_month, value_number, value_text').in('metric_id', chunk).order('id').range(f, t)))
  }
  return values.map(v => {
    const m = byId.get(v.metric_id)
    return {
      company: names.get(m.company_id) ?? null, company_id: m.company_id, metric: m.name, unit: m.unit ?? null,
      period: v.period_label, year: num(v.period_year), quarter: num(v.period_quarter), month: num(v.period_month),
      value: num(v.value_number), value_text: v.value_text ?? null,
    }
  })
}

// ---------------------------------------------------------------------------------------------
// LPs
// ---------------------------------------------------------------------------------------------

const lpPositions: Loader = async (ctx, p) => {
  const out = await LP_HANDLERS.lp_live_report(ctx, { vehicle: p.vehicle, as_of: p.as_of })
  return (out.rows as any[]).map(r => ({
    investor: r.investor, entity: r.entity, vehicle: r.vehicle,
    commitment: r.commitment, called_capital: r.called_capital, paid_in_capital: r.paid_in_capital,
    unfunded: Math.round((r.commitment - r.called_capital) * 100) / 100,
    distributions: r.distributions, nav: r.nav, total_value: r.total_value,
    dpi: r.dpi, rvpi: r.rvpi, tvpi: r.tvpi, irr: r.irr,
    paid_in_pct: r.commitment > 0 ? Math.round((r.paid_in_capital / r.commitment) * 10000) / 100 : null,
  }))
}

const capitalCallLines: Loader = async (ctx, p) => {
  const out = await LP_HANDLERS.lp_capital_calls(ctx, { vehicle: p.vehicle })
  return (out.calls as any[]).flatMap(c => (c.lines as any[]).map(l => ({
    vehicle: out.vehicle, call_number: c.number, call_date: date(c.date), due_date: date(c.due_date),
    lp: l.lp, amount: l.amount, funded: l.funded, outstanding: l.outstanding, status: l.status,
    overdue: !!l.overdue, funded_on: date(l.funded_on), says_wired: !!l.says_wired,
  })))
}

/**
 * The vehicle a per-vehicle dataset reads, for a tool that is not a ledger tool: the one named, or
 * the member's only one. Only their own entities, and never a management company (whose books
 * answer to a grant these datasets do not check).
 */
const vehicleFor = (ctx: AgentToolContext, p: DatasetParams) =>
  ctx.portfolioGroup || resolveVehicle(ctx.admin, ctx.fundId, p.vehicle, { access: ctx.access })

const capitalAccounts: Loader = async (ctx, p) => {
  const group = await vehicleFor(ctx, p)
  // As capital_accounts builds it, with the as-of date the tool leaves at "everything posted".
  const [{ capitalPostings }, names] = await Promise.all([
    loadPostedLedger(ctx.admin, ctx.fundId, group, p.as_of),
    loadEntityNames(ctx.admin, ctx.fundId, group),
  ])
  const all = Array.from(computeCapitalAccounts(capitalPostings).entries()).map(([id, a]) => ({ id, name: names.get(id) ?? id, ...a }))
  const rows = seesIndividualCarry(ctx.access) ? all : combineCarryRecipients(all, await carryRecipientIds(ctx.admin, ctx.fundId, group)).rows
  return rows.map(r => ({
    partner: r.name, contributions: r.contributions, distributions: r.distributions,
    management_fees: r.managementFees, expenses: r.expenses, operating_income: r.operatingIncome,
    realized_gains: r.realizedGains, unrealized_gains: r.unrealizedGains, fx_translation: r.fxTranslation,
    transfers: r.transfers, carried_interest: r.carriedInterest, unclassified: r.unclassified, ending: r.ending,
  }))
}

// ---------------------------------------------------------------------------------------------
// Fund performance and financials
// ---------------------------------------------------------------------------------------------

const fundPerformance: Loader = async (ctx, p) => {
  const rows = await PORTFOLIO_HANDLERS.fund_performance(ctx, { vehicle: p.vehicle, as_of: p.as_of }) as any[]
  return rows.map(v => ({
    vehicle: v.vehicle, committed: v.committed, called: v.called, unfunded: v.unfunded, distributed: v.distributed, nav: v.nav,
    dpi: v.dpi, rvpi: v.rvpi, tvpi: v.tvpi,
    net_lp_irr: typeof v.net_lp_irr === 'number' ? Math.round(v.net_lp_irr * 10000) / 100 : null,
    carry_accrued: v.carry_accrued, gross_nav: v.whole_fund?.nav ?? null, gross_tvpi: v.whole_fund?.tvpi ?? null,
    basis: String(v.basis ?? '').startsWith('From imported') ? 'imported balances' : String(v.basis ?? '').includes('plus imported') ? 'mixed' : 'books',
  }))
}

const forecastCtx = ({ admin, fundId, userId, access }: AgentToolContext): ForecastServiceContext => ({ admin, fundId, userId: userId ?? '', access })

/** YYYY-MM, shifted by whole months. */
function monthKey(iso: string | undefined, shift: number): string {
  const d = iso ? new Date(`${iso.slice(0, 10)}T00:00:00Z`) : new Date()
  const m = d.getUTCFullYear() * 12 + d.getUTCMonth() + shift
  return `${Math.floor(m / 12)}-${String((m % 12) + 1).padStart(2, '0')}`
}

function lineRows(series: Awaited<ReturnType<typeof getSeries>>, extra: Row = {}): Row[] {
  const rows: Row[] = []
  series.periods.forEach((period, i) => {
    for (const l of series.lines) {
      const amount = l.values[i] ?? 0
      if (!amount) continue
      rows.push({
        ...extra, month: `${period.key.slice(0, 7)}-01`, account_code: l.code, account_name: l.name, type: l.type,
        amount: Math.round(amount * 100) / 100, net: Math.round((l.type === 'income' ? amount : -amount) * 100) / 100, status: period.status,
      })
    }
  })
  return rows
}

const pnlByMonth: Loader = async (ctx, p) => {
  const vehicle = await vehicleFor(ctx, p)
  const series = await getSeries(forecastCtx(ctx), { vehicle, view: 'actual', start: monthKey(p.as_of, -35), end: monthKey(p.as_of, 0), interval: 'month' })
  return lineRows(series)
}

const cashByMonth: Loader = async (ctx, p) => {
  const vehicle = await vehicleFor(ctx, p)
  const s = await getSeries(forecastCtx(ctx), { vehicle, view: 'actual', start: monthKey(p.as_of, -35), end: monthKey(p.as_of, 0), interval: 'month' })
  const flow = (k: string, i: number) => (s.cashFlows ? (s.cashFlows as Record<string, number[]>)[k]?.[i] ?? 0 : null)
  return s.periods.map((period, i) => ({
    month: `${period.key.slice(0, 7)}-01`,
    opening: s.cash[i]?.opening ?? null, movement: s.cash[i]?.movement ?? null, ending: s.cash[i]?.ending ?? null,
    operating: flow('operating', i), invested: flow('invested', i), proceeds: flow('proceeds', i), called: flow('called', i),
    distributed: flow('distributed', i), borrowed: flow('borrowed', i), repaid: flow('repaid', i),
    status: period.status,
  }))
}

const forecastByMonth: Loader = async (ctx, p) => {
  const vehicle = await vehicleFor(ctx, p)
  const { plans } = await listPlans(forecastCtx(ctx), { vehicle })
  const plan = plans.find(x => x.kind === 'rolling_forecast') ?? plans[0]
  if (!plan) throw new Error(`${vehicle} has no forecast plan yet. Make one on its Forecast page.`)
  const series = await getSeries(forecastCtx(ctx), { vehicle, planId: plan.id, view: 'combined', start: monthKey(p.as_of, -12), end: monthKey(p.as_of, 24), interval: 'month' })
  return lineRows(series, { plan: plan.name })
}

// ---------------------------------------------------------------------------------------------
// Deals and diligence
// ---------------------------------------------------------------------------------------------

const inboundDeals: Loader = async (ctx) => {
  const rows = await DEALS_HANDLERS.deals_list_inbound(ctx, { limit: 500 }) as any[]
  return rows.map(d => ({
    company: d.company, founder: d.founder, intro_source: d.intro_source, referrer: d.referrer, thesis_fit: d.thesis_fit,
    stage: d.stage, industry: d.industry, raise: d.raise, status: d.status, in_diligence: !!d.in_diligence, created_at: date(d.created_at),
  }))
}

const diligenceDeals: Loader = async (ctx) => {
  const rows = await DILIGENCE_HANDLERS.diligence_list_deals(ctx, {}) as any[]
  return rows.map(d => ({ name: d.name, sector: d.sector, stage: d.stage, status: d.status, memo_stage: d.memo_stage, created_at: date(d.created_at) }))
}

// ---------------------------------------------------------------------------------------------
// The books
// ---------------------------------------------------------------------------------------------

const journalLines: Loader = async (ctx, p) => {
  const db = ctx.admin as any
  const group = ctx.portfolioGroup
  const vehicleId = await vehicleIdByName(ctx.admin, ctx.fundId, group)
  if (!vehicleId) throw new Error(`Unknown vehicle "${group}"`)
  const [accounts, entries, postings, ents] = await Promise.all([
    fetchAllRows<any>((f, t) => db.from('chart_of_accounts').select('id, code, name, type').eq('fund_id', ctx.fundId).eq('vehicle_id', vehicleId).order('id').range(f, t)),
    fetchAllRows<any>((f, t) => {
      let q = db.from('journal_entries').select('id, entry_date, memo, source_type').eq('book', ACTUAL_BOOK).eq('fund_id', ctx.fundId).eq('vehicle_id', vehicleId).eq('status', 'posted')
      if (p.as_of) q = q.lte('entry_date', p.as_of)
      return q.order('id').range(f, t)
    }),
    fetchAllRows<any>((f, t) => db.from('journal_postings').select('journal_entry_id, account_id, amount, lp_entity_id').eq('book', ACTUAL_BOOK).eq('fund_id', ctx.fundId).eq('vehicle_id', vehicleId).order('id').range(f, t)),
    db.from('lp_entities').select('id, entity_name').eq('fund_id', ctx.fundId),
  ])
  // What each carry recipient earns is GP economics, as on capital_accounts.
  const hidden = seesIndividualCarry(ctx.access) ? new Set<string>() : await carryRecipientIds(ctx.admin, ctx.fundId, group)
  const acct = new Map(accounts.map(a => [a.id, a]))
  const entry = new Map(entries.map(e => [e.id, e]))
  const entName = new Map(((ents.data ?? []) as any[]).map(e => [e.id, e.entity_name]))
  const rows: Row[] = []
  for (const pst of postings) {
    const e = entry.get(pst.journal_entry_id)
    if (!e) continue
    const a = acct.get(pst.account_id)
    const amount = Number(pst.amount)
    rows.push({
      date: date(e.entry_date), entry_id: e.id, memo: e.memo ?? null, source: e.source_type ?? null,
      account_code: a?.code ?? null, account_name: a?.name ?? null, account_type: a?.type ?? null,
      debit: amount > 0 ? amount : 0, credit: amount < 0 ? -amount : 0, amount,
      lp: pst.lp_entity_id && !hidden.has(pst.lp_entity_id) ? entName.get(pst.lp_entity_id) ?? null : pst.lp_entity_id ? 'Carried interest recipients' : null,
    })
  }
  return rows
}

/** By dataset name (catalog.ts). */
export const QUERY_LOADERS: Record<string, Loader> = {
  positions, companies, transactions, kpis,
  lp_positions: lpPositions, capital_call_lines: capitalCallLines, capital_accounts: capitalAccounts,
  fund_performance: fundPerformance, pnl_by_month: pnlByMonth, cash_by_month: cashByMonth, forecast_by_month: forecastByMonth,
  inbound_deals: inboundDeals, diligence_deals: diligenceDeals,
  journal_lines: journalLines,
}
