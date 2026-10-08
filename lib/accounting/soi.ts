// Schedule-of-investments positions, derived from the portfolio tracker rather
// than the ledger. The ledger knows only totals (one investment-cost account, one
// unrealized account); the tracker knows the per-company detail an ASC 946 SOI
// needs — shares, price, industry. So the SOI reads the tracker for its ROWS and
// the ledger for its CONTROL TOTALS, and reports the variance between them.
//
// Valuation math is NOT reimplemented here: computeSummary() in lib/investments.ts
// is the canonical roll-up (priced equity → shares × latest price; SAFEs/notes →
// cost + cumulative value change). There are already several drifted copies of it
// in the codebase; this is deliberately not another one.

import { computeSummary } from '@/lib/investments'
import { classifyNewFollowOn } from './fund-timeseries'
import { observedByHolding, BALANCE_TOLERANCE, type Wallet, type WalletBalance } from '@/lib/portfolio/wallets'
import type { FairValueLevel } from '@/lib/portfolio/quotes'
import type { InvestmentTransaction, CompanyStatus } from '@/lib/types/database'

const r = (n: number) => Math.round(n * 100) / 100

/**
 * The instruments `investment_transactions.security_type` may hold, and what to call them.
 *
 * THESE KEYS ARE THE DATABASE'S CHECK CONSTRAINT (migration 20260712000000). Anything else is
 * rejected on insert, so every surface that WRITES the column must offer exactly these — which is
 * why this is exported rather than private to the Schedule of Investments. The investment form
 * used to take free text under the placeholder "Preferred, Convertible note, SAFE…", none of which
 * are valid values; typing what it suggested failed the constraint every time.
 *
 * Add an instrument here and you must add it to the constraint in a migration too.
 */
export const SECURITY_LABELS: Record<string, string> = {
  preferred: 'Preferred stock',
  common: 'Common stock',
  safe: 'SAFE',
  convertible_note: 'Convertible note',
  warrant: 'Warrant',
  option: 'Option',
  llc_units: 'LLC units',
  listed_equity: 'Listed equity',
  digital_asset: 'Digital asset',
  other: 'Other',
}

/** The keys above, for callers that need to validate rather than label. */
export const SECURITY_TYPES = Object.keys(SECURITY_LABELS)

export function isSecurityType(value: string): boolean {
  return Object.prototype.hasOwnProperty.call(SECURITY_LABELS, value)
}

/**
 * Spellings that aren't the key or the label but mean one unambiguously.
 *
 * Deliberately short. A term that could mean two instruments ("equity", "shares", "stock") is NOT
 * here: guessing wrong writes a plausible instrument onto a real position and the SOI's asset-type
 * breakout then reports it with a straight face. Unmappable is a better answer than mismapped.
 */
const SECURITY_ALIASES: Record<string, string> = {
  note: 'convertible_note',
  notes: 'convertible_note',
  convertible: 'convertible_note',
  conv_note: 'convertible_note',
  pref: 'preferred',
  preferred_equity: 'preferred',
  preferred_shares: 'preferred',
  common_equity: 'common',
  common_shares: 'common',
  ordinary: 'common',
  ordinary_shares: 'common',
  warrants: 'warrant',
  options: 'option',
  units: 'llc_units',
  membership_units: 'llc_units',
  llc_interests: 'llc_units',
  simple_agreement_for_future_equity: 'safe',
  // Quoted instruments. "Stock" and "equity" stay unmapped above because they cannot
  // distinguish common from preferred; these spellings are unambiguous about the MARKET the
  // instrument trades in, which is the distinction that matters for the leveling breakout.
  listed: 'listed_equity',
  public_equity: 'listed_equity',
  listed_shares: 'listed_equity',
  publicly_traded: 'listed_equity',
  crypto: 'digital_asset',
  cryptocurrency: 'digital_asset',
  token: 'digital_asset',
  digital_assets: 'digital_asset',
}

/**
 * Best-effort read of an instrument written by a human or an LLM, into the DB's CHECK values.
 *
 * Returns null when it can't tell — including for empty input. Callers decide what null means:
 * a rejection for an API caller, a dropped field plus a warning for an import (the instrument is
 * a label on the SOI, not the money, so losing it must never cost you the transaction).
 *
 * `security_type` is CHECK-constrained, so an unmapped value isn't a cosmetic problem — it fails
 * the insert. The form used to take free text under the placeholder "Preferred, Convertible note,
 * SAFE…", none of which are valid values; every one of them 500ed.
 */
export function normalizeSecurityType(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const key = value.trim().toLowerCase().replace(/[\s-]+/g, '_')
  if (!key) return null
  if (isSecurityType(key)) return key
  if (SECURITY_ALIASES[key]) return SECURITY_ALIASES[key]
  const byLabel = Object.entries(SECURITY_LABELS)
    .find(([, label]) => label.toLowerCase().replace(/[\s-]+/g, '_') === key)
  return byLabel?.[0] ?? null
}

export interface SoiPosition {
  companyId: string
  name: string
  /**
   * What kind of thing this holding is, so the view can section the schedule rather than render
   * one mixed table. 'fund' has no shares or stage at all; 'crypto' has a quantity and a price
   * but no industry, stage or country, and reporting a token under "Direct investments" with
   * three blank columns states something false about it.
   */
  holdingType: 'company' | 'fund' | 'crypto'
  industry: string | null
  /** ASC 946 geography band. Null until companies.country is populated. */
  country: string | null
  stage: string | null
  status: CompanyStatus
  /** From investment_transactions.security_type when set; otherwise derived. */
  assetType: string
  shares: number | null
  sharePrice: number | null
  /** Remaining cost basis (cost less any basis exited). */
  cost: number
  fairValue: number
  /** Gross capital deployed into the company, before exits (computeSummary.totalInvested).
   *  Excludes income received in kind, which is basis but not a contribution. */
  invested: number
  /** The portion of `invested` that was this company's FIRST check. new + followOn === invested. */
  investedNew: number
  /** Every later check into the same company. */
  investedFollowOn: number
  /** Income the position produced since inception — cash and in kind. */
  income: number
  /** Realized proceeds returned to the fund (computeSummary.totalRealized). */
  distributions: number
  /** Total value = distributions + fairValue (residual). The TVPI numerator per holding. */
  totalValue: number
  unrealized: number
  moic: number | null
  /**
   * ASC 820 fair value hierarchy. Absent here and stamped on afterwards by
   * `withFairValueLevels`, because leveling depends on a PRICE FEED and a date, neither of
   * which the tracker knows about — buildSoiPositions stays a pure function of transactions.
   * Undecorated positions read as Level 3, which is what every private holding is.
   */
  valuationLevel?: FairValueLevel
}

export interface SoiCompany {
  id: string
  name: string
  /** Added by the fund-of-funds migration; defaults to 'company' for every existing row.
   *  'crypto' added by 20260822000000. */
  holding_type?: 'company' | 'fund' | 'crypto' | null
  status: CompanyStatus
  industry: string[] | null
  stage: string | null
  /** Added by migration 20260712000000; undefined until it's pushed. */
  country?: string | null
  /** text[] — a company can be held by several vehicles. */
  portfolio_group: string[] | null
}

/**
 * The instrument held. Prefers the recorded `security_type`; falls back to the
 * derived two-bucket proxy so the SOI still groups sensibly on rows that predate
 * the column (or where it was never set).
 */
function assetTypeOf(txns: InvestmentTransaction[], hasShares: boolean, hasPrice: boolean): string {
  const recorded = txns
    .filter(t => t.transaction_type === 'investment')
    .map(t => (t as any).security_type as string | null | undefined)
    .find(Boolean)
  if (recorded) return SECURITY_LABELS[recorded] ?? recorded
  return hasShares && hasPrice ? 'Priced equity' : 'Convertible / SAFE'
}

/**
 * Transactions relevant to one company in one vehicle.
 *
 * `investment_transactions.portfolio_group` is a SCALAR text column (only
 * `companies.portfolio_group` is text[]), so it must be compared with `===`.
 * Using `.includes()` here would be a substring test — a vehicle named "<X> SPV II"
 * contains "<X> SPV" — which is exactly the bug that was in lib/lp-letters/aggregate.ts.
 *
 * Untagged `round_info` / `unrealized_gain_change` rows are company-wide pricing
 * signals (a later round the fund didn't participate in), so they count for every
 * vehicle holding that company — without them the position marks at entry price.
 *
 * A `split` is company-wide by NATURE, not just by convention: the issuer splits its
 * stock and every holder's share count changes, so an untagged split must reach every
 * vehicle. Left out, a vehicle keeps pre-split shares while its price goes post-split
 * and the position silently halves.
 */
export function txnsForVehicle(txns: InvestmentTransaction[], vehicle: string): InvestmentTransaction[] {
  const inVehicle = txns.filter(t => t.portfolio_group === vehicle)
  const priceSignals = txns.filter(t =>
    !t.portfolio_group &&
    (t.transaction_type === 'unrealized_gain_change' ||
     t.transaction_type === 'round_info' ||
     t.transaction_type === 'split')
  )
  return [...inVehicle, ...priceSignals]
}

/**
 * One SOI position per company the vehicle holds.
 *
 * Companies with no remaining basis and no value (fully exited / written off) are DROPPED by
 * default, because an ASC 946 schedule reports HOLDINGS and an exited company is not one — it
 * would appear as an all-zeros row at 0% of net assets.
 *
 * `includeRealized` keeps them, for callers reporting inception-to-date rather than a position
 * at a date: the fund detail page's Largest holdings chart ranks on invested capital and
 * proceeds, where an exited company is exactly the row you most want to see. Such a caller must
 * NOT feed the result to `scheduleOfInvestments()` as its `positions` — see statement-package.ts,
 * which partitions before it does.
 */
export function buildSoiPositions(
  txns: InvestmentTransaction[],
  companies: SoiCompany[],
  vehicle: string,
  asOf?: Date,
  opts?: { includeRealized?: boolean },
): SoiPosition[] {
  const byCompany = new Map<string, InvestmentTransaction[]>()
  for (const t of txns) {
    if (!byCompany.has(t.company_id)) byCompany.set(t.company_id, [])
    byCompany.get(t.company_id)!.push(t)
  }

  const positions: SoiPosition[] = []
  for (const company of companies) {
    const all = byCompany.get(company.id) ?? []
    const relevant = txnsForVehicle(all, vehicle)
    // A company-wide price signal alone isn't a holding — require real investment.
    if (!relevant.some(t => t.transaction_type === 'investment' && t.portfolio_group === vehicle)) continue

    const s = computeSummary(relevant, company.status, asOf)

    // New vs follow-on, on the SAME rule the fund-timeseries chart uses — the earliest-dated
    // investment is new capital, every later one is follow-on.
    //
    // The per-row cost must be defined exactly as computeSummary defines totalInvested —
    // investment_cost + fee_amount, plus interest_converted on a conversion row — or the split
    // will not tie to `invested` and the stacked bars will not sum to their own total.
    const investRows = relevant
      .filter(t => t.transaction_type === 'investment')
      .map(t => ({
        date: t.transaction_date,
        cost: (t.investment_cost ?? 0)
          + Number((t as { fee_amount?: number | null }).fee_amount ?? 0)
          + ((t as { converts_from_txn_id?: string | null }).converts_from_txn_id ? (t.interest_converted ?? 0) : 0),
      }))
    const classified = classifyNewFollowOn(investRows)
    const investedNew = r(classified.filter(t => t.isNew).reduce((sum, t) => sum + t.cost, 0))
    const investedFollowOn = r(classified.filter(t => !t.isNew).reduce((sum, t) => sum + t.cost, 0))
    const exited = s.rounds.reduce((sum, rd) => sum + Math.abs(rd.costBasisExited ?? 0), 0)
    // Income basis counts as COST even though it is not invested capital. A staking reward or an
    // airdrop is recognised at fair value on receipt, and that value is the units' basis — leave
    // it out and the schedule understates cost, while selling those units later reports the whole
    // proceeds as gain on top of the income already recognised.
    const cost = r(s.totalInvested + s.totalIncomeBasis - exited)
    // unrealizedValue, not fmv: fmv reports PROCEEDS for an exited company, which is
    // not a carrying value and would misstate the balance sheet.
    const fairValue = r(s.unrealizedValue)
    // Fully realized: no remaining basis, no carrying value. Kept only for an ITD caller, and
    // only when there is something to report — invested capital or proceeds. A company with
    // neither was never really held.
    if (cost === 0 && fairValue === 0) {
      const worthKeeping = opts?.includeRealized && (s.totalInvested !== 0 || s.totalRealized !== 0)
      if (!worthKeeping) continue
    }

    const shares = s.totalShares || null
    positions.push({
      companyId: company.id,
      name: company.name,
      holdingType: company.holding_type === 'fund' || company.holding_type === 'crypto'
        ? company.holding_type
        : 'company',
      industry: company.industry?.[0] ?? null,
      country: company.country ?? null,
      stage: company.stage ?? null,
      status: company.status,
      assetType: assetTypeOf(relevant, !!shares, !!s.latestSharePrice),
      shares,
      sharePrice: s.latestSharePrice,
      cost,
      fairValue,
      invested: r(s.totalInvested),
      investedNew,
      investedFollowOn,
      income: r(s.totalIncome),
      distributions: r(s.totalRealized),
      totalValue: r(s.totalRealized + s.unrealizedValue),
      unrealized: r(fairValue - cost),
      moic: s.moic,
    })
  }

  return positions.sort((a, b) => b.fairValue - a.fairValue)
}

/**
 * Attach each underlying fund's register figures to its schedule-of-investments row.
 *
 * WHY HERE AND NOT A SECOND REPORT. A fund-of-funds schedule has to state commitment, called and
 * unfunded — a position carried at fair value with capital still callable is a different liquidity
 * fact from a fully-drawn one. That used to live in a separate fund-of-funds report which loaded
 * the register FIRM-WIDE, so one vehicle's page listed every other vehicle's holdings. The
 * schedule of investments is already scoped to the vehicle whose activity bought the position, so
 * decorating its rows is both the simpler surface and the correct scope.
 *
 * Pure. Rows with no matching register entry are returned untouched, so a direct company holding
 * and a fund holding recorded before the register existed both pass through unchanged.
 */
export interface FundHoldingFigures {
  commitment: number
  /** Drawn by the manager to date. */
  called: number
  /** Still callable. The register's own figure, NOT commitment − called: a recallable
   *  distribution puts capital back on the hook, so subtracting would understate it. */
  unfunded: number
  pctCalled: number | null
  navAsOf: string | null
  stalenessDays: number | null
}

export function withFundHoldingFigures<T extends { companyId?: string; holdingType?: 'company' | 'fund' | 'crypto' }>(
  rows: T[],
  fundPositions: (Omit<FundHoldingFigures, 'called'> & { companyId: string; contributed: number })[],
): (T & Partial<FundHoldingFigures>)[] {
  if (fundPositions.length === 0) return rows
  const byCompany = new Map(fundPositions.map(p => [p.companyId, p]))
  return rows.map(row => {
    if (row.holdingType !== 'fund' || !row.companyId) return row
    const position = byCompany.get(row.companyId)
    if (!position) return row
    return {
      ...row,
      commitment: position.commitment,
      called: position.contributed,
      unfunded: position.unfunded,
      pctCalled: position.pctCalled,
      navAsOf: position.navAsOf,
      stalenessDays: position.stalenessDays,
    }
  })
}

/** What the watched wallets say beside a digital asset's recorded units. */
export interface ChainBalance {
  /** Summed latest readings of the entity's wallets on or before the date. */
  observedUnits: number
  /** observed - recorded. Positive: the chain holds more than the books know about. */
  delta: number
  /** Within BALANCE_TOLERANCE of the recorded units, the test the close applies. */
  agrees: boolean
  /** The oldest reading contributing to observedUnits. */
  asOf: string
}

/**
 * Decorate digital-asset rows with the chain's answer (lib/portfolio/wallets.ts). Pure. `wallets`
 * must already be the schedule's entity's (walletsForEntity), so one entity's schedule never
 * reports another's addresses. A row with no wallet read by the date gets `chain: null`; other
 * kinds pass through untouched.
 */
export function withChainBalances<T extends { companyId?: string; holdingType?: 'company' | 'fund' | 'crypto'; shares?: number | null }>(
  rows: T[],
  wallets: Wallet[],
  balances: WalletBalance[],
  asOf: string,
): (T & { chain?: ChainBalance | null })[] {
  const observed = observedByHolding(wallets, balances, asOf)
  return rows.map(row => {
    if (row.holdingType !== 'crypto' || !row.companyId) return row
    const o = observed.get(row.companyId)
    if (!o || o.oldestAsOf === null) return { ...row, chain: null }
    const recorded = row.shares ?? 0
    const delta = o.observedUnits - recorded
    const fraction = recorded === 0 ? (delta === 0 ? 0 : 1) : Math.abs(delta) / Math.abs(recorded)
    return { ...row, chain: { observedUnits: o.observedUnits, delta, agrees: fraction <= BALANCE_TOLERANCE, asOf: o.oldestAsOf } }
  })
}
