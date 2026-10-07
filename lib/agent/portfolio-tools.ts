// Handlers for the PORTFOLIO agent tools. Merged into the same registry the ledger
// tools use, so MCP and REST expose one coherent surface: an agent can ask what the
// fund owns, how it's performing, and who the LPs are — not just what's in the books.
//
// Fund-scoped by design. `vehicle` is a FILTER here, never a required scope: a company
// can be held by more than one vehicle, and portfolio-level questions span all of them.

import type { SupabaseClient } from '@supabase/supabase-js'
import { PORTFOLIO_TOOL_MANIFEST } from './portfolio-tools-manifest'
import { computeSummary } from '@/lib/investments'
import { lpRatios } from '@/lib/lp-metrics'
import { draftEntryForTransaction } from '@/lib/accounting/from-portfolio'
import type { AgentToolContext, AgentToolHandler } from '@/lib/accounting/agent-tools'
import { getUpdates } from '@/lib/company-updates/analyst'
import type { AccessContext } from '@/lib/access/effective'
import { entityScopeFor, type EntityScope } from '@/lib/access/entity-scope'
import { filterByCompany, groupWriteDenial, scopeCompanyRows, scopeGroups, scopeTransactions, visibleCompanyIds } from '@/lib/access/scope'
import { validateConversionLink } from '@/lib/accounting/conversion-link'

const r2 = (n: number) => Math.round(n * 100) / 100

/**
 * Resolve a company by id or by name. Agents are given names, not UUIDs, and failing on
 * a name would make every tool unusable in practice — but a name that matches two
 * companies must not silently pick one.
 */
export async function resolveCompany(
  admin: SupabaseClient,
  fundId: string,
  ref: string,
  /** The caller's access: only companies linked to their entities resolve. Required. */
  access: Pick<AccessContext, 'fundId' | 'vehicles'>,
): Promise<any> {
  if (!ref) throw new Error('A company id or name is required')
  const visible = await visibleCompanyIds(admin, access)
  const mine = (c: any) => visible === null || visible.includes(c.id)
  return resolveAnyCompany(admin, fundId, ref, mine, visible)
}

async function resolveAnyCompany(
  admin: SupabaseClient, fundId: string, ref: string, mine: (c: any) => boolean, visible: string[] | null,
): Promise<any> {
  const { data: byId } = await (admin as any)
    .from('companies').select('*').eq('fund_id', fundId).eq('id', ref).maybeSingle()
  if (byId && mine(byId)) return byId

  const { data: byName } = await (admin as any)
    .from('companies').select('*').eq('fund_id', fundId).ilike('name', ref)
  const rows = ((byName as any[]) ?? []).filter(mine)
  if (rows.length === 1) return rows[0]
  if (rows.length > 1) {
    throw new Error(`"${ref}" matches ${rows.length} companies — pass the company id instead.`)
  }

  // Scoped in the query, so a scoped caller still gets five suggestions of their own.
  const { data: fuzzy } = await filterByCompany((admin as any)
    .from('companies').select('id, name').eq('fund_id', fundId).ilike('name', `%${ref}%`), visible, { column: 'id' }).limit(5)
  const near = ((fuzzy as any[]) ?? []).filter(mine).map(c => c.name)
  throw new Error(
    near.length > 0
      ? `No company named "${ref}". Did you mean: ${near.join(', ')}?`
      : `No company named "${ref}" in this fund.`
  )
}

/** A company's transactions, optionally narrowed to one vehicle. */
async function txnsFor(admin: SupabaseClient, fundId: string, companyId: string, vehicle: string | undefined, scope: EntityScope): Promise<any[]> {
  const { data } = await (admin as any)
    .from('investment_transactions').select('*').eq('fund_id', fundId).eq('company_id', companyId)
  // Only the caller's entities' rows (plus company-wide price signals).
  let rows = scopeTransactions((data as any[]) ?? [], scope.vehicleNames)
  if (vehicle) {
    // Untagged pricing rows (a round the fund didn't join, a company-wide mark) re-price
    // the position in EVERY vehicle, so they must survive the filter.
    rows = rows.filter(t => t.portfolio_group === vehicle || !t.portfolio_group)
  }
  return rows
}

/** Companies in the fund, optionally narrowed to a vehicle. `portfolio_group` is text[]. */
async function companiesIn(admin: SupabaseClient, fundId: string, vehicle: string | undefined, scope: EntityScope): Promise<any[]> {
  const { data } = await (admin as any).from('companies').select('*').eq('fund_id', fundId).eq('holding_type', 'company')
  // Only companies linked to the caller's entities, naming only those entities.
  const rows = scopeCompanyRows((data as any[]) ?? [], scope.companyIds)
    .map(c => ({ ...c, portfolio_group: scopeGroups(c.portfolio_group, scope.vehicleNames) }))
  if (!vehicle) return rows
  return rows.filter(c => Array.isArray(c.portfolio_group) && c.portfolio_group.includes(vehicle))
}

export const PORTFOLIO_HANDLERS: Record<string, AgentToolHandler> = {
  // Company Updates retrieval. Fund-scoped in SQL; the company reference resolves through the
  // same resolver as every other portfolio tool so a name never silently picks the wrong company.
  get_updates: async ({ admin, fundId, access }: AgentToolContext, input: any) =>
    getUpdates(
      { admin: admin as any, fundId, resolveCompanyId: async ref => (await resolveCompany(admin, fundId, ref, access)).id, visibleCompanyIds: await visibleCompanyIds(admin, access) },
      input ?? {},
    ),

  list_vehicles: async ({ admin, fundId, access }: AgentToolContext) => {
    const { data } = await (admin as any)
      .from('fund_vehicles').select('name, kind, active').eq('fund_id', fundId).order('name')
    const vScope = await entityScopeFor(admin, access)
    return ((data as any[]) ?? []).filter(v => vScope.vehicleNames === null || vScope.vehicleNames.includes(v.name))
      .map(v => ({ vehicle: v.name, kind: v.kind, active: v.active }))
  },

  list_companies: async ({ admin, fundId, access }: AgentToolContext, input: any) => {
    let rows = await companiesIn(admin, fundId, input?.vehicle, await entityScopeFor(admin, access))
    if (input?.status) rows = rows.filter(c => c.status === input.status)
    if (input?.q) {
      const q = String(input.q).toLowerCase()
      rows = rows.filter(c =>
        String(c.name ?? '').toLowerCase().includes(q) ||
        (Array.isArray(c.industry) ? c.industry : []).some((i: string) => String(i).toLowerCase().includes(q))
      )
    }
    return rows.map(c => ({
      id: c.id,
      name: c.name,
      stage: c.stage ?? null,
      industry: c.industry ?? [],
      status: c.status,
      vehicles: c.portfolio_group ?? [],
    }))
  },

  company_detail: async ({ admin, fundId, access }: AgentToolContext, input: any) => {
    const c = await resolveCompany(admin, fundId, input?.company, access)
    const scope = await entityScopeFor(admin, access)
    const txns = await txnsFor(admin, fundId, c.id, input?.vehicle, scope)
    const summary = computeSummary(txns as any, c.status)
    return {
      id: c.id,
      name: c.name,
      stage: c.stage ?? null,
      industry: c.industry ?? [],
      status: c.status,
      vehicles: scopeGroups(c.portfolio_group, scope.vehicleNames),
      overview: c.overview ?? null,
      founders: c.founders ?? null,
      why_invested: c.why_invested ?? null,
      summary,
    }
  },

  list_investments: async ({ admin, fundId, access }: AgentToolContext, input: any) => {
    if (input?.company) {
      const c = await resolveCompany(admin, fundId, input.company, access)
      return await txnsFor(admin, fundId, c.id, input?.vehicle, await entityScopeFor(admin, access))
    }
    const scope = await entityScopeFor(admin, access)
    let q = (admin as any).from('investment_transactions').select('*').eq('fund_id', fundId)
    if (input?.vehicle) q = q.eq('portfolio_group', input.vehicle)
    const { data } = await q.order('transaction_date', { ascending: true })
    // Only the caller's companies and entities.
    return scopeTransactions(scopeCompanyRows((data as any[]) ?? [], scope.companyIds, 'company_id'), scope.vehicleNames)
  },

  portfolio_summary: async ({ admin, fundId, access }: AgentToolContext, input: any) => {
    const asOf = input?.as_of ? new Date(`${input.as_of}T00:00:00Z`) : new Date()
    const scope = await entityScopeFor(admin, access)
    const companies = await companiesIn(admin, fundId, input?.vehicle, scope)

    const positions: any[] = []
    for (const c of companies) {
      const txns = await txnsFor(admin, fundId, c.id, input?.vehicle, scope)
      if (txns.length === 0) continue
      const s = computeSummary(txns as any, c.status, asOf)
      const exited = (s.rounds ?? []).reduce((sum: number, rd: any) => sum + Math.abs(rd.costBasisExited ?? 0), 0)
      const cost = r2(s.totalInvested - exited)
      const fairValue = r2(s.unrealizedValue)
      if (cost === 0 && fairValue === 0) continue
      positions.push({
        company: c.name,
        companyId: c.id,
        status: c.status,
        stage: c.stage ?? null,
        industry: c.industry ?? [],
        cost,
        fairValue,
        unrealized: r2(fairValue - cost),
        realized: r2(s.totalRealized ?? 0),
        moic: cost > 0 ? r2((fairValue + (s.totalRealized ?? 0)) / cost) : null,
      })
    }
    positions.sort((a, b) => b.fairValue - a.fairValue)

    const totalCost = r2(positions.reduce((s, p) => s + p.cost, 0))
    const totalFairValue = r2(positions.reduce((s, p) => s + p.fairValue, 0))
    const totalRealized = r2(positions.reduce((s, p) => s + p.realized, 0))
    for (const p of positions) {
      p.pctOfPortfolio = totalFairValue ? r2((p.fairValue / totalFairValue) * 100) : 0
    }

    return {
      asOf: asOf.toISOString().slice(0, 10),
      vehicle: input?.vehicle ?? 'all',
      positions,
      totals: {
        cost: totalCost,
        fairValue: totalFairValue,
        unrealized: r2(totalFairValue - totalCost),
        realized: totalRealized,
        grossMoic: totalCost > 0 ? r2((totalFairValue + totalRealized) / totalCost) : null,
      },
    }
  },

  fund_performance: async ({ admin, fundId, access }: AgentToolContext, input: any) => {
    // Committed / called / distributed come from the LP register, which is the fund's
    // own record of what it asked for and paid out. NAV comes from the portfolio.
    const { data: lps } = await (admin as any)
      .from('lp_investments')
      .select('portfolio_group, commitment, paid_in_capital, distributions, nav')
      .eq('fund_id', fundId)

    const byVehicle = new Map<string, { committed: number; called: number; distributed: number; nav: number }>()
    const perfScope = await entityScopeFor(admin, access)
    for (const r of scopeCompanyRows((lps as any[]) ?? [], perfScope.vehicleNames, 'portfolio_group')) {
      const v = r.portfolio_group ?? '—'
      if (input?.vehicle && v !== input.vehicle) continue
      const cur = byVehicle.get(v) ?? { committed: 0, called: 0, distributed: 0, nav: 0 }
      cur.committed += Number(r.commitment ?? 0)
      cur.called += Number(r.paid_in_capital ?? 0)
      cur.distributed += Number(r.distributions ?? 0)
      cur.nav += Number(r.nav ?? 0)
      byVehicle.set(v, cur)
    }

    const out: any[] = []
    for (const [vehicle, t] of Array.from(byVehicle.entries())) {
      const called = r2(t.called)
      out.push({
        vehicle,
        committed: r2(t.committed),
        called,
        unfunded: r2(t.committed - called),
        distributed: r2(t.distributed),
        nav: r2(t.nav),
        // The standard three, via the shared definition. Denominator is paid-in ≡ called (they
        // are the same figure); null rather than Infinity when nothing has been called.
        ...(() => {
          const rr = lpRatios({ commitment: t.committed, paidIn: called, distributions: t.distributed, nav: t.nav })
          return { dpi: rr.dpi == null ? null : r2(rr.dpi), rvpi: rr.rvpi == null ? null : r2(rr.rvpi), tvpi: rr.tvpi == null ? null : r2(rr.tvpi) }
        })(),
      })
    }
    return out.sort((a, b) => String(a.vehicle).localeCompare(String(b.vehicle)))
  },

  company_metrics: async ({ admin, fundId, access }: AgentToolContext, input: any) => {
    const c = await resolveCompany(admin, fundId, input?.company, access)
    const { data: metrics } = await (admin as any)
      .from('metrics').select('id, name, unit').eq('company_id', c.id)
    const ids = ((metrics as any[]) ?? []).map(m => m.id)
    if (ids.length === 0) return { company: c.name, metrics: [] }

    const { data: values } = await (admin as any)
      .from('metric_values')
      .select('metric_id, period_label, period_year, period_quarter, period_month, value_number, value_text')
      .in('metric_id', ids)
      .order('period_year').order('period_quarter', { nullsFirst: true }).order('period_month', { nullsFirst: true })

    return {
      company: c.name,
      metrics: ((metrics as any[]) ?? []).map(m => ({
        name: m.name,
        unit: m.unit ?? null,
        values: ((values as any[]) ?? [])
          .filter(v => v.metric_id === m.id)
          .map(v => ({ period: v.period_label, value: v.value_number ?? v.value_text })),
      })),
    }
  },

  list_lps: async ({ admin, fundId, access }: AgentToolContext, input: any) => {
    let q = (admin as any)
      .from('lp_investments')
      .select('portfolio_group, commitment, paid_in_capital, distributions, nav, dpi, rvpi, tvpi, irr, lp_entities ( entity_name )')
      .eq('fund_id', fundId)
    if (input?.vehicle) q = q.eq('portfolio_group', input.vehicle)
    const { data } = await q
    const lpScope = await entityScopeFor(admin, access)

    return scopeCompanyRows((data as any[]) ?? [], lpScope.vehicleNames, 'portfolio_group').map(r => ({
      partner: r.lp_entities?.entity_name ?? '—',
      vehicle: r.portfolio_group,
      commitment: Number(r.commitment ?? 0),
      paidIn: Number(r.paid_in_capital ?? 0),
      distributions: Number(r.distributions ?? 0),
      nav: Number(r.nav ?? 0),
      dpi: r.dpi == null ? null : Number(r.dpi),
      rvpi: r.rvpi == null ? null : Number(r.rvpi),
      tvpi: r.tvpi == null ? null : Number(r.tvpi),
      irr: r.irr == null ? null : Number(r.irr),
    }))
  },

  record_investment: async ({ admin, fundId, userId, access }: AgentToolContext, input: any) =>
    executeRecordInvestment({ admin, fundId, userId, access }, input),
}

export interface RecordInvestmentInput {
  company: string
  vehicle?: string
  transaction_type: string
  transaction_date: string
  round_name?: string
  notes?: string
  investment_cost?: number | string | null
  shares_acquired?: number | string | null
  share_price?: number | string | null
  unrealized_value_change?: number | string | null
  current_share_price?: number | string | null
  cost_basis_exited?: number | string | null
  proceeds_received?: number | string | null
  valuation_change_source?: string
  original_currency?: string
  fx_rate?: number | string | null
  prior_fx_rate?: number | string | null
  fx_value_change?: number | string | null
  original_position_value?: number | string | null
  /** When set, this priced round CONVERTS a prior SAFE/note transaction — links the two. */
  converts_from_txn_id?: string
}

/**
 * The one write path for recording a portfolio transaction: insert the row AND draft (never post)
 * the journal entry it implies. Shared by the MCP/REST `record_investment` handler and the
 * Analyst's pending-action approval, so both behave identically. `userId` may be null (MCP
 * credential contexts); it flows through to the draft's author field.
 */
export async function executeRecordInvestment(
  deps: { admin: SupabaseClient; fundId: string; userId: string | null; access: AccessContext },
  input: RecordInvestmentInput,
): Promise<{ transaction: any; ledger: any }> {
  const { admin, fundId, userId, access } = deps
  const c = await resolveCompany(admin, fundId, input?.company, access)
  // Only into one of the caller's entities (and no company-wide rows from a scoped caller).
  const writeNames = (await entityScopeFor(admin, access)).vehicleNames
  const denied = groupWriteDenial(writeNames, input?.vehicle ?? null)
  if (denied) throw new Error(denied)
  // A conversion moves its source position: the source must be this company's, and the caller's.
  if (input?.converts_from_txn_id) {
    const linkError = await validateConversionLink(admin, c.id, input.converts_from_txn_id, input.transaction_type, writeNames)
    if (linkError) throw new Error(linkError)
  }

  const VALID = ['investment', 'unrealized_gain_change', 'proceeds', 'round_info']
  if (!VALID.includes(input?.transaction_type)) {
    throw new Error(`transaction_type must be one of: ${VALID.join(', ')}`)
  }
  if (!input?.transaction_date) throw new Error('transaction_date is required (YYYY-MM-DD)')

  const num = (v: any) => (v == null || v === '' ? null : Number(v))

  const { data: txn, error } = await (admin as any)
    .from('investment_transactions')
    .insert({
      company_id: c.id,
      fund_id: fundId,
      portfolio_group: input.vehicle ?? null,
      transaction_type: input.transaction_type,
      transaction_date: input.transaction_date,
      round_name: input.round_name ?? null,
      notes: input.notes ?? null,
      investment_cost: num(input.investment_cost),
      shares_acquired: num(input.shares_acquired),
      share_price: num(input.share_price),
      unrealized_value_change: num(input.unrealized_value_change),
      current_share_price: num(input.current_share_price),
      cost_basis_exited: num(input.cost_basis_exited),
      proceeds_received: num(input.proceeds_received),
      valuation_change_source: input.valuation_change_source ?? null,
      original_currency: input.original_currency ?? null,
      fx_rate: num(input.fx_rate),
      prior_fx_rate: num(input.prior_fx_rate),
      // ONLY on an FX row. This used to copy `unrealized_value_change` into `fx_value_change`
      // unconditionally, stamping an FX delta onto every ordinary mark. Downstream filters on
      // `valuation_change_source === 'fx'` masked it, but the data was wrong at rest — and the
      // whole point of separating 1250/4300 from 1200/4200 is that a currency move is not
      // investment performance.
      fx_value_change: input.valuation_change_source === 'fx'
        ? num(input.fx_value_change ?? input.unrealized_value_change)
        : null,
      original_position_value: num(input.original_position_value),
      converts_from_txn_id: input.converts_from_txn_id ?? null,
    })
    .select('*')
    .single()

  if (error) throw new Error(error.message)

  // The point of routing an agent's write through here rather than straight at the
  // table: the ledger hears about it. The write runs only after a human approves it
  // (lib/pending-actions/investment.ts), so it follows the same rule as a human's: no cash leg
  // posts, a cash leg drafts and waits for its bank match.
  const ledger = await draftEntryForTransaction(admin, fundId, userId, txn, c.name)

  return { transaction: txn, ledger }
}

export const PORTFOLIO_TOOLS = PORTFOLIO_TOOL_MANIFEST
