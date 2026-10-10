// Financial statements derived from the ledger. Everything here is a query over
// the trial balance — no separately maintained figures. Kept pure so it can be
// unit-tested and reused by the API and PDF/report layers.

import type { Account, AccountType, Posting } from './types'
import { NORMAL_SIDE } from './types'
import type { CapitalAccount } from './capital-account'
import { ACTIVITY_FIELDS, emptyAccount } from './capital-account'
import { apportionCents } from './allocation'
import type { CompanyStatus } from '@/lib/types/database'
import type { ChainBalance } from './soi'

function r(n: number): number {
  return Math.round((n + Number.EPSILON) * 100) / 100
}

export interface TrialBalanceRow {
  accountId: string
  code: string
  name: string
  type: AccountType
  /** Positive on the account's normal side. */
  balance: number
  debit: number
  credit: number
}

export interface TrialBalance {
  rows: TrialBalanceRow[]
  totalDebits: number
  totalCredits: number
  balanced: boolean
}

/**
 * Trial balance across a set of postings. Debit-side sum per account is split
 * into a positive debit or credit column; a well-formed ledger has equal totals.
 */
export function trialBalance(accounts: Account[], postings: Posting[]): TrialBalance {
  const byAccount = new Map<string, number>()
  for (const p of postings) {
    byAccount.set(p.accountId, r((byAccount.get(p.accountId) ?? 0) + p.amount))
  }

  const rows: TrialBalanceRow[] = []
  let totalDebits = 0
  let totalCredits = 0

  for (const acct of accounts) {
    const debitSide = r(byAccount.get(acct.id) ?? 0)
    if (debitSide === 0) continue
    const debit = debitSide > 0 ? debitSide : 0
    const credit = debitSide < 0 ? -debitSide : 0
    const balance = NORMAL_SIDE[acct.type] === 'debit' ? debitSide : r(-debitSide)
    totalDebits = r(totalDebits + debit)
    totalCredits = r(totalCredits + credit)
    rows.push({ accountId: acct.id, code: acct.code, name: acct.name, type: acct.type, balance, debit, credit })
  }

  rows.sort((a, b) => a.code.localeCompare(b.code))
  return { rows, totalDebits, totalCredits, balanced: r(totalDebits - totalCredits) === 0 }
}

export interface StatementSection {
  label: string
  rows: { code: string; name: string; amount: number }[]
  total: number
}

function section(label: string, tb: TrialBalance, type: AccountType): StatementSection {
  const rows = tb.rows.filter(r0 => r0.type === type).map(r0 => ({ code: r0.code, name: r0.name, amount: r0.balance }))
  const total = r(rows.reduce((a, b) => a + b.amount, 0))
  return { label, rows, total }
}

/**
 * Postings within a window. A missing `entryDate` is treated as in-scope rather
 * than dropped — losing a posting would silently unbalance a statement, which is
 * far worse than including one whose date we don't know.
 */
export function postingsInPeriod<T extends Posting>(postings: T[], start?: string | null, end?: string | null): T[] {
  return postings.filter(p => {
    const d = p.entryDate
    if (!d) return true
    if (start && d < start) return false
    if (end && d > end) return false
    return true
  })
}

/** Postings cumulative up to and including a date — the basis for a balance sheet. */
export function postingsAsOf<T extends Posting>(postings: T[], end?: string | null): T[] {
  return postingsInPeriod(postings, null, end)
}

export interface BalanceSheet {
  assets: StatementSection
  liabilities: StatementSection
  equity: StatementSection
  /** assets − liabilities − equity; zero when the ledger balances. */
  check: number
  partnersCapital: {
    /** Net assets — the single partners'-capital line. */
    total: number
    /**
     * Cumulative net income that has NOT yet been allocated to partners' capital
     * accounts — i.e. periods that haven't been closed. Zero on fully-closed books.
     * Non-zero means fund-level statements are right but PER-LP numbers understate.
     */
    unallocatedEarnings: number
  }
}

/**
 * Balance sheet as of a date: assets = liabilities + partners' capital.
 *
 * Pass CUMULATIVE postings (everything up to the date) — a balance sheet is a
 * point-in-time statement, unlike the income statement and cash flows.
 *
 * Partners' capital is a SINGLE total, not a line per partner: the statement of
 * changes in partners' capital is where the per-partner detail belongs. That total
 * is net assets, so it includes cumulative net income that hasn't been closed into
 * the capital accounts yet — otherwise the balance sheet simply would not balance,
 * and `check` would silently carry the unclosed P&L.
 */
export function balanceSheet(
  accounts: Account[],
  postings: Posting[],
  /** The equity label — partners' capital for a fund, members' or owner's for the kinds without
   *  partners (lib/accounting/vocab.ts). Defaults to the fund's, so every caller is unchanged. */
  opts: { equityLabel?: string } = {},
): BalanceSheet {
  const tb = trialBalance(accounts, postings)
  const assets = section('Assets', tb, 'asset')
  const liabilities = section('Liabilities', tb, 'liability')
  const label = opts.equityLabel ?? "Partners' capital"

  const capitalAccounts = section(label, tb, 'equity')
  const income = section('Income', tb, 'income')
  const expenses = section('Expenses', tb, 'expense')
  const netIncome = r(income.total - expenses.total)

  // Net income already pushed into capital accounts by a period close sits as a
  // DEBIT in the undistributed-earnings bridge, cancelling the double-count. What's
  // left is what no close has allocated yet.
  const bridge = accounts.find(a => a.subtype === 'undistributed_earnings')
  const bridgeRow = bridge ? tb.rows.find(row => row.accountId === bridge.id) : undefined
  const allocated = bridgeRow ? r(-bridgeRow.balance) : 0 // equity normal is credit; a debit balance is allocation
  const unallocatedEarnings = r(netIncome - allocated)

  // One line, no per-partner detail: that belongs in the statement of changes.
  const total = r(capitalAccounts.total + netIncome)
  const equity: StatementSection = {
    label,
    rows: [],
    total,
  }

  return {
    assets,
    liabilities,
    equity,
    check: r(assets.total - liabilities.total - total),
    partnersCapital: { total, unallocatedEarnings },
  }
}

export interface IncomeStatement {
  income: StatementSection
  expenses: StatementSection
  netIncome: number
}

/**
 * Income statement FOR A PERIOD: net income = income − expenses.
 *
 * Pass postings scoped to the window (`postingsInPeriod`). Handing it cumulative
 * postings yields an inception-to-date figure, which is what this used to do.
 */
export function incomeStatement(accounts: Account[], postings: Posting[]): IncomeStatement {
  const tb = trialBalance(accounts, postings)
  const income = section('Income', tb, 'income')
  const expenses = section('Expenses', tb, 'expense')
  return { income, expenses, netIncome: r(income.total - expenses.total) }
}

// ---------------------------------------------------------------------------
// Schedule of investments
// ---------------------------------------------------------------------------

export interface SoiRow {
  name: string
  cost: number
  fairValue: number
  /** Fair value as a fraction of net assets (0..1). */
  pctOfNetAssets: number
  // Present only when the row came from the portfolio tracker (source: 'tracker').
  companyId?: string
  /** Sections the schedule so a fund holding or a token is not reported in a company table
   *  with half its columns blank. */
  holdingType?: 'company' | 'fund' | 'crypto'
  industry?: string | null
  country?: string | null
  stage?: string | null
  /** So an inception-to-date consumer can label an exited row; a proceeds-only bar is
   *  otherwise unreadable. Absent on ledger-sourced rows, which know no company status. */
  status?: CompanyStatus
  assetType?: string
  /** Digital assets only: what the entity's watched wallets say beside the recorded units. */
  chain?: ChainBalance | null
  shares?: number | null
  sharePrice?: number | null
  unrealized?: number
  moic?: number | null
  /** ASC 820 fair value hierarchy. Undecorated rows read as Level 3. */
  valuationLevel?: 1 | 2 | 3
  // Per-company value breakdown from the tracker (source: 'tracker' rows only).
  /** Gross capital deployed, before exits. */
  invested?: number
  /** Realized proceeds returned to the fund. */
  distributions?: number
  /** distributions + fairValue (residual). */
  totalValue?: number
  /**
   * What the LEDGER carries for this company, from its own 1100-<id> / 1200-<id>
   * accounts. Present only once per-investment accounts exist. Without them the
   * tie-out is total-only, and two offsetting per-company errors cancel out.
   */
  ledgerCost?: number
  ledgerFairValue?: number
  tiesOut?: boolean
  /**
   * UNDERLYING-FUND FIGURES, on fund rows only (`holdingType === 'fund'`).
   *
   * A commitment to a fund is an obligation the schedule has to state: a position carried at 4m
   * with 6m still callable is a different liquidity picture from one carried at 4m and fully
   * drawn, and cost alone cannot tell them apart. These come from the fund-of-funds register
   * (lib/portfolio/fof-metrics.ts) — the same computation the quarterly marks and the pre-close
   * check use — so the schedule and the close cannot disagree about what is unfunded.
   */
  commitment?: number
  /** Drawn by the manager to date. */
  called?: number
  /** Still callable. Net of recallable distributions, which is why it is not commitment − called. */
  unfunded?: number
  /** Fraction of the commitment drawn (0..1); null when there is no commitment to divide by. */
  pctCalled?: number | null
  /** The manager statement this position is carried on, and how stale it was at the report date. */
  navAsOf?: string | null
  stalenessDays?: number | null
}
/** A subtotal band — ASC 946 wants fair value grouped by industry and asset type. */
export interface SoiGroup {
  name: string
  cost: number
  fairValue: number
  pctOfNetAssets: number
}
export interface ScheduleOfInvestments {
  rows: SoiRow[]
  /**
   * Fully-realized companies — invested capital and proceeds, no remaining position.
   *
   * NOT part of the schedule: excluded from `rows`, from every subtotal, and from the ledger
   * tie-out, because ASC 946 reports holdings. Present so an inception-to-date consumer (the
   * fund detail page's Largest holdings chart) can show what the fund actually did. Populated
   * by computePayload, which is the only caller that knows which positions were realized;
   * `scheduleOfInvestments()` itself always returns it empty.
   */
  realizedRows: SoiRow[]
  /** Set when the digital assets' on-chain balances could not be read. */
  chainWarning?: string
  /** Set when the price feeds or quotes could not be read, so the levels are not real ones. */
  levelWarning?: string
  totalCost: number
  totalFairValue: number
  netAssets: number
  /** 'tracker' = per-company rows; 'ledger' = the single aggregate fallback. */
  source: 'tracker' | 'ledger'
  /** Control totals from the ledger — the rows must tie to these. */
  ledgerCost: number
  ledgerFairValue: number
  /** rows − ledger. Non-zero means the tracker and the books disagree. */
  costVariance: number
  fairValueVariance: number
  byIndustry: SoiGroup[]
  byGeography: SoiGroup[]
  byAssetType: SoiGroup[]
  /** ASC 820 leveling. EMPTY for a wholly private book, where every position is Level 3 and
   *  the breakout would restate the total on a single line. */
  byLevel: SoiGroup[]
}

function groupBy(rows: SoiRow[], key: (row: SoiRow) => string, netAssets: number): SoiGroup[] {
  const m = new Map<string, { cost: number; fairValue: number }>()
  for (const row of rows) {
    const k = key(row)
    const g = m.get(k) ?? { cost: 0, fairValue: 0 }
    m.set(k, { cost: g.cost + row.cost, fairValue: g.fairValue + row.fairValue })
  }
  return Array.from(m.entries())
    .map(([name, g]) => ({
      name,
      cost: r(g.cost),
      fairValue: r(g.fairValue),
      pctOfNetAssets: netAssets ? r(g.fairValue / netAssets) : 0,
    }))
    .sort((a, b) => b.fairValue - a.fairValue)
}

/**
 * Schedule of investments.
 *
 * Rows come from the portfolio tracker (`positions`) — the ledger only knows
 * totals, so it can't name a company or a share count. The ledger still supplies
 * the CONTROL TOTALS (investment-cost accounts; fair value = cost + unrealized),
 * and the variance between the two is reported rather than hidden: a non-zero
 * variance means a mark was booked in one system and not the other.
 *
 * With no positions supplied, it degrades to the old single aggregate line, which
 * is still correct for a vehicle whose holdings aren't tracked per-company.
 */
/** Fair value ties to the dollar, not the cent: see the per-company tie-out below. */
export const FAIR_VALUE_TOLERANCE = 1

export function scheduleOfInvestments(
  accounts: Account[],
  postings: Posting[],
  netAssets: number,
  // pctOfNetAssets is derived here, so callers don't supply it.
  positions: Omit<SoiRow, 'pctOfNetAssets'>[] = [],
  /**
   * Names for companies the LEDGER carries but the portfolio tracker does not — so a holding
   * imported from a general ledger appears by name instead of vanishing into the control total.
   * Without it those positions cannot be named and are left out, which is the old behaviour.
   */
  companies: { id: string; name: string; holding_type?: 'company' | 'fund' | 'crypto' | null }[] = [],
): ScheduleOfInvestments {
  const tb = trialBalance(accounts, postings)
  // ASSET accounts only. `unrealized` is also the subtype of the INCOME account
  // (4200 Change in unrealized appreciation), and summing both double-counts every
  // mark — the carrying value is the asset, not the P&L that produced it.
  const balOf = (subtype: string) => r(
    tb.rows
      .filter(row => {
        const a = accounts.find(x => x.id === row.accountId)
        return a?.type === 'asset' && a.subtype === subtype
      })
      .reduce((s, row) => s + row.balance, 0)
  )
  const ledgerCost = balOf('investment')
  // A position's carrying value is cost + the mark + the rate move. Leaving FX out here
  // would make every non-USD position look like it fails its tie-out.
  const ledgerFairValue = r(ledgerCost + balOf('unrealized') + balOf('fx_translation'))

  // Per-company ledger balances, from the 1100-<id> / 1200-<id> / 1250-<id> accounts.
  // This is what makes the tie-out meaningful per position: with a single aggregate
  // account, one company overstated and another understated by the same amount still
  // "ties".
  const byCompany = new Map<string, { cost: number; unrealized: number; fx: number }>()
  for (const row of tb.rows) {
    const a = accounts.find(x => x.id === row.accountId)
    if (!a?.companyId || a.type !== 'asset') continue
    const cur = byCompany.get(a.companyId) ?? { cost: 0, unrealized: 0, fx: 0 }
    if (a.subtype === 'investment') cur.cost = r(cur.cost + row.balance)
    if (a.subtype === 'unrealized') cur.unrealized = r(cur.unrealized + row.balance)
    if (a.subtype === 'fx_translation') cur.fx = r(cur.fx + row.balance)
    byCompany.set(a.companyId, cur)
  }
  const hasPerCompany = byCompany.size > 0

  const fromTracker = positions.length > 0
  const trackerRows: SoiRow[] = !fromTracker ? [] : positions.map(p => {
      const l = p.companyId ? byCompany.get(p.companyId) : undefined
      const lc = l ? l.cost : undefined
      const lfv = l ? r(l.cost + l.unrealized + l.fx) : undefined
      return {
        ...p,
        pctOfNetAssets: netAssets ? r(p.fairValue / netAssets) : 0,
        ledgerCost: lc,
        ledgerFairValue: lfv,
        // Only claim a tie-out where the ledger actually holds this company separately.
        tiesOut: hasPerCompany && lc !== undefined && lfv !== undefined
          // Cost to the cent; fair value to the dollar — it is shares × price, and a price quoted to
          // four places over a million shares lands cents away from the dollars the books hold.
          ? Math.abs(p.cost - lc) < 0.005 && Math.abs(p.fairValue - lfv) < FAIR_VALUE_TOLERANCE
          : undefined,
      }
  })

  // LEDGER-ONLY POSITIONS. A general-ledger import creates a company's own 1100-<id>/1200-<id>
  // accounts and posts cost and marks to them, but writes no investment transaction — so until
  // someone records and confirms a notice, the tracker has nothing and the position used to
  // disappear from the schedule into the control total, showing up only as a tie-out variance.
  //
  // DUPLICATE CHECK: keyed on company id, and a company the tracker already reports is skipped
  // entirely. The tracker is authoritative where it has an opinion; this fills the gaps, so no
  // position is counted twice and the totals still tie to the ledger.
  const trackerCompanies = new Set(positions.map(p => p.companyId).filter((id): id is string => !!id))
  const companyById = new Map(companies.map(c => [c.id, c]))
  const ledgerRows: SoiRow[] = Array.from(byCompany.entries())
    .filter(([companyId]) => !trackerCompanies.has(companyId) && companyById.has(companyId))
    .map(([companyId, l]) => {
      const company = companyById.get(companyId)!
      const fairValue = r(l.cost + l.unrealized + l.fx)
      return {
        name: company.name,
        companyId,
        ...(company.holding_type ? { holdingType: company.holding_type } : {}),
        cost: l.cost,
        fairValue,
        pctOfNetAssets: netAssets ? r(fairValue / netAssets) : 0,
        // It IS the ledger, so it ties by construction. Stated rather than left undefined, so the
        // page does not flag a row that cannot disagree with itself.
        ledgerCost: l.cost,
        ledgerFairValue: fairValue,
        tiesOut: true,
      }
    })
    // A fully written-off or never-funded account is not a position worth a line.
    .filter(row => Math.abs(row.cost) >= 0.005 || Math.abs(row.fairValue) >= 0.005)

  const rows: SoiRow[] = trackerRows.length > 0 || ledgerRows.length > 0
    ? [...trackerRows, ...ledgerRows]
    // Neither source names anything: fall back to the single aggregate line, as before, so a book
    // with only aggregate investment accounts is unchanged.
    : ledgerFairValue === 0 && ledgerCost === 0 ? [] : [{
      name: 'Portfolio investments',
      cost: ledgerCost,
      fairValue: ledgerFairValue,
      pctOfNetAssets: netAssets ? r(ledgerFairValue / netAssets) : 0,
    }]

  const totalCost = r(rows.reduce((s, x) => s + x.cost, 0))
  const totalFairValue = r(rows.reduce((s, x) => s + x.fairValue, 0))

  return {
    rows,
    // Always empty here. The partition needs to know which positions were realized, which only
    // computePayload does — it builds them with `includeRealized` and splits before calling in.
    realizedRows: [],
    totalCost,
    totalFairValue,
    netAssets: r(netAssets),
    source: fromTracker ? 'tracker' : 'ledger',
    ledgerCost,
    ledgerFairValue,
    costVariance: r(totalCost - ledgerCost),
    fairValueVariance: r(totalFairValue - ledgerFairValue),
    byIndustry: fromTracker ? groupBy(rows, x => x.industry || 'Unclassified', netAssets) : [],
    byGeography: fromTracker ? groupBy(rows, x => x.country || 'Unclassified', netAssets) : [],
    byAssetType: fromTracker ? groupBy(rows, x => x.assetType || 'Unclassified', netAssets) : [],
    // ASC 820 leveling. Emitted ONLY when something is above Level 3: a wholly private book is
    // entirely Level 3 by construction, and a table restating the total on one line tells the
    // reader nothing. The disclosure earns its place the moment one position is quoted, because
    // then the reader cannot otherwise tell which is which.
    byLevel: fromTracker && rows.some(x => (x.valuationLevel ?? 3) !== 3)
      ? groupBy(rows, x => `Level ${x.valuationLevel ?? 3}`, netAssets)
      : [],
  }
}

// ---------------------------------------------------------------------------
// Statement of changes in partners' capital
// ---------------------------------------------------------------------------

export interface PartnerCapitalRow extends CapitalAccount {
  id: string
  name: string
}
export interface ChangesInPartnersCapital {
  partners: PartnerCapitalRow[]
  totals: CapitalAccount
}

const CAP_FIELDS: (keyof CapitalAccount)[] = ['beginning', ...ACTIVITY_FIELDS, 'ending']

/**
 * Statement of changes in partners' capital: each LP's roll-forward plus a GP
 * row, with a totals column. `gpEnding` is the GP capital balance (carry + GP
 * commitment); the GP's activity isn't tracked per-source, so it carries on the
 * carried-interest line — which is what a GP capital balance overwhelmingly is.
 */
export function changesInPartnersCapital(
  capitalAccounts: Map<string, CapitalAccount>,
  names: Map<string, string>,
  gpEnding = 0
): ChangesInPartnersCapital {
  const partners: PartnerCapitalRow[] = Array.from(capitalAccounts.entries())
    .map(([id, acct]) => ({ id, name: names.get(id) ?? id, ...acct }))
    .sort((a, b) => a.name.localeCompare(b.name))

  if (gpEnding !== 0) {
    partners.push({
      id: 'gp',
      name: 'General Partner',
      ...emptyAccount(),
      carriedInterest: r(gpEnding),
      ending: r(gpEnding),
    })
  }

  const totals = CAP_FIELDS.reduce((acc, f) => { acc[f] = r(partners.reduce((s, p) => s + (p[f] as number), 0)); return acc }, {} as CapitalAccount)
  return { partners, totals }
}

// ---------------------------------------------------------------------------
// Statement of cash flows
// ---------------------------------------------------------------------------

export interface CashPosting {
  /** The journal entry this posting belongs to — used to find a cash movement's counter-legs. */
  entryId: string
  accountId: string
  amount: number
  sourceType: string | null
  entryDate?: string | null
  memo?: string | null
}
/** Coded and named like every other statement line — `1000 · Cash`. */
export interface CashFlowLine { code: string; name: string; amount: number }
export interface CashFlowSection { label: string; lines: CashFlowLine[]; total: number }
/** A disclosable non-cash investing/financing transaction (ASC 230-10-50-3). */
export interface NonCashItem {
  entryId: string
  date: string | null
  description: string
  amount: number
  legs: { name: string; amount: number }[]
}
export interface StatementOfCashFlows {
  operating: CashFlowSection
  financing: CashFlowSection
  netChange: number
  openingCash: number
  endingCash: number
  /**
   * Supplemental non-cash investing and financing activities. Without this, a fund
   * whose lender paid the portfolio company directly shows a loan being repaid that
   * was never drawn, and an investment that was never bought — because neither leg
   * ever touched the bank account.
   */
  nonCash: NonCashItem[]
}

// Contributions and distributions are financing; everything else that moves cash
// (fees, expenses, realized proceeds, investment purchases) is operating —
// investment-company style, where investment activity runs through operating.
/**
 * Financing activity is defined by the COUNTER-ACCOUNT a cash movement hits —
 * partners' capital, the capital-call receivable, or borrowings. Everything else
 * that moves cash (fees, expenses, interest, investment purchases, realizations) is
 * operating, investment-company style.
 */
const FINANCING_SUBTYPES = new Set([
  'lp_capital', 'gp_capital', 'members_capital',
  'receivable',                    // 1300 Due from LPs — funding a capital call
  'loan_payable', 'note_payable',  // borrowings: draws and principal repayments
])

function isFinancing(account: Account): boolean {
  return !!account.subtype && FINANCING_SUBTYPES.has(account.subtype)
}

/**
 * How an account presents on the cash-flow statement.
 *
 * Per-LP capital accounts (`3100-<lpEntityId>`) collapse into the single parent
 * `3100 Partners' capital` line — a cash-flow statement reports "capital
 * contributions", not nineteen separate contribution lines. The per-partner detail
 * is the statement of changes in partners' capital.
 */
function cashFlowLineFor(account: Account): { code: string; name: string } {
  if (account.lpEntityId) {
    return { code: account.code.split('-')[0], name: "Partners' capital" }
  }
  return { code: account.code, name: account.name }
}

/**
 * Accounts whose movement makes a non-cash entry DISCLOSABLE — i.e. it was an
 * investing or financing transaction that simply bypassed the bank account.
 * A revaluation (unrealized ↔ income) is non-cash but is neither, so it is not
 * disclosed here; nor are period-close allocations, which are equity reclasses and
 * are filtered out via the bridge account below.
 */
const NONCASH_DISCLOSABLE_SUBTYPES = new Set([
  'investment',
  'loan_payable', 'note_payable',
  'lp_capital', 'gp_capital', 'members_capital',
  'receivable',
  'investment_in_fund', 'due_to_fund', 'due_to_gp',
])

/**
 * Statement of cash flows FOR A PERIOD.
 *
 * Classified by what the cash was paid FOR — the counter-accounts of each entry —
 * NOT by the entry's source_type. That distinction is load-bearing: a single wire
 * that repays loan principal AND accrued interest is one entry with one source_type,
 * but the principal is financing and the interest is operating. Splitting the cash
 * movement across its counter-legs pro-rata is the only way to report both correctly.
 *
 * Pass postings scoped to the window and the cash balance carried in at the start
 * (`openingCashBalance`).
 */
export function statementOfCashFlows(
  cashAccountId: string,
  postings: CashPosting[],
  accounts: Account[],
  openingCash = 0
): StatementOfCashFlows {
  const acctById = new Map(accounts.map(a => [a.id, a]))
  const byEntry = new Map<string, CashPosting[]>()
  for (const p of postings) {
    if (!byEntry.has(p.entryId)) byEntry.set(p.entryId, [])
    byEntry.get(p.entryId)!.push(p)
  }

  // Presentation line ("code|name") → net cash attributed to it, plus its metadata.
  const byCounterAccount = new Map<string, number>()
  const lineMeta = new Map<string, { code: string; name: string; financing: boolean }>()
  const nonCash: NonCashItem[] = []

  for (const legs of Array.from(byEntry.values())) {
    const cashAmount = r(legs.filter(l => l.accountId === cashAccountId).reduce((s, l) => s + l.amount, 0))

    if (cashAmount === 0) {
      // No cash moved. If it was nonetheless an investing/financing transaction —
      // an investment bought with borrowed money, a loan repaid by a partner
      // directly — ASC 230 requires it be disclosed, not silently omitted.
      const isAllocation = legs.some(l => acctById.get(l.accountId)?.subtype === 'undistributed_earnings')
      const disclosable = !isAllocation && legs.some(l => {
        const st = acctById.get(l.accountId)?.subtype
        return !!st && NONCASH_DISCLOSABLE_SUBTYPES.has(st)
      })
      if (disclosable) {
        const first = legs[0]
        nonCash.push({
          entryId: first.entryId,
          date: first.entryDate ?? null,
          description: first.memo ?? first.sourceType ?? 'Non-cash transaction',
          // Gross size of the entry = the debit side.
          amount: r(legs.filter(l => l.amount > 0).reduce((s, l) => s + l.amount, 0)),
          legs: legs
            .filter(l => l.amount !== 0)
            .map(l => ({ name: acctById.get(l.accountId)?.name ?? l.accountId, amount: r(l.amount) })),
        })
      }
      continue
    }

    const counter = legs.filter(l => l.accountId !== cashAccountId && l.amount !== 0)
    if (counter.length === 0) continue

    // Split the cash movement across its counter-legs in proportion to their size, so
    // a mixed principal-plus-interest payment lands partly in financing and partly in
    // operating. apportionCents keeps the split exact to the cent.
    const shares = apportionCents(
      Math.round(cashAmount * 100),
      counter.map(l => Math.abs(l.amount))
    )
    counter.forEach((leg, i) => {
      const amount = shares[i] / 100
      const a = acctById.get(leg.accountId)
      // Key by the PRESENTATION line, so nineteen per-LP capital accounts collapse
      // into one "3100 Partners' capital".
      const line = a ? cashFlowLineFor(a) : { code: leg.accountId.slice(0, 8), name: 'Unclassified' }
      const key = `${line.code}|${line.name}`
      lineMeta.set(key, { ...line, financing: a ? isFinancing(a) : false })
      byCounterAccount.set(key, r((byCounterAccount.get(key) ?? 0) + amount))
    })
  }

  const build = (label: string, keys: string[]): CashFlowSection => {
    const lines: CashFlowLine[] = keys
      .filter(k => (byCounterAccount.get(k) ?? 0) !== 0)
      .map(k => ({
        code: lineMeta.get(k)!.code,
        name: lineMeta.get(k)!.name,
        amount: byCounterAccount.get(k)!,
      }))
      .sort((x, y) => x.code.localeCompare(y.code))
    return { label, lines, total: r(lines.reduce((s, l) => s + l.amount, 0)) }
  }

  const keys = Array.from(byCounterAccount.keys())
  const financingIds = keys.filter(k => lineMeta.get(k)?.financing)
  const operatingIds = keys.filter(k => !lineMeta.get(k)?.financing)

  const financing = build('Financing activities', financingIds)
  const operating = build('Operating activities', operatingIds)
  const netChange = r(operating.total + financing.total)
  nonCash.sort((a, b) => (a.date ?? '').localeCompare(b.date ?? ''))
  return {
    operating,
    financing,
    netChange,
    openingCash: r(openingCash),
    endingCash: r(openingCash + netChange),
    nonCash,
  }
}

/** The cash balance carried into a period — every cash posting strictly before `start`. */
export function openingCashBalance(
  cashAccountId: string,
  postings: { accountId: string; amount: number; entryDate?: string | null }[],
  start?: string | null
): number {
  if (!start) return 0
  return r(postings
    .filter(p => p.accountId === cashAccountId && p.entryDate && p.entryDate < start)
    .reduce((s, p) => s + p.amount, 0))
}
