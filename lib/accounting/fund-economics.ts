// Fund-level performance, DERIVED FROM THE LEDGER.
//
// This replaces the old Funds page, which computed its numbers client-side from
// `fund_cash_flows` — a table of hand-typed commitment / called / distribution rows — plus a
// hand-typed cash-on-hand figure, and then ESTIMATED carry with a heuristic:
//
//     estimatedCarry = carryRate × (grossAssets × (1 − gpCommitPct) − lpRemainingCapital)
//
// That heuristic existed because there was no way to know the real number. There is now. The
// close accrues carried interest at each period end on a hypothetical liquidation and books
// it as an equity reallocation between partners' capital accounts (close.ts accrueCarry).
// So an LP's capital account is ALREADY NET of the GP's share, and the fund's NAV is already
// carved up correctly between them. Nothing needs estimating.
//
// WHAT THIS MEANS FOR THE NUMBERS. Net-to-LP performance is now exact rather than
// approximated: it is simply the LP-class partners' own capital accounts. The GP's economics
// are the GP-class partners' accounts. They sum to the fund. There is no plug, no
// gpCommitPct, and no terminal-value-at-`new Date()` (the old IRR discounted future flows to
// today whatever date you asked for).
//
// DENOMINATOR: paid-in, which IS called capital — capital is recognised at the call, and may
// still be unfunded. Same convention as live-report.ts and the LP snapshot, so a fund-level
// TVPI and the LP-level TVPIs underneath it are computed the same way and can be reconciled.

import type { SupabaseClient } from '@supabase/supabase-js'
import { roundCents } from './ledger'
import { reportingIrr } from './reporting-irr'
import { loadReportingCapital } from './reporting-capital'
import { computeCapitalAccounts, bucketForSourceType, emptyAccount, type CapitalAccount } from './capital-account'
import { loadEntityNames, listVehicles } from './load'
import { vehicleIdByName } from './vehicle-id'
import { loadFundPreload, type FundPreload } from './fund-preload'
import { xirr, type CashFlow } from '@/lib/xirr'
import { lpRatios } from '@/lib/lp-metrics'

export interface FundMetrics {
  committed: number
  /** Recognised capital. = called. May include unfunded calls. */
  paidIn: number | null
  /** Commitment not yet called. */
  uncalled: number | null
  distributions: number | null
  /** Remaining capital — the partners' ending balances. Already net of accrued carry. */
  nav: number | null
  totalValue: number | null
  dpi: number | null
  rvpi: number | null
  tvpi: number | null
  irr: number | null
}

export interface VehicleEconomics {
  vehicle: string
  /** The vehicle's stable `fund_vehicles.id`, when it has a registry row — the key the detail
   *  page routes on. Null for legacy vehicles that exist only as a portfolio_group string. */
  id: string | null
  /** The vehicle's vintage year, if recorded. Nothing derives this — it is stated. */
  vintageYear: number | null
  source: 'ledger' | 'events' | 'mixed'
  lpCount: number
  /** Every partner. This is the fund. */
  fund: FundMetrics
  /** LP-class partners only — net-to-LP, exactly, with the GP's carry already removed. */
  lp: FundMetrics
  /** GP-class partners only. */
  gp: FundMetrics
  /** Carried interest accrued to the GP so far. A mark, not a debt — it reverses if NAV falls. */
  carryAccrued: number
  /** The LP-class partners' dated cash movements, one per entry date. Only when asked for
   *  (`{ lpFlows: true }`) — the fund performance report lists them; the overview does not. */
  lpFlows?: LpDatedFlow[]
}

/**
 * One date's capital movements across the LP-class partners, from the fund's side of the table:
 * `contributions` is capital paid in (a refund of an over-call nets it down), `distributions` is
 * capital paid back out. Both are the same postings `rollUp` sums, so they total to `lp.paidIn`
 * and `lp.distributions`.
 */
export interface LpDatedFlow {
  date: string
  contributions: number
  distributions: number
}

/** Sum capital postings into one row per date, oldest first. Pure. */
export function datedCapitalFlows(
  postings: { lpEntityId: string; amount: number; sourceType?: string | null; entryDate?: string | null }[],
  ids: Set<string>,
): LpDatedFlow[] {
  const byDate = new Map<string, LpDatedFlow>()
  for (const p of postings) {
    if (!p.entryDate || !ids.has(p.lpEntityId)) continue
    const bucket = bucketForSourceType(p.sourceType, p.amount)
    if (bucket !== 'contributions' && bucket !== 'distributions') continue
    // A capital account is a credit balance: a contribution posts negative, a distribution positive.
    const row = byDate.get(p.entryDate) ?? { date: p.entryDate, contributions: 0, distributions: 0 }
    if (bucket === 'contributions') row.contributions += -p.amount
    else row.distributions += p.amount
    byDate.set(p.entryDate, row)
  }
  return Array.from(byDate.values())
    .map(r => ({ date: r.date, contributions: roundCents(r.contributions), distributions: roundCents(r.distributions) }))
    .filter(r => r.contributions !== 0 || r.distributions !== 0)
    .sort((a, b) => a.date.localeCompare(b.date))
}


const EMPTY: FundMetrics = {
  committed: 0, paidIn: 0, uncalled: 0, distributions: 0, nav: 0, totalValue: 0,
  dpi: null, rvpi: null, tvpi: null, irr: null,
}

/**
 * Roll a set of capital accounts up into fund-level metrics.
 *
 * Pure, so the arithmetic can be pinned by a test. `accounts` is whichever slice you want:
 * every partner (the fund), the LP-class ones (net to LP), or the GP-class ones.
 */
export function rollUp(
  accounts: CapitalAccount[],
  committed: number,
  flows: CashFlow[],
  asOf: Date | null,
): FundMetrics {
  // No capital accounts: nothing has been called, so the WHOLE commitment is uncalled. Called
  // capital genuinely requires a capital source — ledger postings or dated lp_positions — and a
  // vehicle with neither correctly reports 0 called. But `uncalled` is commitment − paid-in,
  // which here is the whole commitment, not 0. Leaving EMPTY's 0 in place made a fund that had
  // closed but not yet called report Committed 18.5M / Called 0 / Uncalled 0.
  if (accounts.length === 0) {
    const c = roundCents(committed)
    return { ...EMPTY, committed: c, uncalled: c }
  }

  const paidIn = roundCents(accounts.reduce((s, a) => s + a.contributions, 0))
  // Distributions are stored negative on a capital account (it is a credit balance).
  const distributions = roundCents(accounts.reduce((s, a) => s + -a.distributions, 0))
  const nav = roundCents(accounts.reduce((s, a) => s + a.ending, 0))
  const totalValue = roundCents(nav + distributions)

  // The terminal value is the remaining capital AT THE REPORTING DATE — not at `new Date()`,
  // which is what the old fund page used and which quietly discounted every future flow back
  // to today no matter which date you asked it about.
  const irrFlows = [...flows]
  if (asOf && Math.abs(nav) > 0.005) irrFlows.push({ date: asOf, amount: nav })

  const rr = lpRatios({ commitment: committed, paidIn, distributions, nav })
  return {
    committed: roundCents(committed),
    paidIn,
    uncalled: roundCents(committed - paidIn),
    distributions,
    nav,
    totalValue,
    dpi: rr.dpi,
    rvpi: rr.rvpi,
    tvpi: rr.tvpi,
    irr: irrFlows.length >= 2 ? xirr(irrFlows) : null,
  }
}

/**
 * One vehicle's economics from shared capital evidence and investment records.
 * Unsupported reported values remain unknown; empty vehicles remain visible.
 */
export async function vehicleEconomics(
  admin: SupabaseClient,
  fundId: string,
  group: string,
  asOf?: string,
  preload?: FundPreload,
  opts: { lpFlows?: boolean } = {},
): Promise<VehicleEconomics> {
  // With a preload, ownership, entity names/classes, capital source and vintage come from the
  // one fund-wide read; without it (direct callers) each still loads per-vehicle as before.
  const idMap = preload?.idMap
  const [{ source, postings, commitmentByLp, evidenceByLp }, names, classes, vintage, id] = await Promise.all([
    loadReportingCapital(admin, fundId, group, asOf, preload),
    preload ? Promise.resolve(preload.entityNames) : loadEntityNames(admin, fundId, group),
    preload ? Promise.resolve(preload.entityClasses) : loadEntityClasses(admin, fundId),
    preload ? Promise.resolve(preload.vintageByName.get(group) ?? null) : loadVintage(admin, fundId, group),
    // The stable registry id the detail page routes on. From the preload's name→id map when we
    // have it, else a per-vehicle lookup. Null for a legacy portfolio_group with no registry row.
    vehicleIdByName(admin, fundId, group, idMap),
  ])

  const accounts = computeCapitalAccounts(postings)

  const asOfDate = asOf ? new Date(asOf) : new Date()

  // The IRR terminal (when the NAV is valued) must be dated when the NAV was actually STATED.
  // A ledger vehicle's NAV persists to the report date, so asOf is right. A tracking vehicle's
  // NAV is stated as of its latest position date — using the report date instead spreads a large
  // TVPI over the months since and annualizes it to nonsense (a single cutover then has no time
  // spread and derives no IRR, which is the honest answer).
  const terminalDate = asOfDate
  // Dated flows, from the LP's point of view: a contribution is money out (negative), a
  // distribution is money back (positive).
  const flowsFor = (ids: Set<string> | null): CashFlow[] => {
    const out: CashFlow[] = []
    for (const p of postings) {
      if (ids && (!p.lpEntityId || !ids.has(p.lpEntityId))) continue
      const bucket = bucketForSourceType(p.sourceType, p.amount)
      // Transfers between partners count as flows for a subset of partners (they net out fund-wide).
      if (bucket !== 'contributions' && bucket !== 'distributions' && bucket !== 'transfers') continue
      const delta = -p.amount // capital delta: credit positive
      if (Math.abs(delta) < 0.005) continue
      out.push({
        date: new Date(p.entryDate ?? asOfDate.toISOString().slice(0, 10)),
        // A contribution increases capital (delta > 0) and is money OUT for the partner.
        amount: -delta,
      })
    }
    return out
  }

  // Union of everyone with a capital account OR a commitment. A partner who committed but was
  // never called still belongs on the LP lens — otherwise `fund.committed` (which sums all
  // commitments) would not equal `lp.committed + gp.committed`. (Mirrors the union live-report
  // does for the same reason.)
  const ids = Array.from(new Set([...Array.from(accounts.keys()), ...Array.from(commitmentByLp.keys()), ...Array.from(evidenceByLp.keys())]))
  const lpIds = new Set(ids.filter(id => (classes.get(id) ?? 'lp') !== 'gp'))
  const gpIds = new Set(ids.filter(id => (classes.get(id) ?? 'lp') === 'gp'))

  const sumCommit = (set: Set<string> | null) =>
    Array.from(commitmentByLp.entries())
      .filter(([id]) => !set || set.has(id))
      .reduce((s, [, v]) => s + v, 0)

  // A commitment-only partner has no capital account yet — treat them as an empty (all-zero) one.
  const pick = (set: Set<string> | null) =>
    ids.filter(id => !set || set.has(id)).map(id => accounts.get(id) ?? emptyAccount())

  const carryAccrued = roundCents(
    Array.from(gpIds).reduce((s, id) => s + (accounts.get(id)?.carriedInterest ?? 0), 0)
  )

  const metricsFor = (set: Set<string> | null): FundMetrics => {
    const metrics = rollUp(pick(set), sumCommit(set), flowsFor(set), terminalDate)
    const selected = ids.filter(id => !set || set.has(id))
    const evidence = selected.map(id => evidenceByLp.get(id))
    if (selected.length === 1) {
      metrics.irr = reportingIrr(postings.filter(p => p.lpEntityId === selected[0]), metrics.nav ?? 0, evidence[0])
    } else if (evidence.some(e => !e || !e.canCalculateIrr || e.conflict || e.missing.length > 0)) {
      metrics.irr = null
    }
    const sumValues = (field: 'contributions' | 'distributions' | 'nav'): number | null => {
      const values = evidence.map(e => e ? e.values[field] : 0)
      return values.some(v => v == null) ? null : roundCents(values.reduce<number>((sum, v) => sum + v!, 0))
    }
    metrics.paidIn = sumValues('contributions')
    metrics.distributions = sumValues('distributions')
    metrics.nav = sumValues('nav')
    metrics.totalValue = metrics.nav == null || metrics.distributions == null ? null : roundCents(metrics.nav + metrics.distributions)
    metrics.uncalled = metrics.paidIn == null ? null : roundCents(metrics.committed - metrics.paidIn)
    const ratios = lpRatios({ commitment: metrics.committed, paidIn: metrics.paidIn, distributions: metrics.distributions, nav: metrics.nav })
    metrics.dpi = ratios.dpi; metrics.rvpi = ratios.rvpi; metrics.tvpi = ratios.tvpi
    return metrics
  }

  return {
    vehicle: group,
    id,
    vintageYear: vintage,
    source,
    lpCount: lpIds.size,
    fund: metricsFor(null),
    lp: metricsFor(lpIds),
    gp: metricsFor(gpIds),
    carryAccrued,
    ...(opts.lpFlows ? { lpFlows: datedCapitalFlows(postings, lpIds) } : {}),
  }
}

/** Every vehicle in the fund. */
export async function fundEconomics(
  admin: SupabaseClient,
  fundId: string,
  asOf?: string,
  groups?: string[],
): Promise<VehicleEconomics[]> {
  const vehicles = groups ?? await listVehicles(admin, fundId)
  if (vehicles.length === 0) return []
  const preload = await loadFundPreload(admin, fundId, asOf, vehicles)
  // Vehicles are independent, so derive them concurrently rather than one-await-per-vehicle.
  // This was the dominant source of /funds load lag: latency was ~(round-trips × vehicle count)
  // because each vehicle's queries waited for the previous vehicle to finish. (Mirrors what
  // generateLiveReport already does for /lps.) The fund-wide lookups are read once (preload) and
  // threaded in so the per-vehicle loaders skip their per-vehicle queries.
  const out = await Promise.all(vehicles.map(v => vehicleEconomics(admin, fundId, v, asOf, preload)))
  return out.sort((a, b) => a.vehicle.localeCompare(b.vehicle))
}

/** partner_class per entity. */
async function loadEntityClasses(admin: SupabaseClient, fundId: string): Promise<Map<string, string>> {
  const { data } = await (admin as any)
    .from('lp_entities').select('id, partner_class').eq('fund_id', fundId)
  return new Map(((data as any[]) ?? []).map(e => [e.id as string, (e.partner_class ?? 'lp') as string]))
}

/** The vehicle's stated vintage year. */
async function loadVintage(admin: SupabaseClient, fundId: string, group: string): Promise<number | null> {
  const { data } = await (admin as any)
    .from('fund_vehicles').select('vintage_year').eq('fund_id', fundId).eq('name', group).maybeSingle()
  const y = (data as any)?.vintage_year
  return y == null ? null : Number(y)
}
