// Linked drivers: the amounts a linked rule takes from elsewhere in the app.
//
//   linked_construction  a fund's own construction fees or expenses, by month
//   linked_fee (manco)   every linked fund's construction fees, as management-fee revenue, on each
//                        link's billing cycle
//   linked_fee (fund)    the fund's own construction fees, on its link's billing cycle
//
// One economic schedule — the fund's construction fees — feeds both the manco's revenue and the
// fund's expense; only the cash timing comes from the link.
//
// CONFIDENTIALITY: a manco planner may hold no grant on the funds it manages. Its revenue forecast
// still needs their fees, so the fund's schedule is read with the fund's books opened to this one
// calculation — but what comes back for a fund the caller cannot see is the monthly fee amount and
// nothing else: no fund name, rate, basis or deal. That is the aggregate the brief allows.

import type { SupabaseClient } from '@supabase/supabase-js'
import { hasAccess, type AccessContext } from '@/lib/access/effective'
import { canSeeVehicle } from '@/lib/access/scope'
import { getConstructionModel } from '@/lib/accounting/construction-service'
import { gpLinkFor } from '@/lib/accounting/gp-economics'
import { lpCapitalSummary } from '@/lib/accounting/capital-calls'
import { loadCarryTerms } from '@/lib/accounting/carry'
import { roundCents } from '@/lib/accounting/ledger'
import { isManagementCompany } from '@/lib/vehicle-kinds'
import type { CashTiming } from './compile'
import { monthlyConstruction, type MonthlyConstruction } from './construction-adapter'
import { monthDiff, type MonthKey } from './months'
import type { LinkedDriver, PlanRuleRow } from './plan'
import type { LinkedConstructionParams, LinkedFeeParams, ManagementFeeParams } from './rules'
import { managementFeeByMonth, type FeeInputs } from './fee-rule'
import { primaryPlanRow } from './plan-construction'

export interface FeeLinkRow {
  id: string
  mancoVehicleId: string
  fundVehicleId: string
  everyMonths: number
  anchorMonth: number
  direction: 'advance' | 'arrears'
  cashLagMonths: number
  active: boolean
}

export const mapFeeLink = (r: any): FeeLinkRow => ({
  id: r.id, mancoVehicleId: r.manco_vehicle_id, fundVehicleId: r.fund_vehicle_id, everyMonths: r.every_months,
  anchorMonth: r.anchor_month, direction: r.direction, cashLagMonths: r.cash_lag_months, active: r.active,
})

export const linkTiming = (l: FeeLinkRow): CashTiming => ({
  mode: 'cycle', everyMonths: l.everyMonths, anchor: l.anchorMonth, direction: l.direction, lagMonths: l.cashLagMonths,
})

export async function loadFeeLinks(admin: SupabaseClient, fundId: string, vehicleId: string): Promise<FeeLinkRow[]> {
  const { data, error } = await (admin as any).from('manco_fee_links')
    .select('id, manco_vehicle_id, fund_vehicle_id, every_months, anchor_month, direction, cash_lag_months, active')
    .eq('fund_id', fundId).or(`manco_vehicle_id.eq.${vehicleId},fund_vehicle_id.eq.${vehicleId}`)
  if (error) throw error
  return ((data as any[]) ?? []).map(mapFeeLink)
}

/** Whether the caller may see carry: terms, recipients and their split (the `gp_economics` carve-out). */
export function seesCarry(access: AccessContext): boolean {
  return hasAccess(access, 'gp_economics', 'read')
}

/** Whether the caller may see a management company's detail (its name, a link's billing cycle). */
export function seesManco(access: AccessContext): boolean {
  return hasAccess(access, 'management_company', 'read')
}

/** "paid to Hemrock Management quarterly in advance" — or, without management_company, no detail. */
export function paidToLabel(access: AccessContext, mancoName: string | undefined, link: FeeLinkRow): string {
  return seesManco(access) ? `paid to ${mancoName ?? 'the management company'} ${cycleLabel(link)}` : 'paid to the management company on its billing cycle'
}

/** Whether the caller may see a fund's own detail (name, terms). */
export function seesFund(access: AccessContext, fundVehicleId: string): boolean {
  return canSeeVehicle(access, fundVehicleId) && hasAccess(access, 'accounting', 'read')
}

export interface ScheduleResult {
  monthly: MonthlyConstruction | null
  warnings: string[]
}

/** A fund's construction schedule by month. `open` reads it regardless of the caller's entities. */
export async function fundSchedule(
  ctx: { admin: SupabaseClient; fundId: string; access: AccessContext },
  fundName: string,
  open: boolean,
  /** A plan's own construction; omitted = the entity's primary plan. */
  planId?: string | null,
): Promise<ScheduleResult> {
  const access = open ? { ...ctx.access, vehicles: { all: true, ids: [] } } : ctx.access
  const model = await getConstructionModel({ admin: ctx.admin, fundId: ctx.fundId, access }, { vehicle: fundName, planId: planId ?? null })
  const gross = model.timelineNetOfCarry ? model.grossTimeline : model.timeline
  if (!gross) {
    return { monthly: null, warnings: ['Portfolio construction has no pacing stated, so it has no schedule to link to'] }
  }
  return { monthly: monthlyConstruction(gross, model.asOf.slice(0, 10)), warnings: [] }
}

const flowAmounts = (mc: MonthlyConstruction, flow: 'fees' | 'expenses') => {
  const out = new Map<MonthKey, number>()
  for (const e of mc.events) if (e.flow === flow) out.set(e.month, (out.get(e.month) ?? 0) + e.amount)
  return out
}

export interface LinkedLoad {
  linked: Map<string, LinkedDriver[]>
  /** The vehicle's own monthly construction, when the plan includes it or a rule needs it. */
  construction: MonthlyConstruction | null
  /** A GP entity's share of the fund it is GP of, from that fund's construction (see gpShareOf). */
  gpShare: GpShareSchedule | null
  warnings: string[]
}

/**
 * What a GP entity takes from its fund's forecast, by month: its share of the fund's capital calls
 * and distributions (its commitment over the fund's — returned in full, since its own stake bears no
 * carry, unless the terms say the GP commit bears it), and its cut of the carry (its percent of the
 * carry recipients).
 */
export interface GpShareSchedule {
  fund: string
  months: Map<MonthKey, { called: number; distributed: number; carry: number }>
  basis: string
  warnings: string[]
}

/**
 * A GP entity's share of its fund's construction schedule. The fund's own schedule is read with
 * its books opened to this one calculation (as a manco's fee revenue is): what comes back is
 * monthly amounts and nothing else.
 */
export async function gpShareOf(
  ctx: { admin: SupabaseClient; fundId: string; access: AccessContext },
  gpVehicleName: string,
): Promise<GpShareSchedule | null> {
  const link = await gpLinkFor(ctx.admin, ctx.fundId, gpVehicleName)
  if (!link) return null
  const access = { ...ctx.access, vehicles: { all: true, ids: [] } }
  const model = await getConstructionModel({ admin: ctx.admin, fundId: ctx.fundId, access }, { vehicle: link.servesVehicle })
  const gross = model.timelineNetOfCarry ? model.grossTimeline : model.timeline
  // A caller without the fund sees amounts only — not its name, not this entity's share of it.
  // Carry percentages and carry already paid are gp_economics as well.
  const visible = canSeeVehicle(ctx.access, link.servesVehicleId)
  const showCarry = visible && seesCarry(ctx.access)
  const label = visible ? link.servesVehicle : 'the fund (details restricted)'
  if (!gross) return { fund: label, months: new Map(), basis: `Share of ${label}`, warnings: [`${label} has no portfolio construction pacing, so there is nothing to forecast from`] }

  const [summary, terms] = await Promise.all([
    lpCapitalSummary(ctx.admin, ctx.fundId, link.servesVehicle),
    loadCarryTerms(ctx.admin, ctx.fundId, link.servesVehicle),
  ])
  const total = summary.reduce((s, r) => s + (r.commitment ?? 0), 0)
  const mine = summary.find(r => r.lpEntityId === link.lpEntityId)?.commitment ?? 0
  const share = total > 0 ? mine / total : 0
  const carryPct = (terms.recipients.find(r => r.lpEntityId === link.lpEntityId)?.pct ?? 0) / 100
  // A GP commit that bears carry comes back net, like an LP's: its share of what is left after carry.
  const bears = terms.gpCommitBearsCarry === true
  const warnings: string[] = []
  if (share === 0) warnings.push(`This entity has no commitment recorded in ${label}, so it takes no share of its calls or distributions`)
  const inferred = model.actuals.waterfall?.carryPaidInferred ?? 0
  if (inferred > 0 && showCarry) warnings.push(`${label}'s books record no carry paid, so ${Math.round(inferred).toLocaleString('en-US')} is taken as already paid on its past distributions; only carry still to come is forecast`)

  // THE FUND'S PLAN, when it has one: its calls, distributions and carry as its fund forecast made
  // them (the waterfall on what it actually distributes, month edits included). The GP's stake is its
  // share of every distribution, carry included in the total; its carry is its percent of the carry.
  const fromPlan = await fundPlanCapital(ctx, link.servesVehicleId)
  if (fromPlan) {
    const months = new Map<MonthKey, { called: number; distributed: number; carry: number }>()
    const row = (m: MonthKey) => months.get(m) ?? (months.set(m, { called: 0, distributed: 0, carry: 0 }), months.get(m)!)
    for (const [m, f] of fromPlan) {
      const r = row(m)
      r.called = roundCents(f.called * share)
      r.distributed = roundCents((bears ? f.distributed : f.distributed + f.carry) * share)
      r.carry = roundCents(f.carry * carryPct)
    }
    return { fund: label, months, basis: shareBasis(share, carryPct, label, visible, showCarry, 'calls and distributions', 'from its forecast'), warnings }
  }

  const mc = monthlyConstruction(gross, model.asOf.slice(0, 10))
  // Carry is stated per construction year (the net timeline's waterfall); place it in the months of
  // that year's distributions, so it arrives with the exits that produce it.
  // Keyed by construction year (1 = the twelve months after its as-of month), the way it states them.
  const carryByYear = new Map<number, number>()
  for (const y of (model.timeline?.years ?? [])) carryByYear.set(y.year, y.carriedInterest ?? 0)
  const yearOf = (m: MonthKey) => Math.max(1, Math.ceil(monthDiff(mc.asOfMonth, m) / 12))
  if (carryPct > 0 && !model.timelineNetOfCarry) warnings.push(`${label}'s construction has no carry waterfall, so no carry is forecast`)

  const months = new Map<MonthKey, { called: number; distributed: number; carry: number }>()
  const row = (m: MonthKey) => months.get(m) ?? (months.set(m, { called: 0, distributed: 0, carry: 0 }), months.get(m)!)
  const distByYear = new Map<number, { month: MonthKey; amount: number }[]>()
  for (const e of mc.events) {
    if (e.flow === 'called') row(e.month).called = roundCents(row(e.month).called + e.amount * share)
    if (e.flow === 'distributed') {
      const y = yearOf(e.month)
      const list = distByYear.get(y) ?? []
      list.push({ month: e.month, amount: e.amount })
      distByYear.set(y, list)
    }
  }
  for (const [year, list] of distByYear) {
    const gross = list.reduce((s, d) => s + d.amount, 0)
    const carry = model.timelineNetOfCarry ? (carryByYear.get(year) ?? 0) : 0
    for (const d of list) {
      const carryHere = gross > 0 ? (carry * d.amount) / gross : 0
      const r = row(d.month)
      // The GP's own stake comes back in full — the waterfall charges carry on the LPs' share only
      // (construction-forecast.ts applyLpWaterfall) — and the carry it pays is the GP's on top. When
      // the GP commit bears carry the whole fund runs through the waterfall, so its stake is net.
      r.distributed = roundCents(r.distributed + (bears ? d.amount - carryHere : d.amount) * share)
      r.carry = roundCents(r.carry + carryHere * carryPct)
    }
  }
  return {
    fund: label, months,
    basis: shareBasis(share, carryPct, label, visible, showCarry, 'calls and LP distributions', 'from its portfolio construction'),
    warnings,
  }
}

/** The GP share's basis line: the share only for a caller who sees the fund, its carry % only with gp_economics. */
function shareBasis(share: number, carryPct: number, label: string, visible: boolean, showCarry: boolean, what: string, from: string): string {
  const pct = (n: number) => `${Math.round(n * 1000) / 10}%`
  const head = visible ? `${pct(share)} of ${label}'s ${what}` : `A share of ${label}'s ${what}`
  const carry = carryPct > 0 ? (showCarry ? `, ${pct(carryPct)} of its carry` : ', a share of its carry') : ''
  return `${head}${carry}, ${from}`
}

export async function loadLinkedDrivers(
  ctx: { admin: SupabaseClient; fundId: string; access: AccessContext },
  vehicle: { id: string; name: string; kind: string },
  rules: PlanRuleRow[],
  includeConstruction: boolean,
  /** The plan being compiled — its own construction, not the primary's. */
  planId?: string | null,
): Promise<LinkedLoad> {
  const linked = new Map<string, LinkedDriver[]>()
  const warnings: string[] = []
  const manco = isManagementCompany(vehicle.kind)
  const needsOwn = !manco && (includeConstruction || rules.some(r => r.rule.method === 'linked_construction' || r.rule.method === 'linked_fee'))

  let own: MonthlyConstruction | null = null
  if (needsOwn) {
    const s = await fundSchedule(ctx, vehicle.name, false, planId)
    own = s.monthly
    warnings.push(...s.warnings)
  }

  // A GP entity's flows come from the fund it is GP of — its share of that fund's forecast exits —
  // not from a construction model of its own, which would count the same stake twice.
  const gpShare = includeConstruction && !manco ? await gpShareOf(ctx, vehicle.name) : null
  if (gpShare) warnings.push(...gpShare.warnings)

  const links = rules.some(r => r.rule.method === 'linked_fee' || r.rule.method === 'management_fee') ? (await loadFeeLinks(ctx.admin, ctx.fundId, vehicle.id)).filter(l => l.active) : []
  const names = new Map<string, string>()
  if (links.length) {
    const ids = [...new Set(links.flatMap(l => [l.mancoVehicleId, l.fundVehicleId]))]
    const { data } = await (ctx.admin as any).from('fund_vehicles').select('id, name').eq('fund_id', ctx.fundId).in('id', ids)
    for (const v of (data as any[]) ?? []) names.set(v.id, v.name)
  }

  for (const r of rules) {
    // The plan's own management fee (plans/plan-unified-plan.md §1.3): its terms on this fund's
    // commitments and deployment; paid on the fee link's billing cycle when the fund has one.
    if (r.rule.method === 'management_fee') {
      if (manco) { linked.set(r.id, []); continue }
      const inputs = await feeInputsFor(ctx, vehicle.name, planId ?? null, false)
      const link = links.find(l => l.fundVehicleId === vehicle.id)
      linked.set(r.id, [{
        amounts: managementFeeByMonth(r.rule.params as ManagementFeeParams, inputs),
        ...(link ? { timing: linkTiming(link) } : {}),
        basis: `Management fee on ${(r.rule.params as ManagementFeeParams).basis} capital${inputs.feePayingShare < 1 ? ` (${(inputs.feePayingShare * 100).toFixed(1)}% fee-paying — the GP's stake exempt)` : ''}${link ? `, ${paidToLabel(ctx.access, names.get(link.mancoVehicleId), link)}` : ''}`,
        warnings: [],
      }])
      continue
    }
    if (r.rule.method === 'linked_construction') {
      const p = r.rule.params as LinkedConstructionParams
      if (manco) { linked.set(r.id, []); continue }
      if (!own) { linked.set(r.id, []); continue }
      linked.set(r.id, [{
        amounts: flowAmounts(own, p.flow),
        basis: `Portfolio construction ${p.flow}, spread evenly within each construction year`,
        warnings: [],
      }])
      continue
    }
    if (r.rule.method !== 'linked_fee') continue
    const p = r.rule.params as LinkedFeeParams
    if (!manco) {
      const link = links.find(l => l.fundVehicleId === vehicle.id)
      if (!link) {
        linked.set(r.id, [])
        warnings.push(`${vehicle.name} is not linked to a management company; set up the fee link to forecast its fee on the billing cycle`)
        continue
      }
      linked.set(r.id, own ? [{
        amounts: flowAmounts(own, 'fees'),
        timing: linkTiming(link),
        basis: `Construction fee schedule, ${paidToLabel(ctx.access, names.get(link.mancoVehicleId), link)}`,
        warnings: [],
      }] : [])
      continue
    }
    // Manco revenue: one driver per linked fund.
    const matched = links.filter(l => l.mancoVehicleId === vehicle.id)
      .filter(l => !p.fundVehicle || names.get(l.fundVehicleId)?.toLowerCase() === p.fundVehicle.toLowerCase())
    // Naming a fund the caller cannot see answers exactly as naming one that is not linked — or the
    // filter would tell them whether a restricted fund pays this manco. (Without a filter, every
    // linked fund's fees still come back as restricted amounts.)
    const mine = p.fundVehicle ? matched.filter(l => seesFund(ctx.access, l.fundVehicleId)) : matched
    if (!mine.length) {
      linked.set(r.id, [])
      warnings.push(p.fundVehicle
        ? `No fee link from "${p.fundVehicle}" to ${vehicle.name}`
        : `${vehicle.name} has no linked funds; set up fee links to forecast fee revenue from their schedules`)
      continue
    }
    const drivers: LinkedDriver[] = []
    for (const l of mine) {
      const fundName = names.get(l.fundVehicleId)
      if (!fundName) continue
      const visible = seesFund(ctx.access, l.fundVehicleId)
      const label = visible ? fundName : 'a managed fund (details restricted)'
      // The fund's own fee, from its primary plan's management-fee rule — one schedule, both sides.
      const planFee = await primaryPlanFee(ctx, fundName, l.fundVehicleId)
      if (planFee) {
        drivers.push({ amounts: planFee, timing: linkTiming(l), basis: `Fees from ${label}'s forecast, received ${cycleLabel(l)}`, warnings: [] })
        continue
      }
      const s = await fundSchedule(ctx, fundName, true)
      if (!s.monthly) {
        drivers.push({ amounts: new Map(), timing: linkTiming(l), basis: `Fees from ${label}`, warnings: visible ? s.warnings.map(w => `${fundName}: ${w}`) : ['A linked fund has no construction schedule'] })
        continue
      }
      drivers.push({
        amounts: flowAmounts(s.monthly, 'fees'),
        timing: linkTiming(l),
        basis: `Fees from ${label}'s construction schedule, received ${cycleLabel(l)}`,
        warnings: [],
      })
    }
    linked.set(r.id, drivers)
  }

  return { linked, construction: includeConstruction && !manco && !gpShare ? own : null, gpShare, warnings }
}

export function cycleLabel(l: Pick<FeeLinkRow, 'everyMonths' | 'direction' | 'cashLagMonths'>): string {
  const every = l.everyMonths === 1 ? 'monthly' : l.everyMonths === 3 ? 'quarterly' : l.everyMonths === 6 ? 'semiannually' : 'annually'
  const lag = l.cashLagMonths ? `, ${l.cashLagMonths} month${l.cashLagMonths === 1 ? '' : 's'} later` : ''
  return `${every} in ${l.direction}${lag}`
}

/**
 * What a fund's management fee is charged on: its commitments, deployment and NAV, the fee-paying
 * share (the GP's own stake exempt), and the last year it operates — from the plan's construction.
 */
export async function feeInputsFor(
  ctx: { admin: SupabaseClient; fundId: string; access: AccessContext },
  fundName: string, planId: string | null, open: boolean,
): Promise<FeeInputs> {
  const access = open ? { ...ctx.access, vehicles: { all: true, ids: [] } } : ctx.access
  const model = await getConstructionModel({ admin: ctx.admin, fundId: ctx.fundId, access }, { vehicle: fundName, planId })
  const a = model.actuals
  const deals = (model.grossTimeline ?? model.timeline)?.deals ?? []
  const exits = deals.filter(d => d.proceeds != null && d.exitAt > 0).map(d => Math.ceil(d.exitAt - 1e-9))
  return {
    asOfMonth: model.asOf.slice(0, 7) as MonthKey,
    committed: a.committedCapital,
    deployedTotal: (a.deployedInitial ?? 0) + (a.deployedFollowOn ?? 0),
    nav: a.nav ?? 0,
    feePayingShare: a.feePayingShare ?? 1,
    lastOperatingYear: exits.length ? Math.max(...exits) : null,
  }
}

/** A fund's management fee by month from its primary plan's rule; null when it has none yet. */
async function primaryPlanFee(
  ctx: { admin: SupabaseClient; fundId: string; access: AccessContext },
  fundName: string, fundVehicleId: string,
): Promise<Map<MonthKey, number> | null> {
  const primary = await primaryPlanRow(ctx.admin, ctx.fundId, fundVehicleId)
  if (!primary) return null
  const { data } = await (ctx.admin as any).from('forecast_rules').select('params')
    .eq('fund_id', ctx.fundId).eq('plan_id', primary.id).eq('method', 'management_fee').limit(1)
  const rule = ((data as any[]) ?? [])[0]
  if (!rule) return null
  return managementFeeByMonth(rule.params as ManagementFeeParams, await feeInputsFor(ctx, fundName, primary.id, true))
}

/**
 * A fund's calls, distributions (to partners) and carry by month, from its primary plan's compiled
 * draft — null when it has no primary plan, or its draft books none of them yet.
 */
async function fundPlanCapital(
  ctx: { admin: SupabaseClient; fundId: string },
  fundVehicleId: string,
): Promise<Map<MonthKey, { called: number; distributed: number; carry: number }> | null> {
  const primary = await primaryPlanRow(ctx.admin, ctx.fundId, fundVehicleId)
  if (!primary) return null
  const { data } = await (ctx.admin as any).from('forecast_entries')
    .select('entry_date, kind, memo, forecast_postings(amount)')
    .eq('fund_id', ctx.fundId).eq('plan_id', primary.id).is('version_id', null)
    .in('kind', ['capital_call', 'distribution', 'carry_distribution'])
  const rows = (data as any[]) ?? []
  if (!rows.length) return null
  const out = new Map<MonthKey, { called: number; distributed: number; carry: number }>()
  for (const e of rows) {
    const m = String(e.entry_date).slice(0, 7) as MonthKey
    // Each entry is one positive and one negative leg of the same amount.
    const amount = roundCents(((e.forecast_postings as any[]) ?? []).filter(p => Number(p.amount) > 0).reduce((s, p) => s + Number(p.amount), 0))
    const r = out.get(m) ?? { called: 0, distributed: 0, carry: 0 }
    // Carry is stored as a distribution whose memo says so (service.ts storedKind).
    const isCarry = e.kind === 'carry_distribution' || (e.kind === 'distribution' && /^Carried interest/.test(String(e.memo ?? '')))
    if (e.kind === 'capital_call') r.called = roundCents(r.called + amount)
    else if (isCarry) r.carry = roundCents(r.carry + amount)
    else r.distributed = roundCents(r.distributed + amount)
    out.set(m, r)
  }
  return out
}
