// Forecast service — the one implementation behind the routes, the MCP tools and the
// Analyst's staged actions.
//
// Every entry point authorizes before it reads: `accounting` + feature `budgeting` at the level
// the operation needs, then the vehicle among the caller's own entities (a management company also
// needs `management_company`, checked in resolveVehicleWithAccess). Transports only authenticate
// and translate errors.
//
// Forecasts never touch journal_*: reads come from loadPostedLedger (posted, actual book), writes go
// to forecast_* through forecast_save / forecast_publish, which make each save one transaction
// guarded by the plan's revision.

import { applyAdjustments, entryKey, NO_ADJUSTMENTS, validateAdjustments, AdjustmentError, type Adjustments } from './adjustments'
import { randomUUID } from 'node:crypto'
import type { SupabaseClient } from '@supabase/supabase-js'
import { hasAccess, type AccessContext } from '@/lib/access/effective'
import { resolveVehicleWithAccess, VehicleAccessError } from '@/lib/accounting/http-vehicle'
import { VehicleResolutionError } from '@/lib/accounting/vehicle-resolver'
import { fetchAllRows, loadPostedLedger } from '@/lib/accounting/load'
import { closedPeriodRanges } from '@/lib/accounting/periods'
import { vehicleIdByName } from '@/lib/accounting/vehicle-id'
import { fundCurrency } from '@/lib/accounting/currency'
import type { Account, Posting } from '@/lib/accounting/types'
import { addMonths, firstDay, isMonthKey, lastDay, monthOf, monthRange, type Interval, type MonthKey } from './months'
import { RuleError, validateRule, type RuleMethod } from './rules'
import { CashTimingError, validateCashTiming, type CashTiming, type CompiledEntry } from './compile'
import { actualsByAccount, buildPlan, planWindow, type BuiltPlan, type PlanKind, type PlanOverrideRow, type PlanRuleRow } from './plan'
import { buildReport, type FlowEntry, type Report, type ReportView } from './report'
import { computeVariance, largestVariances, type VarianceResult } from './variance'
import { cycleLabel, fundSchedule, loadFeeLinks, loadLinkedDrivers, seesFund } from './linked'
import { historyWindow, MAX_HISTORY_MONTHS, MIN_HISTORY_MONTHS, suggestRule, type RuleSuggestion } from './suggest'
import { isManagementCompany } from '@/lib/vehicle-kinds'

export interface ForecastServiceContext {
  admin: SupabaseClient
  fundId: string
  userId: string
  access: AccessContext
}

/** A failure the transport should show as-is, with this status. */
export class ForecastError extends Error {
  constructor(message: string, readonly status: 400 | 403 | 404 | 409 = 400) {
    super(message)
  }
}

export const HORIZONS = [12, 18, 24, 36] as const

// ---------------------------------------------------------------------------------------------
// Authorization and loading
// ---------------------------------------------------------------------------------------------

function authorize(ctx: ForecastServiceContext, need: 'read' | 'write') {
  if (!hasAccess(ctx.access, 'accounting', need, 'budgeting')) {
    throw new ForecastError(
      need === 'write' ? 'You need write access to Forecast.' : 'You do not have access to Forecast.',
      403,
    )
  }
}

interface VehicleCtx {
  name: string
  id: string
  kind: string
  accounts: Account[]
  currency: string
  closedFrom: MonthKey | null
  closedThrough: MonthKey | null
}

async function loadVehicle(ctx: ForecastServiceContext, vehicle: string, need: 'read' | 'write'): Promise<VehicleCtx> {
  authorize(ctx, need)
  let resolved: { name: string; kind: string | null }
  try {
    resolved = await resolveVehicleWithAccess(ctx.admin, ctx.access, vehicle, need)
  } catch (e) {
    if (e instanceof VehicleAccessError) throw new ForecastError(e.message, 403)
    if (e instanceof VehicleResolutionError) throw new ForecastError(e.message, 400)
    throw e
  }
  const id = await vehicleIdByName(ctx.admin, ctx.fundId, resolved.name)
  if (!id) throw new ForecastError(`"${resolved.name}" has no registry row, so it cannot hold a plan.`)
  const [accountRows, closed, currency] = await Promise.all([
    fetchAllRows((f, t) =>
      (ctx.admin as any).from('chart_of_accounts').select('id, code, name, type, subtype, lp_entity_id, company_id, is_active')
        .eq('fund_id', ctx.fundId).eq('vehicle_id', id).range(f, t),
    ),
    closedPeriodRanges(ctx.admin, ctx.fundId, resolved.name),
    fundCurrency(ctx.admin, ctx.fundId),
  ])
  const accounts: Account[] = (accountRows as any[]).map(a => ({
    id: a.id, fundId: ctx.fundId, code: a.code, name: a.name, type: a.type, subtype: a.subtype ?? null,
    lpEntityId: a.lp_entity_id ?? null, companyId: a.company_id ?? null,
  }))
  const starts = closed.map(p => p.period_start).sort()
  const ends = closed.map(p => p.period_end).sort()
  // A close always ends on a month end (closeThrough splits by calendar month), so the month of
  // the last period_end is fully closed.
  return {
    name: resolved.name,
    id,
    kind: resolved.kind ?? 'fund',
    accounts,
    currency,
    closedFrom: starts.length ? monthOf(starts[0]) : null,
    closedThrough: ends.length ? monthOf(ends[ends.length - 1]) : null,
  }
}

const thisMonth = () => new Date().toISOString().slice(0, 7)

/**
 * The cutoff a plan compiles against and why. Default: the last closed month. With nothing closed,
 * the month before this one — labelled unclosed everywhere it shows, never passed off as final.
 */
function resolveCutoff(planCutoff: string | null, v: VehicleCtx): { cutoff: MonthKey; warnings: string[] } {
  if (planCutoff) {
    const m = monthOf(planCutoff)
    const warnings = v.closedThrough && m <= v.closedThrough ? [] : [`Actuals through ${m} include months that are not closed`]
    return { cutoff: m, warnings }
  }
  if (v.closedThrough) return { cutoff: v.closedThrough, warnings: [] }
  const m = addMonths(thisMonth(), -1)
  return { cutoff: m, warnings: [`No closed periods — actuals through ${m} are unclosed and may change`] }
}

// ---------------------------------------------------------------------------------------------
// Row shapes
// ---------------------------------------------------------------------------------------------

export interface PlanSummary {
  id: string
  vehicle: string
  kind: PlanKind
  name: string
  scenario: string | null
  fiscalYear: number | null
  startMonth: MonthKey
  endMonth: MonthKey
  horizonMonths: number | null
  actualsCutoff: string | null
  openingSettlementMonths: number
  includeConstruction: boolean
  /** Hand edits on top of the sources (lib/forecast/adjustments.ts). */
  adjustments: Adjustments
  status: 'active' | 'archived'
  revision: number
  compiledAt: string | null
  compiledCutoff: string | null
  createdAt: string
  updatedAt: string
}

export interface RuleView {
  id: string
  accountId: string
  method: RuleMethod
  params: unknown
  cashTiming: CashTiming
  source: string
  note: string | null
}

export interface OverrideView {
  id: string
  accountId: string
  month: MonthKey
  amount: number
  note: string | null
}

export interface VersionView {
  id: string
  versionNo: number
  label: string | null
  notes: string | null
  status: 'published' | 'approved'
  actualsCutoff: string | null
  closedThrough: string | null
  startMonth: MonthKey
  endMonth: MonthKey
  publishedBy: string | null
  publishedAt: string
}

const PLAN_COLS = 'id, vehicle_id, kind, name, scenario, fiscal_year, start_month, end_month, horizon_months, actuals_cutoff, opening_settlement_months, include_construction, adjustments, status, revision, compiled_at, compiled_cutoff, compiled_closed_through, created_at, updated_at'

function mapPlan(r: any, vehicle: string): PlanSummary {
  return {
    id: r.id, vehicle, kind: r.kind, name: r.name, scenario: r.scenario ?? null, fiscalYear: r.fiscal_year ?? null,
    startMonth: monthOf(r.start_month), endMonth: monthOf(r.end_month), horizonMonths: r.horizon_months ?? null,
    actualsCutoff: r.actuals_cutoff ?? null, openingSettlementMonths: r.opening_settlement_months ?? 1, includeConstruction: r.include_construction === true, adjustments: (r.adjustments as Adjustments) ?? NO_ADJUSTMENTS, status: r.status, revision: r.revision, compiledAt: r.compiled_at ?? null,
    compiledCutoff: r.compiled_cutoff ?? null, createdAt: r.created_at, updatedAt: r.updated_at,
  }
}

const mapRule = (r: any): RuleView => ({
  id: r.id, accountId: r.account_id, method: r.method, params: r.params, cashTiming: r.cash_timing ?? { mode: 'same' },
  source: r.source, note: r.note ?? null,
})

const mapOverride = (r: any): OverrideView => ({
  id: r.id, accountId: r.account_id, month: monthOf(r.month), amount: Number(r.amount), note: r.note ?? null,
})

const mapVersion = (r: any): VersionView => ({
  id: r.id, versionNo: r.version_no, label: r.label ?? null, notes: r.notes ?? null, status: r.status,
  actualsCutoff: r.actuals_cutoff ?? null, closedThrough: r.closed_through ?? null,
  startMonth: monthOf(r.start_month), endMonth: monthOf(r.end_month), publishedBy: r.published_by ?? null,
  publishedAt: r.published_at,
})

async function loadPlanRow(ctx: ForecastServiceContext, v: VehicleCtx, planId: string) {
  if (typeof planId !== 'string' || !planId) throw new ForecastError('planId is required')
  const { data, error } = await (ctx.admin as any).from('forecast_plans').select(PLAN_COLS)
    .eq('fund_id', ctx.fundId).eq('vehicle_id', v.id).eq('id', planId).maybeSingle()
  if (error) throw error
  if (!data) throw new ForecastError('No such plan for this vehicle', 404)
  return data
}

async function loadInputs(ctx: ForecastServiceContext, planId: string) {
  const [rules, overrides] = await Promise.all([
    fetchAllRows((f, t) => (ctx.admin as any).from('forecast_rules').select('id, account_id, method, params, cash_timing, source, note').eq('fund_id', ctx.fundId).eq('plan_id', planId).range(f, t)),
    fetchAllRows((f, t) => (ctx.admin as any).from('forecast_overrides').select('id, account_id, month, amount, note').eq('fund_id', ctx.fundId).eq('plan_id', planId).order('month').range(f, t)),
  ])
  return { rules: (rules as any[]).map(mapRule), overrides: (overrides as any[]).map(mapOverride) }
}

async function loadEntries(ctx: ForecastServiceContext, planId: string, versionId: string | null): Promise<FlowEntry[]> {
  const rows = await fetchAllRows((f, t) => {
    let q = (ctx.admin as any).from('forecast_entries').select('id, entry_date, kind, account_id, source, forecast_postings(account_id, amount, currency)')
      .eq('fund_id', ctx.fundId).eq('plan_id', planId)
    q = versionId ? q.eq('version_id', versionId) : q.is('version_id', null)
    return q.order('entry_date').order('id').range(f, t)
  })
  return (rows as any[]).map(e => ({
    date: e.entry_date,
    kind: e.kind,
    driver: e.account_id,
    postings: ((e.forecast_postings as any[]) ?? []).map(p => ({ accountId: p.account_id, amount: Number(p.amount), currency: p.currency, entryDate: e.entry_date })),
  }))
}

/** Posted actuals grouped back into entries, for classifying what moved the cash. */
function actualFlowEntries(sourced: { entryId: string; accountId: string; amount: number; currency: string; entryDate?: string | null }[]): FlowEntry[] {
  const byEntry = new Map<string, FlowEntry>()
  for (const p of sourced) {
    if (!p.entryDate) continue
    const e = byEntry.get(p.entryId) ?? { date: p.entryDate, kind: null, postings: [] }
    e.postings.push({ accountId: p.accountId, amount: p.amount, currency: p.currency, entryDate: p.entryDate })
    byEntry.set(p.entryId, e)
  }
  return [...byEntry.values()]
}

// ---------------------------------------------------------------------------------------------
// Compile
// ---------------------------------------------------------------------------------------------

function toRuleRows(rules: RuleView[]): PlanRuleRow[] {
  return rules.map(r => ({ id: r.id, accountId: r.accountId, rule: validateRule(r.method, r.params), cashTiming: validateCashTiming(r.cashTiming) }))
}

async function compile(ctx: ForecastServiceContext, v: VehicleCtx, plan: any, rules: RuleView[], overrides: OverrideView[]) {
  const result = await compileFromSources(ctx, v, plan, rules, overrides)
  // Hand edits on top of what the sources say (lib/forecast/adjustments.ts).
  const adj = validateAdjustments(plan.adjustments ?? NO_ADJUSTMENTS, v.accounts)
  const applied = applyAdjustments(result.built.entries, adj, { first: result.built.first, last: result.built.last }, v.currency)
  return {
    ...result,
    built: { ...result.built, entries: applied.entries },
    generated: result.built.entries,
    warnings: [...new Set([...result.warnings, ...applied.warnings])],
  }
}

async function compileFromSources(ctx: ForecastServiceContext, v: VehicleCtx, plan: any, rules: RuleView[], overrides: OverrideView[]) {
  const { cutoff, warnings } = resolveCutoff(plan.actuals_cutoff, v)
  const ruleRows = toRuleRows(rules)
  const [ledger, drivers] = await Promise.all([
    loadPostedLedger(ctx.admin, ctx.fundId, v.name, lastDay(cutoff)),
    loadLinkedDrivers(ctx, v, ruleRows, plan.include_construction === true),
  ])
  const built = buildPlan({
    kind: plan.kind,
    fiscalYear: plan.fiscal_year,
    startMonth: monthOf(plan.start_month),
    endMonth: monthOf(plan.end_month),
    horizonMonths: plan.horizon_months,
    cutoff,
    vehicleKind: v.kind,
    accounts: v.accounts,
    actuals: ledger.postings,
    closedFrom: v.closedFrom,
    closedThrough: v.closedThrough,
    rules: ruleRows,
    overrides,
    currency: v.currency,
    openingSettlementMonths: plan.opening_settlement_months ?? 1,
    linked: drivers.linked,
    construction: drivers.construction,
    gpShare: drivers.gpShare,
  })
  return { built, cutoff, warnings: [...new Set([...warnings, ...drivers.warnings, ...built.warnings])] }
}

const entriesJson = (entries: CompiledEntry[]) =>
  entries.map(e => ({
    entry_date: e.entryDate, kind: e.kind, memo: e.memo, account_id: e.accountId, rule_id: e.ruleId,
    override_id: e.overrideId, source: e.source,
    postings: e.postings.map(p => ({ account_id: p.accountId, amount: p.amount, currency: p.currency })),
  }))

function rpcError(error: any): never {
  if (error?.code === 'PT409') throw new ForecastError(error.message, 409)
  if (error?.code === 'PT404') throw new ForecastError(error.message, 404)
  throw error
}

// ---------------------------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------------------------

export async function listPlans(ctx: ForecastServiceContext, input: { vehicle: string; includeArchived?: boolean }) {
  const v = await loadVehicle(ctx, input.vehicle, 'read')
  let q = (ctx.admin as any).from('forecast_plans').select(PLAN_COLS).eq('fund_id', ctx.fundId).eq('vehicle_id', v.id)
  if (!input.includeArchived) q = q.eq('status', 'active')
  const { data, error } = await q.order('created_at', { ascending: false })
  if (error) throw error
  const plans = ((data as any[]) ?? []).map(r => mapPlan(r, v.name))
  const { data: versions } = plans.length
    ? await (ctx.admin as any).from('forecast_versions').select('id, plan_id, version_no, label, status, published_at, actuals_cutoff')
        .eq('fund_id', ctx.fundId).in('plan_id', plans.map(p => p.id)).order('version_no', { ascending: false })
    : { data: [] }
  return {
    vehicle: v.name,
    kind: v.kind,
    closedThrough: v.closedThrough,
    plans: plans.map(p => ({
      ...p,
      versions: ((versions as any[]) ?? []).filter(x => x.plan_id === p.id).map(x => ({
        id: x.id, versionNo: x.version_no, label: x.label ?? null, status: x.status, publishedAt: x.published_at, actualsCutoff: x.actuals_cutoff ?? null,
      })),
    })),
  }
}

export interface PlanDetail {
  plan: PlanSummary
  vehicleKind: string
  currency: string
  closedThrough: MonthKey | null
  cutoff: MonthKey
  window: { first: MonthKey; last: MonthKey }
  /** True when the stored draft was compiled against a different cutoff or close than today's. */
  stale: boolean
  accounts: { id: string; code: string; name: string; type: 'income' | 'expense' }[]
  /** Every account an entry may post to — for entering one by hand. */
  allAccounts: { id: string; code: string; name: string; type: string; subtype: string | null }[]
  /** The cash accounts, for editing a cash figure (lib/forecast/adjustments.ts cashCellAdjustments). */
  cashAccountIds: string[]
  /**
   * The draft's entries as they compile now, each with where it came from and how to edit it:
   * `key` for a generated construction/opening entry (replace or remove it) or a hand-entered one
   * ('manual|<id>'); rule and override entries are edited through their rule or a month override.
   */
  entries: { date: string; kind: string; memo: string; source: string; key: string | null; accountId: string; ruleId: string | null; postings: { accountId: string; amount: number }[] }[]
  rules: (RuleView & { basis: string; warnings: string[] })[]
  overrides: OverrideView[]
  versions: VersionView[]
  warnings: string[]
}

export async function getPlan(ctx: ForecastServiceContext, input: { vehicle: string; planId: string }): Promise<PlanDetail> {
  const v = await loadVehicle(ctx, input.vehicle, 'read')
  const row = await loadPlanRow(ctx, v, input.planId)
  const [{ rules, overrides }, versionRows] = await Promise.all([
    loadInputs(ctx, row.id),
    (ctx.admin as any).from('forecast_versions').select('id, version_no, label, notes, status, actuals_cutoff, closed_through, start_month, end_month, published_by, published_at')
      .eq('fund_id', ctx.fundId).eq('plan_id', row.id).order('version_no', { ascending: false }),
  ])
  // Re-evaluate for the drill-down (basis, warnings); the stored draft is what the numbers read.
  const [{ built, cutoff, warnings }, stored] = await Promise.all([
    compile(ctx, v, row, rules, overrides),
    loadEntries(ctx, row.id, null),
  ])
  const outcome = new Map(built.rules.map(r => [r.ruleId, r]))
  const actualsMoved =
    row.compiled_cutoff == null ||
    monthOf(row.compiled_cutoff) !== cutoff ||
    (row.compiled_closed_through ? monthOf(row.compiled_closed_through) : null) !== v.closedThrough
  // Anything else the draft was built from — portfolio construction (this entity's, a linked
  // fund's for a manco's fees, the fund's for a GP entity), fee links — has no date to compare, so
  // compare the answer: what compiling now gives against what was saved.
  const sourcesMoved = !actualsMoved && entriesFingerprint(built.entries.map(e => ({ date: e.entryDate, postings: e.postings })))
    !== entriesFingerprint(stored.map(e => ({ date: e.date, postings: e.postings })))
  const stale = actualsMoved || sourcesMoved
  return {
    plan: mapPlan(row, v.name),
    vehicleKind: v.kind,
    currency: v.currency,
    closedThrough: v.closedThrough,
    cutoff,
    window: { first: built.first, last: built.last },
    stale,
    accounts: v.accounts
      .filter(a => (a.type === 'income' || a.type === 'expense') && !a.lpEntityId && !a.companyId)
      .sort((a, b) => a.code.localeCompare(b.code))
      .map(a => ({ id: a.id, code: a.code, name: a.name, type: a.type as 'income' | 'expense' })),
    allAccounts: v.accounts
      .filter(a => !a.lpEntityId && !a.companyId)
      .sort((a, b) => a.code.localeCompare(b.code))
      .map(a => ({ id: a.id, code: a.code, name: a.name, type: a.type, subtype: a.subtype ?? null })),
    cashAccountIds: v.accounts.filter(a => a.subtype === 'cash' && !a.lpEntityId && !a.companyId).map(a => a.id),
    entries: built.entries.map(e => ({
      date: e.entryDate, kind: e.kind, memo: e.memo, source: e.source, key: e.key ?? entryKey(e), accountId: e.accountId, ruleId: e.ruleId,
      postings: e.postings.map(p => ({ accountId: p.accountId, amount: p.amount })),
    })),
    rules: rules.map(r => ({ ...r, basis: outcome.get(r.id)?.basis ?? '', warnings: outcome.get(r.id)?.warnings ?? [] })),
    overrides,
    versions: ((versionRows.data as any[]) ?? []).map(mapVersion),
    warnings: actualsMoved ? [...warnings, 'Actuals have moved since this draft was last saved — refresh to recompile']
      : sourcesMoved ? [...warnings, 'Portfolio construction or a linked fund has changed since this draft was last saved — refresh to recompile']
      : warnings,
  }
}

/** Order-independent summary of a set of entries: per date and account, the net amount. */
export function entriesFingerprint(entries: { date: string; postings: { accountId: string; amount: number }[] }[]): string {
  const sums = new Map<string, number>()
  for (const e of entries) for (const p of e.postings) {
    const k = `${e.date.slice(0, 10)}|${p.accountId}`
    sums.set(k, (sums.get(k) ?? 0) + Number(p.amount))
  }
  return [...sums].filter(([, v]) => Math.abs(v) >= 0.005).map(([k, v]) => `${k}=${v.toFixed(2)}`).sort().join(';')
}

export interface CreatePlanInput {
  vehicle: string
  kind: PlanKind
  name: string
  scenario?: string | null
  fiscalYear?: number
  horizonMonths?: number | null
  endMonth?: MonthKey
  actualsCutoff?: string | null
  /** Fund/SPV: carry construction's investment, exit, call and distribution flows. */
  includeConstruction?: boolean
  /** 'blank', or 'actuals' (budget: last year's months; forecast: 3-month run rate), or another plan's rules. */
  seed?: { from: 'blank' | 'suggested' | 'last_year' | 'actuals' | 'plan'; planId?: string; lookbackMonths?: number }
}

export async function createPlan(ctx: ForecastServiceContext, input: CreatePlanInput): Promise<PlanDetail> {
  const v = await loadVehicle(ctx, input.vehicle, 'write')
  if (input.kind !== 'budget' && input.kind !== 'rolling_forecast') throw new ForecastError("kind must be 'budget' or 'rolling_forecast'")
  const name = typeof input.name === 'string' ? input.name.trim() : ''
  if (!name || name.length > 200) throw new ForecastError('name is required (up to 200 characters)')
  const cutoffDate = normaliseCutoff(input.actualsCutoff)
  const { cutoff } = resolveCutoff(cutoffDate, v)

  let startMonth: MonthKey
  let endMonth: MonthKey
  let fiscalYear: number | null = null
  let horizon: number | null = null
  if (input.kind === 'budget') {
    fiscalYear = Number(input.fiscalYear)
    if (!Number.isInteger(fiscalYear) || fiscalYear < 1900 || fiscalYear > 2200) throw new ForecastError('fiscalYear is required for a budget')
    startMonth = `${fiscalYear}-01`
    endMonth = `${fiscalYear}-12`
  } else if (input.endMonth != null) {
    if (!isMonthKey(input.endMonth)) throw new ForecastError('endMonth must be YYYY-MM')
    startMonth = addMonths(cutoff, 1)
    endMonth = input.endMonth
    if (endMonth < startMonth) throw new ForecastError('endMonth is before the first forecast month')
  } else {
    horizon = Number(input.horizonMonths ?? 12)
    if (!Number.isInteger(horizon) || horizon < 1 || horizon > 120) throw new ForecastError('horizonMonths must be 1–120 (12, 18, 24 or 36 are the presets)')
    startMonth = addMonths(cutoff, 1)
    endMonth = addMonths(cutoff, horizon)
  }

  const seed = input.seed ?? { from: 'blank' }
  const rules = await seedRules(ctx, v, input.kind, seed, cutoff, fiscalYear)

  const { data: inserted, error } = await (ctx.admin as any).from('forecast_plans').insert({
    fund_id: ctx.fundId, vehicle_id: v.id, kind: input.kind, name, scenario: input.scenario?.trim() || null,
    fiscal_year: fiscalYear, start_month: firstDay(startMonth), end_month: firstDay(endMonth), horizon_months: horizon,
    actuals_cutoff: cutoffDate, seed, created_by: ctx.userId || null, include_construction: input.includeConstruction === true,
  }).select(PLAN_COLS).single()
  if (error) throw error

  const { built, cutoff: c } = await compile(ctx, v, inserted, rules, [])
  const { error: saveError } = await (ctx.admin as any).rpc('forecast_save', {
    p_plan_id: inserted.id, p_fund_id: ctx.fundId, p_expected_revision: 0, p_plan_patch: {},
    p_rule_upserts: rules.map(r => ({ id: r.id, account_id: r.accountId, method: r.method, params: r.params, cash_timing: r.cashTiming, source: r.source, note: r.note })),
    p_rule_deletes: [], p_override_upserts: [], p_override_deletes: [],
    p_entries: entriesJson(built.entries), p_compiled: { cutoff: lastDay(c), closed_through: v.closedThrough ? lastDay(v.closedThrough) : null },
  })
  if (saveError) rpcError(saveError)
  return getPlan(ctx, { vehicle: v.name, planId: inserted.id })
}

function normaliseCutoff(raw: unknown): string | null {
  if (raw == null || raw === '') return null
  if (typeof raw === 'string' && isMonthKey(raw)) return lastDay(raw)
  if (typeof raw === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(raw)) return lastDay(monthOf(raw))
  throw new ForecastError('actualsCutoff must be YYYY-MM')
}

async function seedRules(
  ctx: ForecastServiceContext,
  v: VehicleCtx,
  kind: PlanKind,
  seed: { from: string; planId?: string; lookbackMonths?: number },
  cutoff: MonthKey,
  fiscalYear: number | null,
): Promise<RuleView[]> {
  if (seed.from === 'blank') return []
  if (seed.from === 'plan') {
    const src = await loadPlanRow(ctx, v, seed.planId ?? '')
    const { rules } = await loadInputs(ctx, src.id)
    return rules.map(r => ({ ...r, id: randomUUID(), source: 'seeded' }))
  }
  if (seed.from === 'suggested' || (seed.from === 'actuals' && kind === 'rolling_forecast')) {
    // Each account's own pattern from 12–36 closed months (lib/forecast/suggest.ts), marked
    // 'suggested' with its evidence so the drawer says where it came from. A draft, never published.
    const { suggestions } = await suggestFor(ctx, v, seed.lookbackMonths)
    return suggestions.map(x => ({
      id: randomUUID(), accountId: x.accountId, method: x.method, params: x.params, cashTiming: { mode: 'same' } as CashTiming,
      source: 'suggested', note: `${x.confidence} confidence — ${x.evidence}`.slice(0, 500),
    }))
  }
  if (seed.from !== 'actuals' && seed.from !== 'last_year') throw new ForecastError("seed.from must be 'blank', 'suggested', 'last_year' or 'plan'")

  // Last year's month-by-month figures, moved forward a year, as manual amounts.
  const pnl = v.accounts.filter(a => (a.type === 'income' || a.type === 'expense') && !a.lpEntityId && !a.companyId)
  const prior = (fiscalYear ?? Number(cutoff.slice(0, 4))) - 1
  const ledger = await loadPostedLedger(ctx.admin, ctx.fundId, v.name, `${prior}-12-31`)
  const history = actualsByAccount(v.accounts, ledger.postings)
  const out: RuleView[] = []
  for (const a of pnl) {
    const byMonth = history.get(a.id)
    if (!byMonth) continue
    const amounts: Record<MonthKey, number> = {}
    for (const m of monthRange(`${prior}-01`, `${prior}-12`)) {
      const amt = byMonth.get(m)
      if (amt) amounts[addMonths(m, 12)] = Math.round(amt * 100) / 100
    }
    if (Object.keys(amounts).length) {
      out.push({ id: randomUUID(), accountId: a.id, method: 'manual', params: { amounts }, cashTiming: { mode: 'same' }, source: 'seeded', note: `From ${prior} actuals` })
    }
  }
  return out
}

export interface AccountSuggestion extends RuleSuggestion {
  accountId: string
  code: string
  name: string
  type: 'income' | 'expense'
}

/**
 * A suggested rule for every P&L account that moved in the history window. Linked sources win over
 * history where they exist — a manco's fee income from its fee links, a fund's fees and expenses
 * from its construction schedule — because history only says what WAS charged.
 */
async function suggestFor(ctx: ForecastServiceContext, v: VehicleCtx, lookbackMonths?: number) {
  const warnings: string[] = []
  let closedFrom = v.closedFrom
  let closedThrough = v.closedThrough
  let unclosedNote: string | null = null
  if (!closedThrough) {
    // Nothing closed: read through last month rather than suggest nothing, and say so on every rule.
    closedThrough = addMonths(thisMonth(), -1)
    unclosedNote = 'Based on unclosed months — no period is closed yet'
    warnings.push(`No closed periods — suggestions read unclosed actuals through ${closedThrough}`)
  }
  const ledger = await loadPostedLedger(ctx.admin, ctx.fundId, v.name, lastDay(closedThrough))
  if (!closedFrom) {
    const first = ledger.postings.map(p => p.entryDate).filter(Boolean).sort()[0]
    closedFrom = first ? monthOf(first) : closedThrough
  }
  const history = actualsByAccount(v.accounts, ledger.postings)
  const window = historyWindow(closedFrom, closedThrough, lookbackMonths ?? MAX_HISTORY_MONTHS)
  if (window.length < MIN_HISTORY_MONTHS) warnings.push(`Only ${window.length} months of history; annual and seasonal patterns need at least ${MIN_HISTORY_MONTHS}`)

  const manco = isManagementCompany(v.kind)
  const links = (await loadFeeLinks(ctx.admin, ctx.fundId, v.id)).filter(l => l.active)
  const mancoLinks = links.filter(l => l.mancoVehicleId === v.id)
  const fundLink = links.find(l => l.fundVehicleId === v.id)
  let hasSchedule = false
  if (!manco) {
    try {
      hasSchedule = !!(await fundSchedule(ctx, v.name, false)).monthly
    } catch {
      hasSchedule = false
    }
  }

  const suggestions: AccountSuggestion[] = []
  for (const a of v.accounts) {
    if ((a.type !== 'income' && a.type !== 'expense') || a.lpEntityId || a.companyId) continue
    const meta = { accountId: a.id, code: a.code, name: a.name, type: a.type as 'income' | 'expense' }
    if (manco && a.subtype === 'management_fee_income' && mancoLinks.length) {
      suggestions.push({ ...meta, method: 'linked_fee', params: {}, confidence: 'high', evidence: `${mancoLinks.length} linked fund${mancoLinks.length === 1 ? '' : 's'}' construction fee schedules`, warnings: [] })
      continue
    }
    // A fund's fee and expenses: an explicit fee link wins. Otherwise the books' own pattern wins
    // when it is confident — a prepaid fee amortized at exactly $2,100 a month is the fact, and
    // construction's assumptions may differ — and construction fills in where history is thin.
    const fromHistory = () => suggestRule({ actuals: history.get(a.id) ?? new Map(), closedFrom: closedFrom!, closedThrough: closedThrough!, lookbackMonths })
    if (!manco && a.subtype === 'management_fee' && fundLink) {
      suggestions.push({ ...meta, method: 'linked_fee', params: {}, confidence: 'high', evidence: `Construction fee schedule, ${cycleLabel(fundLink)}`, warnings: [] })
      continue
    }
    if (!manco && (a.subtype === 'management_fee' || a.subtype === 'partnership_expense') && hasSchedule) {
      const h = fromHistory()
      if (!h || h.confidence !== 'high') {
        const flow = a.subtype === 'management_fee' ? 'fees' : 'expenses'
        suggestions.push({
          ...meta, method: 'linked_construction', params: { flow }, confidence: 'medium',
          evidence: `Portfolio construction ${flow === 'fees' ? 'fee schedule' : 'partnership expenses (annual, spread by month)'}${h ? ` — history was ${h.confidence} confidence: ${h.evidence}` : ''}`,
          warnings: [],
        })
        continue
      }
    }
    if (MARK_SUBTYPES.has(a.subtype ?? '')) {
      // A mark or a gain is an event, not a run rate: one revaluation in February is not a monthly
      // gain. Left at zero, visibly — portfolio construction is where investment outcomes are forecast.
      if (history.get(a.id)?.size) {
        suggestions.push({
          ...meta, method: 'manual', params: { amounts: {} }, confidence: 'high',
          evidence: 'Investment marks and gains are not forecast from history',
          warnings: manco ? [] : ['Include portfolio construction flows (⋯ menu) to forecast exits and their realized gains'],
        })
      }
      continue
    }
    const s = suggestRule({ actuals: history.get(a.id) ?? new Map(), closedFrom, closedThrough, lookbackMonths })
    if (!s) continue
    if (unclosedNote) s.warnings.unshift(unclosedNote)
    if (manco && a.subtype === 'management_fee_income' && !mancoLinks.length) s.warnings.push('Fee income could be linked to the funds’ fee schedules — add fee links')
    suggestions.push({ ...meta, ...s })
  }
  return { suggestions, window: window.length ? { first: window[0], last: window[window.length - 1] } : null, warnings }
}

/** Income accounts that record investment outcomes — marks, gains, currency — never forecast from history. */
const MARK_SUBTYPES = new Set(['unrealized', 'realized_gain', 'fx_translation', 'fx_revaluation'])

export async function suggestRules(ctx: ForecastServiceContext, input: { vehicle: string; lookbackMonths?: number }) {
  const v = await loadVehicle(ctx, input.vehicle, 'read')
  const r = await suggestFor(ctx, v, input.lookbackMonths)
  return { vehicle: v.name, closedThrough: v.closedThrough, history: r.window, warnings: r.warnings, suggestions: r.suggestions }
}

export interface SavePlanInput {
  vehicle: string
  planId: string
  expectedRevision: number
  patch?: { name?: string; scenario?: string | null; actualsCutoff?: string | null; horizonMonths?: number | null; endMonth?: MonthKey; status?: 'active' | 'archived'; openingSettlementMonths?: number; includeConstruction?: boolean }
  /** Upsert a rule per account. */
  rules?: { accountId: string; method: RuleMethod; params: unknown; cashTiming?: unknown; note?: string | null }[]
  /** Remove the rule on these accounts. */
  removeRules?: string[]
  /** Set (amount) or clear (amount: null) one month of one account. */
  overrides?: { accountId: string; month: MonthKey; amount: number | null; note?: string | null }[]
  /** Replace the plan's hand edits whole (lib/forecast/adjustments.ts). */
  adjustments?: unknown
}

/**
 * Every write to a plan: apply the change in memory, re-validate and recompile the whole draft,
 * then hand both to forecast_save in one transaction. A save with nothing in it is a refresh —
 * the draft recompiled against today's actuals.
 */
export async function savePlan(ctx: ForecastServiceContext, input: SavePlanInput): Promise<PlanDetail> {
  const v = await loadVehicle(ctx, input.vehicle, 'write')
  const row = await loadPlanRow(ctx, v, input.planId)
  if (!Number.isInteger(input.expectedRevision)) throw new ForecastError('expectedRevision is required')
  if (input.expectedRevision !== row.revision) {
    throw new ForecastError(`The plan changed since you loaded it (revision ${input.expectedRevision} is now ${row.revision}). Reload and try again.`, 409)
  }
  const { rules, overrides } = await loadInputs(ctx, row.id)
  const pnlIds = new Set(v.accounts.filter(a => a.type === 'income' || a.type === 'expense').map(a => a.id))
  const needAccount = (id: unknown) => {
    if (typeof id !== 'string' || !pnlIds.has(id)) throw new ForecastError('accountId must be an income or expense account of this vehicle')
    return id
  }

  // Plan fields.
  const patch: Record<string, unknown> = {}
  const p = input.patch ?? {}
  const working = { ...row }
  if (p.name !== undefined) {
    const n = String(p.name ?? '').trim()
    if (!n || n.length > 200) throw new ForecastError('name is required (up to 200 characters)')
    patch.name = n
  }
  if (p.scenario !== undefined) patch.scenario = p.scenario?.trim() || null
  if (p.status !== undefined) {
    if (p.status !== 'active' && p.status !== 'archived') throw new ForecastError("status must be 'active' or 'archived'")
    patch.status = p.status
  }
  if (p.includeConstruction !== undefined) {
    if (typeof p.includeConstruction !== 'boolean') throw new ForecastError('includeConstruction must be true or false')
    patch.include_construction = p.includeConstruction
    working.include_construction = p.includeConstruction
  }
  if (p.openingSettlementMonths !== undefined) {
    const n = Number(p.openingSettlementMonths)
    if (!Number.isInteger(n) || n < 0 || n > 24) throw new ForecastError('openingSettlementMonths must be 0–24')
    patch.opening_settlement_months = n
    working.opening_settlement_months = n
  }
  if (p.actualsCutoff !== undefined) {
    const c = normaliseCutoff(p.actualsCutoff)
    if (c && v.closedThrough === null && c > lastDay(thisMonth())) throw new ForecastError('actualsCutoff cannot be in the future')
    patch.actuals_cutoff = c
    working.actuals_cutoff = c
  }
  if (row.kind === 'rolling_forecast' && (p.horizonMonths !== undefined || p.endMonth !== undefined)) {
    if (p.endMonth != null) {
      if (!isMonthKey(p.endMonth)) throw new ForecastError('endMonth must be YYYY-MM')
      patch.horizon_months = null
      patch.end_month = firstDay(p.endMonth)
      working.horizon_months = null
      working.end_month = firstDay(p.endMonth)
    } else {
      const h = Number(p.horizonMonths)
      if (!Number.isInteger(h) || h < 1 || h > 120) throw new ForecastError('horizonMonths must be 1–120')
      patch.horizon_months = h
      working.horizon_months = h
    }
  }

  if (input.adjustments !== undefined) {
    try {
      const adj = validateAdjustments(input.adjustments, v.accounts)
      patch.adjustments = adj
      working.adjustments = adj
    } catch (e) {
      if (e instanceof AdjustmentError) throw new ForecastError(e.message)
      throw e
    }
  }

  // Rules.
  const byAccount = new Map(rules.map(r => [r.accountId, r]))
  const upserts: RuleView[] = []
  for (const r of input.rules ?? []) {
    const accountId = needAccount(r.accountId)
    let checked
    let timing
    try {
      checked = validateRule(r.method, r.params)
      timing = validateCashTiming(r.cashTiming)
    } catch (e) {
      if (e instanceof RuleError || e instanceof CashTimingError) throw new ForecastError(e.message)
      throw e
    }
    const next: RuleView = {
      id: byAccount.get(accountId)?.id ?? randomUUID(), accountId, method: checked.method, params: checked.params,
      cashTiming: timing, source: 'user', note: r.note?.trim() || null,
    }
    byAccount.set(accountId, next)
    upserts.push(next)
  }
  const ruleDeletes: string[] = []
  for (const accountId of input.removeRules ?? []) {
    const existing = byAccount.get(accountId)
    if (existing) {
      ruleDeletes.push(existing.id)
      byAccount.delete(accountId)
    }
  }

  // Overrides.
  const ovKey = (a: string, m: string) => `${a}|${m}`
  const ovs = new Map(overrides.map(o => [ovKey(o.accountId, o.month), o]))
  const ovUpserts: OverrideView[] = []
  const ovDeletes: string[] = []
  for (const o of input.overrides ?? []) {
    const accountId = needAccount(o.accountId)
    if (!isMonthKey(o.month)) throw new ForecastError('override month must be YYYY-MM')
    const k = ovKey(accountId, o.month)
    if (o.amount === null) {
      const existing = ovs.get(k)
      if (existing) {
        ovDeletes.push(existing.id)
        ovs.delete(k)
      }
      continue
    }
    if (typeof o.amount !== 'number' || !Number.isFinite(o.amount)) throw new ForecastError('override amount must be a number, or null to clear it')
    const next: OverrideView = { id: ovs.get(k)?.id ?? randomUUID(), accountId, month: o.month, amount: Math.round(o.amount * 100) / 100, note: o.note?.trim() || null }
    ovs.set(k, next)
    ovUpserts.push(next)
  }

  const { built, cutoff } = await compile(ctx, v, working, [...byAccount.values()], [...ovs.values()])
  if (row.kind === 'rolling_forecast') {
    // Persist where the rolling window now sits so lists and exports show it.
    patch.start_month = firstDay(built.first)
    patch.end_month = firstDay(built.last)
  }
  const { error } = await (ctx.admin as any).rpc('forecast_save', {
    p_plan_id: row.id, p_fund_id: ctx.fundId, p_expected_revision: input.expectedRevision, p_plan_patch: patch,
    p_rule_upserts: upserts.map(r => ({ id: r.id, account_id: r.accountId, method: r.method, params: r.params, cash_timing: r.cashTiming, source: r.source, note: r.note })),
    p_rule_deletes: ruleDeletes,
    p_override_upserts: ovUpserts.map(o => ({ id: o.id, account_id: o.accountId, month: firstDay(o.month), amount: o.amount, note: o.note })),
    p_override_deletes: ovDeletes,
    p_entries: entriesJson(built.entries),
    p_compiled: { cutoff: lastDay(cutoff), closed_through: v.closedThrough ? lastDay(v.closedThrough) : null },
  })
  if (error) rpcError(error)
  return getPlan(ctx, { vehicle: v.name, planId: row.id })
}

export interface PublishInput {
  vehicle: string
  planId: string
  expectedRevision: number
  status: 'published' | 'approved'
  label?: string | null
  notes?: string | null
}

/**
 * Freeze the plan as it compiles right now into an immutable version. 'approved' is the budget
 * baseline variance is measured against — one per plan, never overwritten; later revisions publish.
 */
export async function publishPlan(ctx: ForecastServiceContext, input: PublishInput) {
  const v = await loadVehicle(ctx, input.vehicle, 'write')
  const row = await loadPlanRow(ctx, v, input.planId)
  if (input.status !== 'published' && input.status !== 'approved') throw new ForecastError("status must be 'published' or 'approved'")
  if (!Number.isInteger(input.expectedRevision)) throw new ForecastError('expectedRevision is required')
  const { rules, overrides } = await loadInputs(ctx, row.id)
  const { built, cutoff } = await compile(ctx, v, row, rules, overrides)
  const { data, error } = await (ctx.admin as any).rpc('forecast_publish', {
    p_plan_id: row.id, p_fund_id: ctx.fundId, p_expected_revision: input.expectedRevision, p_status: input.status,
    p_label: input.label?.trim() || null, p_notes: input.notes?.trim() || null, p_user_id: ctx.userId || null,
    p_meta: { cutoff: lastDay(cutoff), closed_through: v.closedThrough ? lastDay(v.closedThrough) : null },
    p_inputs: { rules, overrides, window: { first: built.first, last: built.last } },
    p_entries: entriesJson(built.entries),
  })
  if (error) rpcError(error)
  return { versionId: (data as any).id as string, versionNo: (data as any).versionNo as number }
}

export interface SeriesInput {
  vehicle: string
  /** Omit for actuals only. */
  planId?: string
  /** A published version; omit for the live draft. */
  versionId?: string
  view?: ReportView
  start: MonthKey
  end: MonthKey
  interval?: Interval
}

export interface SeriesResult extends Report {
  vehicle: string
  currency: string
  plan: { id: string; name: string; kind: PlanKind; revision: number } | null
  version: { id: string; versionNo: number; status: string; publishedAt: string } | null
  /** The cutoff the numbers use: a version's as published, the draft's as compiled. */
  actualsThrough: MonthKey | null
  closedThrough: MonthKey | null
  /** Accounts with an override in range, by month, for marking cells. */
  overridden: Record<string, MonthKey[]>
  /** Rule method and basis per account, for the drill-down. */
  sources: Record<string, { method: RuleMethod | 'override'; basis: string; warnings: string[] }>
  /** The months the plan's own entries cover. */
  planWindow: { first: MonthKey; last: MonthKey } | null
  warnings: string[]
}

const MAX_MONTHS = 240

export async function getSeries(ctx: ForecastServiceContext, input: SeriesInput): Promise<SeriesResult> {
  const v = await loadVehicle(ctx, input.vehicle, 'read')
  return seriesFor(ctx, v, input)
}

/** The approved version of a plan, or null. */
async function approvedVersionId(ctx: ForecastServiceContext, planId: string): Promise<string | null> {
  const { data } = await (ctx.admin as any).from('forecast_versions').select('id')
    .eq('fund_id', ctx.fundId).eq('plan_id', planId).eq('status', 'approved').maybeSingle()
  return data?.id ?? null
}

async function seriesFor(ctx: ForecastServiceContext, v: VehicleCtx, input: SeriesInput): Promise<SeriesResult> {
  if (!isMonthKey(input.start) || !isMonthKey(input.end)) throw new ForecastError('start and end must be YYYY-MM')
  if (input.start > input.end) throw new ForecastError('start is after end')
  if (monthRange(input.start, input.end).length > MAX_MONTHS) throw new ForecastError(`A range is at most ${MAX_MONTHS} months`)
  const interval: Interval = input.interval ?? 'month'
  if (!['month', 'quarter', 'year'].includes(interval)) throw new ForecastError("interval must be 'month', 'quarter' or 'year'")

  const warnings: string[] = []
  let plan: SeriesResult['plan'] = null
  let version: SeriesResult['version'] = null
  let planEntries: FlowEntry[] = []
  let planFirst: MonthKey | null = null
  let planLast: MonthKey | null = null
  let cutoff: MonthKey | null = null
  let view: ReportView = input.view ?? (input.planId ? 'combined' : 'actual')
  const sources: SeriesResult['sources'] = {}
  const overridden: Record<string, MonthKey[]> = {}

  if (input.planId) {
    const row = await loadPlanRow(ctx, v, input.planId)
    plan = { id: row.id, name: row.name, kind: row.kind, revision: row.revision }
    let inputs: { rules: RuleView[]; overrides: OverrideView[] }
    let versionId = input.versionId
    if (versionId === 'approved') {
      versionId = (await approvedVersionId(ctx, row.id)) ?? undefined
      if (!versionId) throw new ForecastError(`"${row.name}" has no approved version yet`, 404)
    }
    if (versionId) {
      const { data: ver } = await (ctx.admin as any).from('forecast_versions').select('id, version_no, status, published_at, actuals_cutoff, start_month, inputs')
        .eq('fund_id', ctx.fundId).eq('plan_id', row.id).eq('id', versionId).maybeSingle()
      if (!ver) throw new ForecastError('No such version of this plan', 404)
      version = { id: ver.id, versionNo: ver.version_no, status: ver.status, publishedAt: ver.published_at }
      cutoff = ver.actuals_cutoff ? monthOf(ver.actuals_cutoff) : null
      planFirst = ver.inputs?.window?.first ?? monthOf(ver.start_month)
      planLast = ver.inputs?.window?.last ?? null
      inputs = { rules: ver.inputs?.rules ?? [], overrides: ver.inputs?.overrides ?? [] }
      warnings.push(`Version ${ver.version_no} as published ${String(ver.published_at).slice(0, 10)}, actuals through ${cutoff ?? 'none'}`)
    } else {
      // The stored entries were compiled against compiled_cutoff, so that is the boundary they
      // join the actuals at. If today's cutoff differs, say so rather than re-cut silently.
      const resolved = resolveCutoff(row.actuals_cutoff, v)
      cutoff = row.compiled_cutoff ? monthOf(row.compiled_cutoff) : resolved.cutoff
      warnings.push(...resolved.warnings)
      if (cutoff !== resolved.cutoff) {
        warnings.push(`This draft was compiled with actuals through ${cutoff}; the cutoff is now ${resolved.cutoff}. Refresh to recompile.`)
      }
      const w = planWindow({
        kind: row.kind, fiscalYear: row.fiscal_year, startMonth: monthOf(row.start_month), endMonth: monthOf(row.end_month),
        horizonMonths: row.horizon_months, cutoff,
      })
      planFirst = w.first
      planLast = w.last
      inputs = await loadInputs(ctx, row.id)
    }
    planEntries = await loadEntries(ctx, row.id, version?.id ?? null)
    for (const r of inputs.rules) sources[r.accountId] = { method: r.method, basis: describeRule(r), warnings: [] }
    for (const o of inputs.overrides) {
      if (o.month < input.start || o.month > input.end) continue
      ;(overridden[o.accountId] ??= []).push(o.month)
      sources[o.accountId] ??= { method: 'override', basis: 'Entered by month', warnings: [] }
    }
    if (row.kind === 'budget' && view === 'combined' && !input.view) view = 'plan'
  } else {
    view = 'actual'
  }

  // Actuals: everything posted through the end of the range (or today's month, whichever is earlier).
  const actualsAvailableThrough = input.end < thisMonth() ? input.end : thisMonth()
  const ledger = await loadPostedLedger(ctx.admin, ctx.fundId, v.name, lastDay(actualsAvailableThrough))
  if (view !== 'plan' && v.closedThrough && actualsAvailableThrough > v.closedThrough && input.end > v.closedThrough) {
    warnings.push(`Books are closed through ${v.closedThrough}; later actual months are not final`)
  }
  if (view !== 'plan' && !v.closedThrough) warnings.push('No closed periods — every actual month is unclosed')

  const report = buildReport({
    view, accounts: v.accounts, actuals: ledger.postings, plan: planEntries.flatMap(e => e.postings), planFirst, planLast, cutoff,
    actualsAvailableThrough, closedThrough: v.closedThrough, start: input.start, end: input.end, interval,
    actualEntries: actualFlowEntries(ledger.sourcedPostings), planEntries,
  })

  return {
    ...report,
    vehicle: v.name,
    currency: v.currency,
    plan,
    version,
    actualsThrough: view === 'actual' ? actualsAvailableThrough : view === 'combined' ? cutoff : null,
    closedThrough: v.closedThrough,
    overridden,
    sources,
    planWindow: planFirst && planLast ? { first: planFirst, last: planLast } : null,
    warnings,
  }
}

// ---------------------------------------------------------------------------------------------
// Variance
// ---------------------------------------------------------------------------------------------

export interface VarianceInput {
  vehicle: string
  /** The plan measured against. versionId 'approved' (default) = the baseline; omit for the draft. */
  base: { planId: string; versionId?: string | null }
  /** 'actual', or another plan/version (e.g. the latest forecast against the budget). */
  compare: 'actual' | { planId: string; versionId?: string | null }
  start: MonthKey
  end: MonthKey
  interval?: Interval
}

export interface VarianceResponse extends VarianceResult {
  vehicle: string
  currency: string
  base: { plan: SeriesResult['plan']; version: SeriesResult['version'] }
  compare: { kind: 'actual' } | { kind: 'plan'; plan: SeriesResult['plan']; version: SeriesResult['version'] }
  actualsThrough: MonthKey | null
  closedThrough: MonthKey | null
  largest: { revenue: ReturnType<typeof largestVariances>; expenses: ReturnType<typeof largestVariances> }
  warnings: string[]
}

/**
 * Actual vs the approved budget, actual vs a specific earlier forecast, or one plan vs another.
 * Both sides are read through the same series path as the page, monthly, then rolled up by
 * computeVariance — so the variance of a quarter is always its months' dollars re-added.
 */
export async function getVariance(ctx: ForecastServiceContext, input: VarianceInput): Promise<VarianceResponse> {
  const v = await loadVehicle(ctx, input.vehicle, 'read')
  const interval: Interval = input.interval ?? 'month'
  if (!input.base?.planId) throw new ForecastError('base.planId is required')
  const baseVersion = input.base.versionId === undefined ? 'approved' : input.base.versionId ?? undefined
  const base = await seriesFor(ctx, v, {
    vehicle: v.name, planId: input.base.planId, versionId: baseVersion, view: 'plan', start: input.start, end: input.end, interval: 'month',
  })
  const comparingActuals = input.compare === 'actual' || input.compare == null
  const compare = comparingActuals
    ? await seriesFor(ctx, v, { vehicle: v.name, view: 'actual', start: input.start, end: input.end, interval: 'month' })
    : await seriesFor(ctx, v, {
        vehicle: v.name, planId: (input.compare as any).planId, versionId: (input.compare as any).versionId ?? undefined,
        view: 'combined', start: input.start, end: input.end, interval: 'month',
      })

  // Only the months the base plan covers are comparable: a rolling forecast published in June says
  // nothing about March.
  const w = base.planWindow
  const result = computeVariance({ base, compare, interval, actualMonthsOnly: comparingActuals, window: w })
  const warnings = [...new Set([...base.warnings, ...compare.warnings])]
  if (result.periods.some(p => p.partial)) warnings.push('Some periods compare only the months with actuals; they are marked partial')
  if (w && (w.first > input.start || w.last < input.end)) warnings.push(`The base plan covers ${w.first}–${w.last}; months outside it are not compared`)

  return {
    ...result,
    vehicle: v.name,
    currency: v.currency,
    base: { plan: base.plan, version: base.version },
    compare: comparingActuals ? { kind: 'actual' } : { kind: 'plan', plan: compare.plan, version: compare.version },
    actualsThrough: compare.actualsThrough,
    closedThrough: v.closedThrough,
    largest: { revenue: largestVariances(result, { type: 'income', limit: 5 }), expenses: largestVariances(result, { type: 'expense', limit: 5 }) },
    warnings,
  }
}

function describeRule(r: RuleView): string {
  try {
    const p = r.params as any
    switch (r.method) {
      case 'manual': return 'Entered by month'
      case 'fixed': return `${p.amount} every month`
      case 'recurring': return `${p.amount} every ${p.everyMonths} month(s) from ${p.anchor}`
      case 'run_rate': return p.from ? `Average of ${p.from}–${p.to}` : `Trailing ${p.window}-month average`
      case 'growth': return `${p.base} from ${p.baseMonth}, +${p.rate * 100}%/${p.per}`
      case 'seasonal': return `Repeating 12-month profile from ${p.anchor}${p.annualGrowth ? `, +${p.annualGrowth * 100}%/yr` : ''}`
      case 'linked_fee': return 'Linked management fee'
      case 'linked_construction': return `Portfolio construction ${p.flow}`
      default: return r.method
    }
  } catch {
    return r.method
  }
}

// ---------------------------------------------------------------------------------------------
// Fee links — which funds pay which management company, on what cycle
// ---------------------------------------------------------------------------------------------

export interface FeeLinkView {
  id: string
  manco: string
  /** Null when the caller cannot see the fund: the link exists, its detail is not theirs. */
  fund: string | null
  everyMonths: number
  anchorMonth: number
  direction: 'advance' | 'arrears'
  cashLagMonths: number
  active: boolean
  description: string
}

/** The links that touch one vehicle (as the manco or as the fund). */
export async function listFeeLinks(ctx: ForecastServiceContext, input: { vehicle: string }): Promise<{ vehicle: string; links: FeeLinkView[] }> {
  const v = await loadVehicle(ctx, input.vehicle, 'read')
  const links = await loadFeeLinks(ctx.admin, ctx.fundId, v.id)
  const ids = [...new Set(links.flatMap(l => [l.mancoVehicleId, l.fundVehicleId]))]
  const { data } = ids.length
    ? await (ctx.admin as any).from('fund_vehicles').select('id, name').eq('fund_id', ctx.fundId).in('id', ids)
    : { data: [] }
  const names = new Map(((data as any[]) ?? []).map(x => [x.id, x.name as string]))
  return {
    vehicle: v.name,
    links: links.map(l => ({
      id: l.id,
      manco: names.get(l.mancoVehicleId) ?? '',
      fund: seesFund(ctx.access, l.fundVehicleId) ? names.get(l.fundVehicleId) ?? null : null,
      everyMonths: l.everyMonths,
      anchorMonth: l.anchorMonth,
      direction: l.direction,
      cashLagMonths: l.cashLagMonths,
      active: l.active,
      description: cycleLabel(l),
    })),
  }
}

export interface SaveFeeLinkInput {
  manco: string
  fund: string
  everyMonths?: number
  anchorMonth?: number
  direction?: 'advance' | 'arrears'
  cashLagMonths?: number
  active?: boolean
}

/**
 * Create or change a link. It binds two sets of books, so it needs write on both: the manco (which
 * resolveVehicleWithAccess turns into management_company write) and the fund (accounting write, and
 * the fund among the caller's entities). Never inferred — only ever set here.
 */
export async function saveFeeLink(ctx: ForecastServiceContext, input: SaveFeeLinkInput): Promise<FeeLinkView> {
  const manco = await loadVehicle(ctx, input.manco, 'write')
  if (!isManagementCompany(manco.kind)) throw new ForecastError(`"${manco.name}" is not a management company`)
  const fund = await loadVehicle(ctx, input.fund, 'write')
  if (isManagementCompany(fund.kind)) throw new ForecastError(`"${fund.name}" is a management company, not a fund`)
  let timing: CashTiming
  try {
    timing = validateCashTiming({
      mode: 'cycle', everyMonths: input.everyMonths ?? 3, anchor: input.anchorMonth ?? 1,
      direction: input.direction ?? 'advance', lagMonths: input.cashLagMonths ?? 0,
    })
  } catch (e) {
    throw new ForecastError((e as Error).message)
  }
  if (timing.mode !== 'cycle') throw new ForecastError('Invalid billing cycle')
  const { error } = await (ctx.admin as any).from('manco_fee_links').upsert({
    fund_id: ctx.fundId, manco_vehicle_id: manco.id, fund_vehicle_id: fund.id,
    every_months: timing.everyMonths, anchor_month: timing.anchor, direction: timing.direction,
    cash_lag_months: timing.lagMonths, active: input.active !== false, created_by: ctx.userId || null,
    updated_at: new Date().toISOString(),
  }, { onConflict: 'manco_vehicle_id,fund_vehicle_id' })
  if (error) throw error
  const listed = await listFeeLinks(ctx, { vehicle: manco.name })
  return listed.links.find(l => l.fund === fund.name)!
}

export async function deleteFeeLink(ctx: ForecastServiceContext, input: { manco: string; fund: string }): Promise<{ deleted: boolean }> {
  const manco = await loadVehicle(ctx, input.manco, 'write')
  const fund = await loadVehicle(ctx, input.fund, 'write')
  const { data, error } = await (ctx.admin as any).from('manco_fee_links').delete()
    .eq('fund_id', ctx.fundId).eq('manco_vehicle_id', manco.id).eq('fund_vehicle_id', fund.id).select('id')
  if (error) throw error
  return { deleted: ((data as any[]) ?? []).length > 0 }
}
