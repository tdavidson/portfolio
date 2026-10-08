// The full statement package for one vehicle, scoped to a statement period.
//
// Extracted from the /api/accounting/statements route so the on-screen statements
// and the Excel workpaper export are computed by ONE function — a tax workpaper
// that disagreed with the numbers on the Statements page would be worse than no
// export at all. Both callers pass the resolved `group` and the request's search
// params; everything downstream is identical.

import type { SupabaseClient } from '@supabase/supabase-js'
import {
  trialBalance, balanceSheet, incomeStatement, scheduleOfInvestments,
  changesInPartnersCapital, statementOfCashFlows,
  postingsInPeriod, postingsAsOf, openingCashBalance,
  type TrialBalance, type BalanceSheet, type IncomeStatement,
  type ScheduleOfInvestments, type ChangesInPartnersCapital, type StatementOfCashFlows,
} from './statements'
import { loadPostedLedger, loadEntityNames, type SourcedPosting } from './load'
import { buildSoiPositions, withFundHoldingFigures, withChainBalances, type SoiCompany } from './soi'
import { holdersAsOf, walletsForEntity } from '@/lib/portfolio/holding-entities'
import { walletFromRow, balanceFromRow, type Wallet, type WalletBalance } from '@/lib/portfolio/wallets'
import { withFairValueLevels, feedFromRow, type PriceFeed, type PriceObservation } from '@/lib/portfolio/quotes'
import { allQuotes } from '@/lib/portfolio/quote-read'
import { loadFofRaw, computeFofFromRaw, type FofRawData } from '@/lib/portfolio/fof-load'
import { commitmentSchedule, performanceTable, type CommitmentSchedule, type PerformanceTable } from '@/lib/portfolio/fof-exhibits'
import { valuationBasisNote, type ValuationBasisRow } from '@/lib/portfolio/fof-valuation'
import { computeCapitalAccounts, totalNav } from './capital-account'
import { resolvePeriod, customPeriod, comparisonPeriods, type PeriodPreset, type StatementPeriod } from './statement-period'
import { accountBalances, normalBalance } from './ledger'
import type { Account } from './types'
import { booksForBasis, basisFromParam, type StatementBasis } from './books'
import { vehicleKindByName } from './vehicle-domain'
import { equityLabel } from './vocab'

/** The JSON body the statements route returns — the on-screen statement set. */
export interface StatementPayload {
  period: StatementPeriod
  asOf: string | null
  trialBalance: TrialBalance
  balanceSheet: BalanceSheet
  incomeStatement: IncomeStatement
  scheduleOfInvestments: ScheduleOfInvestments
  changesInPartnersCapital: ChangesInPartnersCapital
  cashFlows: StatementOfCashFlows | null
  /**
   * Fund-of-funds exhibits. OPTIONAL and absent when the fund holds no funds, so every
   * existing consumer — the statements page, the workbook, the PDF — is untouched and a
   * non-FoF package is byte-identical to before.
   */
  fof?: {
    commitments: CommitmentSchedule
    performance: PerformanceTable
    valuationNote: ValuationBasisRow[]
  }
}

export interface StatementPackage {
  /** Exactly what the statements API returns — do not add fields the UI doesn't expect. */
  payload: StatementPayload
  // Extras the workpaper export needs beyond the on-screen payload:
  /** The vehicle's chart, for the GL-detail supporting schedule. */
  accounts: Account[]
  /** Postings within the period window, entry-tagged — the GL-detail rows. */
  inPeriodSourced: SourcedPosting[]
  /**
   * EVERY posted posting, entry-tagged — what the GL detail needs to carry a balance in at the
   * window start and run it forward. Optional so a package assembled without it (older callers,
   * test fixtures) still builds; the GL detail then opens every account at zero.
   */
  allSourced?: SourcedPosting[]
  /** Prior-period payloads, most-recent-first, present only when ?compare= was passed. */
  comparisons?: StatementPayload[]
  /**
   * 'book' (the actual ledger — the default and every existing caller) or 'tax' (actual plus the
   * book-to-tax overlay, read together). Stated on the workbook cover and the PDF header so a
   * file never leaves without saying which basis it is on.
   */
  basis?: StatementBasis
}

export { booksForBasis, basisFromParam, type StatementBasis }

export interface LedgerData {
  accounts: Account[]
  postings: Awaited<ReturnType<typeof loadPostedLedger>>['postings']
  capitalPostings: Awaited<ReturnType<typeof loadPostedLedger>>['capitalPostings']
  sourcedPostings: SourcedPosting[]
  names: Awaited<ReturnType<typeof loadEntityNames>>
  txns: any[]
  companies: any[]
  group: string
  cashAccount: Account | undefined
  gpAccount: Account | undefined
  /** Fund-of-funds positions as of the LATEST date; recomputed per window in computePayload.
   *  Empty for a fund that holds no funds. */
  fofRaw: FofRawData | null
  /** Price feeds and their stored quotes, for ASC 820 leveling. Both empty for a fund that
   *  holds nothing quoted, which levels every position at 3 — the correct answer. */
  feeds: PriceFeed[]
  observations: PriceObservation[]
  /** Set when the feeds or quotes could not be read, so the schedule says its levels are not
   *  real ones rather than showing every position at Level 3 as if that were known. */
  levelWarning?: string
  /** Every wallet that COULD speak for this entity — tagged to it, or untagged — as raw rows, with
   *  their readings. Which of them do is decided per period window (`entityWalletsAsOf`): an
   *  untagged wallet belongs to the holding's only holder AT THAT DATE, the close's rule. Both
   *  empty for an entity holding no digital assets. */
  walletRows?: any[]
  balances?: WalletBalance[]
  /** Set when the wallet read failed, so the schedule can say the chain column is missing. */
  chainWarning?: string
  /** Min entryDate across postings — the inception bound for comparison stepping. */
  earliest: string | null
  /** The vehicle's kind, for the words a statement uses (lib/accounting/vocab.ts). Null for a
   *  legacy vehicle with no registry row, which reads as a fund. */
  kind: string | null
}

/** Min entryDate across postings, ignoring nulls. */
export function earliestPostingDate(postings: { entryDate?: string | null }[]): string | null {
  let min: string | null = null
  for (const p of postings) {
    const d = p.entryDate
    if (d && (min === null || d < min)) min = d
  }
  return min
}

/** One DB load, reused across every period window. */
export async function loadLedgerData(
  admin: SupabaseClient,
  fundId: string,
  group: string,
  opts: { basis?: StatementBasis } = {},
): Promise<LedgerData> {
  const [
    { accounts, postings, capitalPostings, sourcedPostings }, names,
    { data: txns }, { data: companies }, fofRaw,
    { data: feedRows, error: feedsError }, kind,
    { data: walletRows, error: walletsError },
  ] = await Promise.all([
    loadPostedLedger(admin, fundId, group, undefined, undefined, undefined, booksForBasis(opts.basis ?? 'book')),
    loadEntityNames(admin, fundId, group),
    admin.from('investment_transactions' as any).select('*').eq('fund_id', fundId).order('transaction_date', { ascending: true }),
    // Every holding, fund and company alike: both carry 1100/1200 balances, so the SOI's
    // ledger control total only ties if both are present. The SOI splits them for DISPLAY by
    // holding_type — see SoiPosition.holdingType — rather than by excluding either here.
    admin.from('companies' as any).select('*').eq('fund_id', fundId),
    loadFofRaw(admin, fundId, group),
    (admin as any).from('price_feeds').select('*').eq('fund_id', fundId),
    vehicleKindByName(admin, fundId, group),
    (admin as any).from('crypto_wallets').select('*').eq('fund_id', fundId),
  ])
  // The chain column is informational: a failed wallet read must not take the statements, PDF,
  // exports or tax package down with it. Degrade to no column and say so (the close, which gates
  // on these readings, stays fail-closed in its own path).
  let walletRowsKept: any[] = []
  let balances: WalletBalance[] = []
  let chainWarning: string | undefined
  try {
    if (walletsError) throw new Error(`crypto_wallets read failed: ${walletsError.message}`)
    // Tagged to this entity, or untagged: whether an untagged one is this entity's depends on who
    // held the holding on each period's end, so that is decided in computePayload.
    walletRowsKept = ((walletRows as any[]) ?? []).filter(w => !w.portfolio_group || w.portfolio_group === group)
    // Readings by wallet id, never fund-wide: PostgREST's row cap would silently truncate them.
    if (walletRowsKept.length > 0) {
      const { data: balanceRows, error: balancesError } = await (admin as any).from('crypto_wallet_balances').select('*')
        .in('wallet_id', walletRowsKept.map(w => w.id))
      if (balancesError) throw new Error(`crypto_wallet_balances read failed: ${balancesError.message}`)
      balances = ((balanceRows as any[]) ?? []).map(balanceFromRow)
    }
  } catch (e) {
    console.error('[statement-package] on-chain balances unavailable:', e)
    walletRowsKept = []
    balances = []
    chainWarning = 'On-chain balances could not be read.'
  }

  // Same posture for the fair value levels: a failed feeds or quotes read levels nothing, and the
  // schedule says so — every position at Level 3 is a real answer for a private book, so it must
  // not also be what a failed read looks like.
  let feeds: PriceFeed[] = []
  let observations: PriceObservation[] = []
  let levelWarning: string | undefined
  try {
    if (feedsError) throw new Error(`price_feeds read failed: ${feedsError.message}`)
    feeds = ((feedRows as any[]) ?? []).map(feedFromRow)
    // Every quote of these feeds, PAGED: the package prices several period ends (comparisons), and
    // an unpaged read would stop at the row cap with the latest quotes missing.
    observations = await allQuotes(admin, fundId, feeds.map(f => f.id))
  } catch (e) {
    console.error('[statement-package] price feeds unavailable:', e)
    feeds = []
    observations = []
    levelWarning = 'Price feeds could not be read, so every position is shown at Level 3.'
  }
  return {
    accounts, postings, capitalPostings, sourcedPostings, names,
    kind,
    fofRaw,
    feeds, observations, levelWarning,
    walletRows: walletRowsKept, balances, chainWarning,
    txns: (txns as any[]) ?? [],
    companies: (companies as any[]) ?? [],
    group,
    cashAccount: accounts.find(a => a.code === '1000'),
    gpAccount: accounts.find(a => a.code === '3000'),
    earliest: earliestPostingDate(postings),
  }
}

/**
 * This entity's watched wallets on `date`: tagged to it, or untagged on a holding it alone held by
 * then — `holdersAsOf` over the FULL fund's transactions (txns is not entity-filtered), the rule
 * and the date the close uses (close.ts `loadWalletCloseInputs`).
 */
export function entityWalletsAsOf(data: Pick<LedgerData, 'walletRows' | 'txns' | 'group'>, date: string): Wallet[] {
  const rows = data.walletRows ?? []
  if (rows.length === 0) return []
  return walletsForEntity(rows, data.group, holdersAsOf(data.txns, date)).map(walletFromRow)
}

/** The per-window statement math — pure over already-loaded ledger data. */
export function computePayload(data: LedgerData, period: StatementPeriod): StatementPayload {
  const cumulative = postingsAsOf(data.postings, period.end)
  const inPeriod = postingsInPeriod(data.postings, period.start, period.end)
  const inPeriodSourced = postingsInPeriod(data.sourcedPostings, period.start, period.end)

  const capitalAccounts = computeCapitalAccounts(data.capitalPostings, period)
  const itdCapitalAccounts = computeCapitalAccounts(data.capitalPostings, { end: period.end })
  const nav = totalNav(itdCapitalAccounts)

  // Levelled AS OF THE PERIOD END, not today: a position inside its lock-up at 31 March is
  // Level 2 in the Q1 statements however unrestricted it has since become, and a company that
  // listed in June is Level 3 in every statement struck before it.
  //
  // Built WITH realized companies, then PARTITIONED: `scheduleOfInvestments` receives only live
  // holdings, so the statutory schedule, its subtotals and its ledger tie-out are unchanged.
  // The realized ones ride along separately for inception-to-date consumers.
  const allPositions = withFairValueLevels(
    buildSoiPositions(
      data.txns, data.companies as SoiCompany[], data.group,
      period.end ? new Date(period.end) : undefined,
      { includeRealized: true },
    ),
    // `?? []` because a LedgerData assembled before feeds existed genuinely has none, and no
    // feeds is a MEANINGFUL state rather than a missing input: every position levels at 3.
    data.feeds ?? [], data.observations ?? [],
    period.end ?? new Date().toISOString().slice(0, 10),
  )
  const isRealized = (p: { cost: number; fairValue: number }) => p.cost === 0 && p.fairValue === 0
  // Commitment, called and unfunded for the underlying funds, onto their own schedule rows. The
  // register is already loaded for this vehicle, so this costs no extra query.
  const fofPositions = data.fofRaw
    ? computeFofFromRaw(data.fofRaw, period.end ?? new Date().toISOString().slice(0, 10)).positions
    : []
  const asOf = period.end ?? new Date().toISOString().slice(0, 10)
  const positions = withChainBalances(
    withFundHoldingFigures(allPositions.filter(p => !isRealized(p)), fofPositions),
    entityWalletsAsOf(data, asOf), data.balances ?? [],
    asOf,
  )
  // pctOfNetAssets is 0 by construction: a realized position has no fair value to be a
  // percentage of. Stated rather than left undefined, because SoiRow requires it.
  const realizedRows = allPositions.filter(isRealized).map(p => ({ ...p, pctOfNetAssets: 0 }))

  const bal = accountBalances(cumulative)
  const gpEnding = data.gpAccount ? normalBalance(data.gpAccount, bal.get(data.gpAccount.id) ?? 0) : 0

  return {
    period,
    asOf: period.end,
    trialBalance: trialBalance(data.accounts, cumulative),
    balanceSheet: balanceSheet(data.accounts, cumulative, { equityLabel: equityLabel(data.kind) }),
    incomeStatement: incomeStatement(data.accounts, inPeriod),
    scheduleOfInvestments: {
      ...scheduleOfInvestments(data.accounts, cumulative, nav, positions, data.companies as SoiCompany[]),
      realizedRows,
      ...(data.chainWarning ? { chainWarning: data.chainWarning } : {}),
      ...(data.levelWarning ? { levelWarning: data.levelWarning } : {}),
    },
    changesInPartnersCapital: changesInPartnersCapital(capitalAccounts, data.names, gpEnding),
    // Absent for a fund holding no funds, so a non-FoF package is unchanged.
    ...(data.fofRaw ? { fof: fofExhibits(data.fofRaw, period.end) } : {}),
    cashFlows: data.cashAccount
      ? statementOfCashFlows(
          data.cashAccount.id, inPeriodSourced, data.accounts,
          openingCashBalance(data.cashAccount.id, data.sourcedPostings, period.start),
        )
      : null,
  }
}

/**
 * Build the whole statement package for a vehicle. `sp` is the request's search
 * params; the period is resolved the same way for every caller:
 *   ?preset=this_quarter|last_quarter|ytd|prior_year|itd   — or —
 *   ?start=YYYY-MM-DD&end=YYYY-MM-DD   (?asOf= is a synonym for a cumulative end)
 */
export async function buildStatementPackage(
  admin: SupabaseClient,
  fundId: string,
  group: string,
  sp: URLSearchParams,
): Promise<StatementPackage> {
  const data = await loadLedgerData(admin, fundId, group, { basis: basisFromParam(sp.get('basis')) })
  return buildStatementPackageFromData(data, sp)
}

/**
 * The same, over ledger data already in hand — for a caller that needs the package AND the raw
 * ledger (the tax package builds the general ledger from the same load) without a second trip.
 */
export function buildStatementPackageFromData(data: LedgerData, sp: URLSearchParams): StatementPackage {
  const preset = sp.get('preset') as PeriodPreset | null
  const asOf = sp.get('asOf')
  const asOfDate = asOf && /^\d{4}-\d{2}-\d{2}$/.test(asOf) ? new Date(asOf) : undefined
  const period = preset && preset !== 'custom'
    ? resolvePeriod(preset, asOfDate)
    : customPeriod(sp.get('start'), sp.get('end') ?? asOf)

  const payload = computePayload(data, period)
  const inPeriodSourced = postingsInPeriod(data.sourcedPostings, period.start, period.end)

  const compareParam = sp.get('compare')
  let comparisons: StatementPayload[] | undefined
  if (compareParam) {
    const count = compareParam === 'all' ? Infinity : Math.max(0, parseInt(compareParam, 10) || 0)
    comparisons = comparisonPeriods(period, count, data.earliest).map(p => computePayload(data, p))
  }

  return { payload, accounts: data.accounts, inPeriodSourced, allSourced: data.sourcedPostings, comparisons, basis: basisFromParam(sp.get('basis')) }
}

/**
 * The fund-of-funds exhibits for one reporting window. Computed from the ALREADY-LOADED raw
 * register, so a package with comparison periods still costs one round trip.
 *
 * Cash is deliberately 0 here: the coverage ratio belongs to the live report, where the cash
 * balance is loaded alongside. A statement package is a point-in-time document and the
 * schedule it carries is the commitment table, not the liquidity dashboard.
 */
function fofExhibits(raw: FofRawData, asOf: string | null) {
  const { positions } = computeFofFromRaw(raw, asOf ?? new Date().toISOString().slice(0, 10))
  return {
    commitments: commitmentSchedule(positions, 0),
    performance: performanceTable(positions),
    valuationNote: valuationBasisNote(positions),
  }
}
