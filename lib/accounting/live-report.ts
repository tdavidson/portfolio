// The live LP capital report — the second way to produce an LP aggregated capital report.
//
// The existing way is a SNAPSHOT: someone imports a spreadsheet and `lp_investments` rows
// are frozen at that moment. This way derives the same figures from whatever the vehicle's
// books say right now, as of any date, for BOTH kinds of vehicle:
//
//   ledger vehicles — posted journal postings on LP capital accounts
//   events vehicles — lp_capital_events, the lightweight LP-facing leg
//
// The rows this emits are shaped EXACTLY like `lp_investments` rows (one per entity per
// vehicle, same column names, same units). That is the whole trick: every existing consumer
// — portal overview, investor report PDF, Excel export, the GP snapshot page, the LP
// analyst — already knows how to aggregate rows of that shape across vehicles, through
// investor parents, and through associates look-through. Emitting the same shape means the
// live path inherits all of it instead of reimplementing it.
//
// It does NOT write anything. A live report is computed and thrown away; the stored
// snapshots stay exactly as they are, which is what makes the two comparable.

import type { SupabaseClient } from '@supabase/supabase-js'
import { computeCapitalAccounts, emptyAccount, recontributedByLp, type CapitalAccount, type CapitalPosting } from './capital-account'
import { xirr, type CashFlow } from '@/lib/xirr'
import { lpRatios } from '@/lib/lp-metrics'
import { loadCapitalPostings, type CapitalSource } from './capital-source'
import { loadCommitmentEvents, commitmentsFrom, loadPartnerTerms } from './terms'
import { reportingIrr, tooNewForIrr } from './reporting-irr'
import { irrFlowPostings, isIrrFlow } from './irr-flows'
import type { CapitalEvidence } from './capital-evidence'
import { loadReportingCapital } from './reporting-capital'
import { fetchAllRows, listVehicles, loadOwnership } from './load'
import { lookThroughAccount, associateMembers } from './look-through'
import { latestPositionIrr } from './lp-positions'
import { loadFundPreload, vehicleCapitalPreload, commitmentEventsForGroup, type FundPreload } from './fund-preload'
import { roundCents } from './ledger'
import { loadVehicleGpLinks } from './gp-links'
import { vehicleIdByName } from './vehicle-id'
import { adminVehicleRows, loadVehicleRecordSource } from '@/lib/admin-reporting/load'
import { splitAdminRow } from '@/lib/admin-reporting/figures'

/** The metric half of an `lp_investments` row — same names, same units. */
export interface LiveMetrics {
  commitment: number
  called_capital: number | null
  paid_in_capital: number | null
  distributions: number | null
  nav: number | null
  total_value: number | null
  outstanding_balance: number | null
  /** Called capital NOT yet funded (the receivable): called − wired. Zero on an events-tracked
   *  vehicle, where there is no call-vs-fund distinction. */
  receivable: number | null
  dpi: number | null
  rvpi: number | null
  tvpi: number | null
  /**
   * Per-LP IRR, computed from their dated capital movements plus their current NAV as a
   * terminal value.
   *
   * DATED AT RECOGNITION, NOT AT THE WIRE. On a ledger vehicle a contribution is dated when the
   * CALL was issued, not when the LP's money actually landed — the cash date lives on the
   * funding entry that clears the 1300 receivable. So this is a call-dated IRR. Where LPs fund
   * promptly the two are the same; where they fund late it runs slightly high. (On an
   * events-sourced vehicle there is no ambiguity: the event date IS the cash date.)
   *
   * That is a deliberate, disclosed simplification rather than a hidden one. The alternative —
   * tracing every call to its funding entry — is a separate piece of work, and this is the same
   * basis the fund has always reported on.
   */
  irr: number | null
}

export interface LiveInvestmentRow extends LiveMetrics {
  evidence?: CapitalEvidence
  entity_id: string
  /** The vehicle name, matching `lp_investments.portfolio_group`. */
  portfolio_group: string
  /** Which producer this row came from — surfaced so a reader knows what they're trusting. */
  source: CapitalSource
  /**
   * Set when this row is a LOOK-THROUGH: the member's share of an associate/GP vehicle's
   * position, rather than a position they hold directly. Names the associate they hold it via,
   * so a reader can tell the two apart — and so nobody mistakes one for double-counting.
   */
  lookThroughVia?: string
  /**
   * Set on an admin-reported vehicle's row: the administrator whose figures it shows, as stated.
   * Its IRR, TVPI and DPI are the fund's net LP-only figures for the date, not this LP's own.
   */
  reportedBy?: string
  /** Set on a row from an admin-reported vehicle: figures as the administrator states them. */
  adminReported?: true
  /** An admin-reported row's carried interest, as the administrator states it. */
  carried_interest?: number | null
}

// Round the shared ratio to 1e-4 to keep float noise out of the reconciliation compare.
const round4 = (r: number | null): number | null => (r == null ? null : Math.round(r * 10000) / 10000)

/**
 * Turn one LP's capital account into the metric columns.
 *
 * Sign conventions, which are easy to get wrong: a capital account is a CREDIT balance, so
 * `contributions` arrives positive and `distributions` arrives NEGATIVE. `lp_investments`
 * stores distributions as a positive cumulative figure, hence the negation.
 *
 * called vs paid-in: they are THE SAME NUMBER. Capital is recognised when it is CALLED, and
 * an LP snapshot's `paid_in_capital` means exactly that — recognised, and possibly still
 * unfunded. What differs from both is FUNDED (`called − receivable`): the cash that has
 * actually arrived. On an events vehicle there is no receivable, so all three coincide.
 *
 * This block used to claim paid-in was "cash actually received", and the code agreed — which
 * put a different meaning behind `paid_in_capital` here than in the `lp_investments` rows
 * these are deliberately shaped like, and turned every outstanding call into a phantom
 * reconciliation break.
 */
/**
 * One LP's IRR from their dated capital movements.
 *
 * Signs are from the LP's point of view: a contribution is money OUT of their pocket
 * (negative), a distribution is money back (positive), and their remaining capital is a
 * terminal inflow at the reporting date — the fund would have to hand it over if it liquidated
 * today.
 *
 * Only CASH movements count, and a secondary sale to or from another partner at the value moved;
 * pass `irrFlowPostings` rows so an assignment's history has moved to its new holder. Fees, marks
 * and gains change the LP's NAV, and the NAV is already the terminal value — including them as
 * flows would count the same economics twice.
 */
export function lpIrr(
  postings: CapitalPosting[],
  nav: number,
  asOf: string
): number | null {
  const flows: CashFlow[] = []

  for (const p of postings) {
    if (!p.entryDate) continue
    if (!isIrrFlow(p)) continue

    // capitalDelta = -amount. A contribution raises capital (+) and is cash OUT for the LP (−).
    const capitalDelta = -p.amount
    const flow = -capitalDelta
    if (flow === 0) continue
    flows.push({ date: new Date(p.entryDate), amount: flow })
  }

  if (flows.length === 0) return null
  if (tooNewForIrr(flows, new Date(asOf))) return null
  flows.push({ date: new Date(asOf), amount: nav })

  flows.sort((a, b) => a.date.getTime() - b.date.getTime())
  const rate = xirr(flows)
  return rate == null || !Number.isFinite(rate) ? null : Math.round(rate * 10000) / 10000
}

export function deriveMetrics(
  account: CapitalAccount,
  commitment: number,
  receivable: number,
  irr: number | null = null,
  /** Capital recontributed from recycled proceeds: called, but it uses no commitment (recontributedByLp). */
  recontributed = 0,
): LiveMetrics {
  // PAID-IN IS CALLED CAPITAL. Capital is recognized when it is CALLED, not when the cash
  // lands, and an LP snapshot uses `paid_in_capital` to mean exactly that — recognized, and
  // possibly still unfunded.
  //
  // This used to be `called − receivable` (i.e. FUNDED) while emitting it under the name
  // `paid_in_capital`, in rows shaped deliberately like `lp_investments`. So the same field
  // name meant two different things on the two sides of the live-vs-snapshot reconciliation,
  // and any LP with an outstanding call showed as a break that wasn't one. It also made DPI
  // and TVPI here disagree with the same LP's snapshot for no reason a reader could see.
  //
  // `funded` is still available — it is `called − receivable` — but it is not the
  // denominator and it is not "paid in".
  const called = roundCents(account.contributions)
  const paidIn = called
  const distributions = roundCents(-account.distributions)
  const nav = roundCents(account.ending)
  const totalValue = roundCents(nav + distributions)
  const rr = lpRatios({ commitment, paidIn, distributions, nav })

  return {
    commitment: roundCents(commitment),
    called_capital: called,
    paid_in_capital: paidIn,
    distributions,
    nav,
    total_value: totalValue,
    outstanding_balance: roundCents(commitment - paidIn + recontributed),
    receivable: roundCents(receivable),
    // Denominator is paid-in (cash the LP actually put in), matching how every existing
    // read path computes these — see lib/lp-report-pdf.ts computeRow.
    dpi: round4(rr.dpi),
    rvpi: round4(rr.rvpi),
    tvpi: round4(rr.tvpi),
    irr,
  }
}

/** One vehicle's live rows, plus which producer answered. */
export async function liveRowsForVehicle(
  admin: SupabaseClient,
  fundId: string,
  group: string,
  asOf?: string,
  preload?: FundPreload
): Promise<{ source: CapitalSource; rows: LiveInvestmentRow[] }> {
  const idMap = preload?.idMap
  const admin_ = await adminReportedRows(admin, fundId, group, asOf, preload)
  if (admin_) return { source: 'events', rows: admin_ }
  const { source, postings, receivableByLp, commitmentByLp, evidenceByLp } = await loadReportingCapital(
    admin, fundId, group, asOf, preload,
  )

  const accountByLp = computeCapitalAccounts(postings)
  const recontributed = recontributedByLp(postings)

  // Union: an LP with a commitment but no activity still belongs on the report (they show
  // as fully unfunded), and an LP with activity but no recorded commitment must not vanish.
  const ids = new Set<string>([
    ...Array.from(evidenceByLp.keys()),
    ...Array.from(accountByLp.keys()),
    ...Array.from(commitmentByLp.keys()),
  ])

  // Each LP's own IRR flows, with assignments resolved across partners. Grouped once rather than
  // filtering per LP.
  const postingsByLp = new Map<string, CapitalPosting[]>()
  for (const p of irrFlowPostings(postings)) {
    if (!p.lpEntityId) continue
    const list = postingsByLp.get(p.lpEntityId) ?? []
    list.push(p)
    postingsByLp.set(p.lpEntityId, list)
  }

  const irrDate = asOf ?? new Date().toISOString().slice(0, 10)

  const rows = Array.from(ids).map(entityId => {
    const account = accountByLp.get(entityId) ?? emptyAccount()
    const lpPostings = postingsByLp.get(entityId) ?? []
    const evidence = evidenceByLp.get(entityId)
    const irr = reportingIrr(lpPostings, account.ending, evidence)
    const metrics = deriveMetrics(account, commitmentByLp.get(entityId) ?? 0, receivableByLp.get(entityId) ?? 0, irr, recontributed.get(entityId) ?? 0)
    if (evidence) {
      metrics.called_capital = metrics.paid_in_capital = evidence.values.contributions
      metrics.distributions = evidence.values.distributions
      metrics.nav = evidence.values.nav
      metrics.total_value = metrics.nav == null || metrics.distributions == null ? null : roundCents(metrics.nav + metrics.distributions)
      metrics.outstanding_balance = metrics.paid_in_capital == null ? null : roundCents(metrics.commitment - metrics.paid_in_capital)
      const ratios = lpRatios({ commitment: metrics.commitment, paidIn: metrics.paid_in_capital, distributions: metrics.distributions, nav: metrics.nav })
      metrics.dpi = ratios.dpi; metrics.rvpi = ratios.rvpi; metrics.tvpi = ratios.tvpi
      if (evidence.basis === 'reported' && !receivableByLp.has(entityId)) metrics.receivable = null
    }
    return { entity_id: entityId, evidence, portfolio_group: group, source, ...metrics }
  })
  return { source, rows }
}

/**
 * An admin-reported vehicle's rows: the administrator's figures as stated, nothing recalculated.
 * Null for a vehicle that keeps its own books, which then reports from them as before.
 */
async function adminReportedRows(
  admin: SupabaseClient, fundId: string, group: string, asOf?: string, preload?: FundPreload,
): Promise<LiveInvestmentRow[] | null> {
  let vehicleId: string | null
  if (preload) {
    vehicleId = preload.idMap.get(group) ?? null
    if (!vehicleId || !preload.adminVehicles?.has(vehicleId)) return null
  } else {
    vehicleId = await vehicleIdByName(admin, fundId, group).catch(() => null)
    if (!vehicleId || (await loadVehicleRecordSource(admin, fundId, vehicleId)).recordSource !== 'admin') return null
  }
  const rows = await adminVehicleRows(admin, fundId, vehicleId, asOf, preload ? {
    positions: preload.adminPositionsByVehicleId?.get(vehicleId) ?? [],
    fundByDate: preload.adminFundFiguresByVehicleId?.get(vehicleId) ?? new Map(),
  } : undefined)
  return rows.map(r => {
    const missing = ([['contributions', r.paid_in_capital], ['distributions', r.distributions], ['nav', r.nav]] as const)
      .filter(([, v]) => v == null).map(([k]) => k)
    const evidence: CapitalEvidence = {
      values: { contributions: r.paid_in_capital, distributions: r.distributions, nav: r.nav },
      basis: 'reported',
      asOf: r.asOf,
      reportedIrr: r.irr,
      canCalculateIrr: false,
      missing,
      conflict: false,
      ledgerThrough: null,
      observationDates: [r.asOf],
      entryIds: [],
      reviewed: false,
    }
    return {
      entity_id: r.entity_id,
      portfolio_group: group,
      source: 'events' as const,
      evidence,
      adminReported: true as const,
      ...(r.reportedBy ? { reportedBy: r.reportedBy } : {}),
      commitment: r.commitment,
      called_capital: r.called_capital,
      paid_in_capital: r.paid_in_capital,
      distributions: r.distributions,
      nav: r.nav,
      total_value: r.total_value,
      outstanding_balance: r.outstanding_balance,
      receivable: r.receivable,
      carried_interest: r.carried_interest,
      dpi: r.dpi,
      rvpi: r.rvpi,
      tvpi: r.tvpi,
      irr: r.irr,
    }
  })
}

export interface LiveReport {
  asOf: string | null
  rows: LiveInvestmentRow[]
  /** Per-vehicle provenance, so the UI can say where each number came from. */
  vehicles: { group: string; source: CapitalSource; lps: number }[]
  /** entity_id -> display name, for rendering without a second round-trip. */
  entityNames: Map<string, string>
}

export interface AssociateLink {
  /** The associate vehicle's own name (where its members' books live). */
  associateGroup: string
  /** The vehicle it invests INTO. */
  servesGroup: string
  /** The lp_entity through which it holds that position. */
  entityId: string
}

/**
 * Associate/GP vehicles that hold a position in another vehicle, keyed by id — not by name.
 *
 * The old model matched free text (`lp_associates_overrides.associates_entity` had to match an
 * investor name AND a portfolio_group string), so renaming anything silently broke the
 * look-through and nobody found out until an LP's returns were wrong. Links now come from
 * `vehicle_gp_links` (many-to-many: one associate can be GP of several vehicles, one row per
 * link), falling back to the legacy single `serves_vehicle_id` column only when that table is
 * absent — see `loadVehicleGpLinks`.
 */
async function loadAssociateLinks(admin: SupabaseClient, fundId: string): Promise<AssociateLink[]> {
  const [links, vehRes] = await Promise.all([
    loadVehicleGpLinks(admin, fundId),
    admin
      .from('fund_vehicles' as any)
      .select('id, name, kind, active')
      .eq('fund_id', fundId),
  ])

  const vehById = new Map<string, { name: string; kind: string; active: boolean }>(
    (((vehRes as any).data as any[]) ?? []).map(v => [v.id as string, { name: v.name as string, kind: v.kind as string, active: v.active as boolean }])
  )

  const out: AssociateLink[] = []
  for (const l of links) {
    if (!l.lpEntityId) continue
    const gp = vehById.get(l.gpVehicleId)
    if (!gp || gp.kind !== 'associate' || !gp.active) continue
    const served = vehById.get(l.servedVehicleId)
    if (!served) continue
    out.push({ associateGroup: gp.name, servesGroup: served.name, entityId: l.lpEntityId })
  }
  return out
}

/**
 * Explode an associate's position in the fund into its members' shares.
 *
 * Ownership comes from the associate vehicle's OWN books — the members' commitments to it.
 * Carry comes from its `partner_allocation_terms`, and can diverge from ownership entirely
 * (including members with carry points and no commitment at all).
 *
 * The associate's own row is REPLACED by the member rows, never shown alongside them — showing
 * both would double-count the same money, which is exactly the bug the old model had everywhere
 * except one page.
 */
async function applyLookThrough(
  admin: SupabaseClient,
  fundId: string,
  rows: LiveInvestmentRow[],
  asOf?: string,
  preload?: FundPreload,
  preloadedLinks?: AssociateLink[],
): Promise<LiveInvestmentRow[]> {
  const idMap = preload?.idMap
  const links = preloadedLinks ?? await loadAssociateLinks(admin, fundId)
  if (links.length === 0) return rows

  // Phase 1 — parallel: read each associate's books and compute its member rows. Reads only.
  // The associate's own fund row (for source + commitment) is read from the ORIGINAL `rows`, so
  // links don't depend on one another's mutations — independent associates (the norm) are
  // unaffected; a chained associate (one holding through another) is an unsupported edge that the
  // sequential apply below guards against rather than double-counts. `memberRows === null` means
  // "linked but couldn't explode" (no member split / no rebuildable account) — tag only.
  type Plan = { link: AssociateLink; associateRow: LiveInvestmentRow; memberRows: LiveInvestmentRow[] | null }
  const plans = (await Promise.all(links.map(async (link): Promise<Plan | null> => {
    const associateRow = rows.find(r => r.entity_id === link.entityId && r.portfolio_group === link.servesGroup)
    if (!associateRow) return null // the associate holds nothing in that vehicle — nothing to look through

    if (associateRow.evidence?.missing.length) return { link, associateRow, memberRows: null }

    // The associate's members and their two allocations, from the associate vehicle's own books.
    const [commitmentEvents, terms, owners] = await Promise.all([
      loadCommitmentEvents(admin, fundId, link.associateGroup, idMap, preload ? commitmentEventsForGroup(preload, link.associateGroup) : undefined),
      loadPartnerTerms(admin, fundId, link.associateGroup, idMap),
      preload ? Promise.resolve(preload.ownershipByGroup.get(link.associateGroup) ?? []) : loadOwnership(admin, fundId, link.associateGroup),
    ])

    const basis = (await loadReportingCapital(admin, fundId, link.associateGroup, asOf, preload)).commitmentByLp
    const carryWeights = new Map(
      terms
        .filter(t => t.category === 'carried_interest' && t.participates && t.weightOverride != null)
        .map(t => [t.lpEntityId, t.weightOverride as number])
    )

    const members = associateMembers(basis, carryWeights)
    if (members.length === 0) return { link, associateRow, memberRows: null }

    // The fund reports its administrator's figures: split the associate's row as stated, by the
    // associate's own terms (lib/admin-reporting/figures.ts splitAdminRow), not the fund's books.
    if (associateRow.adminReported) {
      const memberRows: LiveInvestmentRow[] = splitAdminRow(associateRow, members).map(m => ({
        ...associateRow,
        ...m,
        called_capital: m.paid_in_capital,
        total_value: m.nav == null || m.distributions == null ? null : roundCents(m.nav + m.distributions),
        outstanding_balance: m.paid_in_capital == null ? null : roundCents(m.commitment - m.paid_in_capital),
        receivable: null,
        carried_interest: null,
        evidence: associateRow.evidence ? {
          ...associateRow.evidence,
          values: { contributions: m.paid_in_capital, distributions: m.distributions, nav: m.nav },
        } : undefined,
        lookThroughVia: link.associateGroup,
      }))
      return { link, associateRow, memberRows }
    }

    // Rebuild the associate's capital account so the look-through can split its BUCKETS —
    // the metric row alone can't, because carry has to follow points while capital follows
    // ownership.
    const assocAccounts = computeCapitalAccounts(
      (await loadCapitalPostings(admin, fundId, link.servesGroup, asOf, idMap, preload ? vehicleCapitalPreload(preload, link.servesGroup) : undefined)).postings
    )
    const assocAccount = assocAccounts.get(link.entityId)
    if (!assocAccount) return { link, associateRow, memberRows: null }

    const exploded = lookThroughAccount(assocAccount, members)
    const memberRows: LiveInvestmentRow[] = Array.from(exploded.entries()).map(([entityId, account]) => ({
      entity_id: entityId,
      portfolio_group: link.servesGroup,
      source: associateRow.source,
      lookThroughVia: link.associateGroup,
      ...deriveMetrics(
        account,
        // A member's "commitment" to the fund is their share of the associate's commitment to it.
        roundCents(associateRow.commitment * ownershipShare(members, entityId)),
        0
      ),
    }))
    return { link, associateRow, memberRows }
  }))).filter((p): p is Plan => p !== null)

  // Phase 2 — sequential apply, in link order. Tagging and the double-count DROP are cheap and
  // order-sensitive, so they run here rather than in the parallel read phase above.
  let out = rows
  for (const { link, associateRow, memberRows } of plans) {
    if (!out.includes(associateRow)) continue // already consumed by a chained associate — skip

    // Whatever happens, this row must never read as a direct LP interest — it came through the
    // associate. If we couldn't explode it, tag it (honest attribution) and move on.
    if (memberRows === null) {
      out = out.map(r => (r === associateRow ? { ...r, lookThroughVia: link.associateGroup } : r))
      continue
    }

    // DROP TWO THINGS, or the same money is counted twice.
    //
    //  1. The associate's OWN row in the fund — the member rows now represent it.
    //
    //  2. Every row of the ASSOCIATE VEHICLE ITSELF. A member's capital account on the
    //     associate's books IS their share of the associate's position in the fund — the GP
    //     entity's `1500 Investment in Fund` reconciles to its capital-account balance on the
    //     fund's books. Emitting both the member's capital in the associate AND their
    //     looked-through share of what the associate holds reports the same economics twice, and
    //     it would look entirely plausible: two rows, two vehicles, double the money.
    //
    // The look-through row is the one to keep, because it puts the member where they belong —
    // in the fund, alongside the direct LPs, which is the whole point of doing this.
    out = out.filter(r => r !== associateRow && r.portfolio_group !== link.associateGroup)
    out = [...out, ...memberRows]
  }

  return out
}

function ownershipShare(members: { lpEntityId: string; ownershipWeight: number }[], id: string): number {
  const total = members.reduce((s, m) => s + Math.max(0, m.ownershipWeight), 0)
  if (total <= 0) return 0
  const mine = members.find(m => m.lpEntityId === id)?.ownershipWeight ?? 0
  return Math.max(0, mine) / total
}

/**
 * The whole fund, live: every vehicle, every LP, as of a date (default: today / all data).
 *
 * This is the aggregate report. An LP holding across three vehicles gets three rows, exactly
 * as they would in a stored snapshot — the cross-vehicle roll-up is then done by the same
 * consumer code that already does it for snapshots.
 *
 * `entityIds`: a caller that will keep only these entities' rows (one investor's report card).
 * Only the vehicles they hold — directly, or through an associate/GP vehicle — are built, which
 * gives those entities exactly the rows the whole-fund build gives them (a vehicle's rows depend
 * only on that vehicle's books). Rows of other LPs in those vehicles come along; callers filter.
 */
export async function generateLiveReport(
  admin: SupabaseClient,
  fundId: string,
  asOf?: string,
  opts: {
    entityIds?: string[]
    /** Read each vehicle's whole ledger rather than only its partner-tagged rows. Same rows out;
     *  here so the tests can show it. */
    fullLedger?: boolean
  } = {},
): Promise<LiveReport> {
  const [allGroups, links] = await Promise.all([listVehicles(admin, fundId), loadAssociateLinks(admin, fundId)])
  const scope = opts.entityIds ? await vehiclesForEntities(admin, fundId, opts.entityIds, links) : null
  const groups = scope ? allGroups.filter(g => scope.has(g)) : allGroups
  // Scoped, the associate links whose vehicle is out of scope cannot touch these entities' rows
  // (vehiclesForEntities brings in every associate they are a member of, or hold through).
  const lookThroughLinks = scope ? links.filter(l => scope.has(l.associateGroup)) : links

  // One fund-wide read of the per-vehicle lookups (id map, entity names/classes, ownership,
  // capital source, vintage), then thread it through — the per-vehicle loaders no longer each
  // issue their own query for every vehicle. (P1 did the id map; P2 folds in the rest.)
  // Only the partner-tagged ledger rows: LP capital is built from nothing else, and on a big book
  // they are a small part of it (loadLedgerRowsBatch capitalOnly).
  const preload = await loadFundPreload(admin, fundId, asOf, scope ? Array.from(scope) : undefined, { capitalOnly: !opts.fullLedger })

  const perVehicle = await Promise.all(
    groups.map(async group => {
      const { source, rows } = await liveRowsForVehicle(admin, fundId, group, asOf, preload)
      return { group, source, rows }
    })
  )

  // Names come from the preload (every entity in the fund — a superset of each vehicle's).
  const entityNames = new Map(preload.entityNames)

  // Look through any associate/GP vehicle: its position in the fund becomes its members'
  // positions. This is what puts a member who invests via the GP entity into the LP report at
  // all — before, they simply weren't in it.
  const rows = await applyLookThrough(admin, fundId, perVehicle.flatMap(v => v.rows), asOf, preload, lookThroughLinks)

  // Members surfaced by the look-through may not be named in any vehicle's roster.
  const missing = rows.map(r => r.entity_id).filter(id => !entityNames.has(id))
  if (missing.length > 0) {
    const { data } = await admin
      .from('lp_entities' as any)
      .select('id, entity_name')
      .eq('fund_id', fundId)
      .in('id', Array.from(new Set(missing)))
    for (const e of ((data as any[]) ?? [])) entityNames.set(e.id, e.entity_name)
  }

  return {
    asOf: asOf ?? null,
    rows,
    vehicles: perVehicle.map(v => ({ group: v.group, source: v.source, lps: v.rows.length })),
    entityNames,
  }
}

/**
 * Every vehicle (by name) in which any of `entityIds` can have a row: wherever they hold a
 * commitment, an ownership row, a reported position, carry terms, a per-LP account or a tagged
 * posting, plus the associate vehicles they hold through and the vehicles those serve.
 *
 * Reading a vehicle too many is harmless (its other LPs are filtered out); missing one would drop
 * a row, so every source a row can come from is asked, and a failed read widens to the whole fund.
 */
export async function vehiclesForEntities(
  admin: SupabaseClient,
  fundId: string,
  entityIds: string[],
  links?: AssociateLink[],
): Promise<Set<string> | null> {
  const ids = Array.from(new Set(entityIds))
  const out = new Set<string>()
  if (ids.length === 0) return out
  try {
    const db = admin as any
    const byIds = <T>(table: string, cols: string, idCol: string, extra?: (q: any) => any) =>
      fetchAllRows<T>((f, t) => {
        let q = db.from(table).select(cols).eq('fund_id', fundId).in(idCol, ids)
        if (extra) q = extra(q)
        return q.order('id').range(f, t)
      })
    const [vehicles, investments, commitments, positions, terms, accounts, assocLinks] = await Promise.all([
      fetchAllRows<any>((f, t) => db.from('fund_vehicles').select('id, name').eq('fund_id', fundId).order('id').range(f, t)),
      byIds<any>('lp_investments', 'portfolio_group', 'entity_id'),
      byIds<any>('commitment_events', 'vehicle_id', 'lp_entity_id'),
      byIds<any>('lp_positions', 'vehicle_id', 'lp_entity_id'),
      byIds<any>('partner_allocation_terms', 'vehicle_id', 'lp_entity_id'),
      byIds<any>('chart_of_accounts', 'vehicle_id', 'lp_entity_id'),
      links ? Promise.resolve(links) : loadAssociateLinks(admin, fundId),
    ])
    const nameById = new Map<string, string>(vehicles.map((v: any) => [v.id as string, v.name as string]))
    const addId = (id: string | null | undefined) => { const n = id ? nameById.get(id) : undefined; if (n) out.add(n) }
    for (const r of investments) if (r.portfolio_group) out.add(r.portfolio_group)
    for (const rows of [commitments, positions, terms, accounts]) for (const r of rows) addId(r.vehicle_id)

    // A posting can be tagged to an LP on a pooled capital account: ask each remaining vehicle
    // whether it has one (a single-row probe each, in parallel).
    const found = new Set(Array.from(out).map(n => vehicles.find((v: any) => v.name === n)?.id).filter(Boolean))
    const rest = vehicles.filter((v: any) => !found.has(v.id))
    const probes = await Promise.all(rest.map(async (v: any) => {
      const { data, error } = await db.from('journal_postings').select('id')
        .eq('book', 'actual').eq('fund_id', fundId).eq('vehicle_id', v.id).in('lp_entity_id', ids).limit(1)
      if (error) throw error
      return ((data as any[]) ?? []).length > 0 ? v.name as string : null
    }))
    for (const n of probes) if (n) out.add(n)

    // Associates: a member needs the vehicle the associate serves; the entity that holds the
    // associate's position needs the associate's own books (its row is replaced by the members').
    const own = new Set(ids)
    for (let grew = true; grew;) {
      grew = false
      for (const l of assocLinks) {
        if (!(out.has(l.associateGroup) || own.has(l.entityId))) continue
        for (const g of [l.associateGroup, l.servesGroup]) if (!out.has(g)) { out.add(g); grew = true }
      }
    }
    return out
  } catch {
    return null
  }
}
