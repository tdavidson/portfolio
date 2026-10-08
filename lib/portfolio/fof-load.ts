import type { SupabaseClient } from '@supabase/supabase-js'
import { vehicleIdByName } from '@/lib/accounting/vehicle-id'
import { computeFundPositions, type FundPosition } from './fof-metrics'
import type { ManagerStatementFigures } from './fof-valuation'

/**
 * The one place fund-of-funds positions are loaded from the database.
 *
 * Everything downstream — the holdings list, the quarterly grid, the pre-close check, the
 * exhibits — reads the SAME positions from the SAME computation. Three surfaces each running
 * their own query and their own mapping is how the grid and the close end up disagreeing
 * about a partner's unfunded commitment.
 *
 * The computation itself stays pure in fof-metrics.ts; this module is only the I/O around it.
 */

export interface FofData {
  positions: FundPosition[]
  /** The manager's own since-inception figures, for the tie-out. Empty when none reported. */
  managerFigures: ManagerStatementFigures[]
  /** Raw register rows, for surfaces that show the notices themselves. */
  events: any[]
  navStatements: any[]
}

/** The raw register rows, loaded once. Windowed computation happens in computeFofFromRaw. */
export interface FofRawData {
  holdings: { id: string; name: string }[]
  terms: any[]
  events: any[]
  navs: any[]
}

/**
 * Load the register WITHOUT computing anything, so a caller that needs several as-of dates
 * (the statement package with comparison periods) pays for one round trip rather than one
 * per window.
 */
export async function loadFofRaw(
  admin: SupabaseClient,
  fundId: string,
  /**
   * WHICH VEHICLE HOLDS THESE FUNDS, by name — the same thing every other accounting loader
   * takes, resolved here so no caller has to. Omit it only for the firm-wide holdings register,
   * which is deliberately cross-vehicle.
   *
   * `companies` carries no vehicle for a fund holding, and one holding can be held by several of
   * our entities — terms are per (company, vehicle), NAVs per (company, vehicle, as-of date). So the
   * vehicle lives on the ACTIVITY: notices, NAVs, terms and ledger accounts naming this vehicle. That
   * is the rule the direct schedule of investments uses too (`buildSoiPositions` keys off
   * `investment_transactions.portfolio_group`, which confirmation sets from `vehicle_id`).
   *
   * Scoping by fund alone is what made these figures firm-wide: one vehicle's report listed every
   * other vehicle's holdings, and the LP statement PDF carried them too.
   */
  group?: string,
): Promise<FofRawData | null> {
  // Every query here THROWS on error rather than reading `data` as empty: these rows feed the close's
  // check and a NAV's ledger mark (fof-nav.ts), and an empty read would compute a wrong figure, not fail.
  const { data: holdings, error: holdingsError } = await admin
    .from('companies').select('id, name')
    .eq('fund_id', fundId).eq('holding_type', 'fund').order('name')
  if (holdingsError) throw new Error(`Fund holdings could not be loaded: ${holdingsError.message}`)
  const holdingRows = ((holdings as any[]) ?? [])
  if (holdingRows.length === 0) return null

  const vehicleId = group === undefined ? undefined : await vehicleIdByName(admin, fundId, group)
  // A name that resolves to nothing is not "every vehicle". Refuse rather than widening.
  if (group !== undefined && !vehicleId) return null

  const scopedEvents = (admin as any).from('fund_capital_events').select('*').eq('fund_id', fundId)
  const scopedNavs = (admin as any).from('fund_nav_statements').select('*').eq('fund_id', fundId)
  const results = await Promise.all([
    (admin as any).from('fund_holding_terms').select('*').eq('fund_id', fundId),
    (vehicleId ? scopedEvents.eq('vehicle_id', vehicleId) : scopedEvents).order('event_date'),
    (vehicleId ? scopedNavs.eq('vehicle_id', vehicleId) : scopedNavs).order('as_of_date'),
    // THE LEDGER IS THE THIRD WITNESS, and usually the first one to exist. A holding imported
    // from a general ledger has its own 1100-<id>/1200-<id> accounts carrying cost and marks
    // before anybody records a single notice — so the books know which entity holds it even
    // though the register is still empty. Scoping on the register alone made a half-entered
    // fund-of-funds invisible on the very page you use to finish entering it.
    // Indexed by chart_of_accounts (fund_id, vehicle_id, company_id) where company_id is not null.
    vehicleId
      ? (admin as any).from('chart_of_accounts').select('company_id')
          .eq('fund_id', fundId).eq('vehicle_id', vehicleId).not('company_id', 'is', null)
      : Promise.resolve({ data: [] as any[], error: null }),
  ])
  const failed = results.find(r => r.error)
  if (failed) throw new Error(`The fund register could not be loaded: ${failed.error.message}`)
  const [{ data: terms }, { data: events }, { data: navs }, { data: ledgerAccounts }] = results

  const eventRows = ((events as any[]) ?? [])
  // A holding with no activity for this vehicle is not this vehicle's holding. Terms alone are a
  // commitment somebody recorded against the firm's register, not a position on these books.
  const termRows = ((terms as any[]) ?? [])
  // A holding is this vehicle's if this vehicle's ACTIVITY is against it, or if its terms say so —
  // a fund committed to but not yet called has no events at all, and leaving it out would hide a
  // real unfunded obligation from the schedule of investments.
  // A manager NAV recorded for this vehicle is activity too: a fund whose first document was its
  // statement (no notice yet, no ledger accounts) is still this vehicle's, and leaving it out made
  // the statement's mark compute against no position at all.
  const held = vehicleId
    ? new Set([
        ...eventRows.map(e => e.company_id as string),
        ...termRows.filter(t => t.vehicle_id === vehicleId).map(t => t.company_id as string),
        ...((ledgerAccounts as any[]) ?? []).map(a => a.company_id as string),
        ...((navs as any[]) ?? []).map(n => n.company_id as string),
      ])
    : null
  const scopedHoldings = held ? holdingRows.filter(h => held.has(h.id as string)) : holdingRows
  if (scopedHoldings.length === 0) return null

  // One terms row per holding, for THIS vehicle. An unassigned row (vehicle_id null) is the
  // legacy shape and still applies; a row belonging to another entity does not.
  const scopedTerms = vehicleId
    ? termRows.filter(t => t.vehicle_id === vehicleId || t.vehicle_id == null)
    : termRows

  return {
    holdings: scopedHoldings.map(h => ({ id: h.id, name: h.name })),
    terms: scopedTerms,
    events: eventRows,
    navs: ((navs as any[]) ?? []),
  }
}

/** Positions and manager figures at one as-of date. Pure over already-loaded rows. */
export function computeFofFromRaw(raw: FofRawData, asOf: string): {
  positions: FundPosition[]
  managerFigures: ManagerStatementFigures[]
} {
  // Prefer a row that names an entity over an unassigned one, so a holding mid-migration reads
  // its real commitment rather than whichever row the array happened to end on.
  const termByCompany = new Map<string, any>()
  for (const t of raw.terms) {
    const current = termByCompany.get(t.company_id)
    if (!current || (current.vehicle_id == null && t.vehicle_id != null)) termByCompany.set(t.company_id, t)
  }

  const positions = computeFundPositions({
    asOf,
    terms: raw.holdings.map(h => {
      const t: any = termByCompany.get(h.id)
      return {
        companyId: h.id,
        name: h.name,
        managerName: t?.manager_name ?? null,
        vintageYear: t?.vintage_year ?? null,
        strategy: t?.strategy ?? null,
        commitment: Number(t?.commitment ?? 0),
      }
    }),
    events: raw.events.map(e => ({
      companyId: e.company_id,
      kind: e.kind,
      eventDate: e.event_date,
      amount: Number(e.amount),
      recallableAmount: Number(e.recallable_amount ?? 0),
      charReturnOfCapital: Number(e.char_return_of_capital ?? 0),
      charRealizedGain: Number(e.char_realized_gain ?? 0),
      charIncome: Number(e.char_income ?? 0),
    })),
    navs: raw.navs.map(n => ({
      companyId: n.company_id,
      asOfDate: n.as_of_date,
      reportedNav: Number(n.reported_nav),
      basis: n.basis,
    })),
  })

  // Tie out against the NEWEST statement on or before the reporting date — the same one the
  // position is carried on. An older statement's since-inception figures would disagree with
  // our register for the perfectly good reason that time passed.
  const newestByCompany = new Map<string, any>()
  for (const n of raw.navs) {
    if (n.as_of_date > asOf) continue
    const cur = newestByCompany.get(n.company_id)
    if (!cur || n.as_of_date > cur.as_of_date) newestByCompany.set(n.company_id, n)
  }
  const managerFigures: ManagerStatementFigures[] = Array.from(newestByCompany.values()).map(n => ({
    companyId: n.company_id,
    reportedContributions: n.reported_contributions === null ? null : Number(n.reported_contributions),
    reportedDistributions: n.reported_distributions === null ? null : Number(n.reported_distributions),
    reportedUnfunded: n.reported_unfunded === null ? null : Number(n.reported_unfunded),
  }))

  return { positions, managerFigures }
}

/** Convenience: load and compute at one date. Delegates, so there is one mapping, not two. */
export async function loadFofData(
  admin: SupabaseClient,
  fundId: string,
  asOf: string,
  /** The vehicle's name. See loadFofRaw — omit only for the firm-wide register. */
  group?: string,
): Promise<FofData> {
  const raw = await loadFofRaw(admin, fundId, group)
  if (!raw) return { positions: [], managerFigures: [], events: [], navStatements: [] }
  const { positions, managerFigures } = computeFofFromRaw(raw, asOf)
  return { positions, managerFigures, events: raw.events, navStatements: raw.navs }
}

/**
 * What the LEDGER carries per fund holding: its cost account plus its accumulated mark, the
 * per-holding pair ensureInvestmentAccounts creates. Takes an already-loaded ledger because
 * every caller has one — loading it twice is the expensive mistake here.
 */
export function ledgerCarryingByHolding(
  accounts: { id: string; companyId?: string | null; subtype?: string | null }[],
  postings: { accountId: string; amount: number }[],
): Map<string, number> {
  const byAccount = new Map(accounts.map(a => [a.id, a]))
  const out = new Map<string, number>()
  for (const p of postings) {
    const acct = byAccount.get(p.accountId)
    if (!acct?.companyId) continue
    if (acct.subtype !== 'investment' && acct.subtype !== 'unrealized') continue
    out.set(acct.companyId, round2((out.get(acct.companyId) ?? 0) + p.amount))
  }
  return out
}

const round2 = (n: number) => Math.round(n * 100) / 100
