// Capital-account roll-forward — the core fund-accounting artifact.
//
// Each LP's capital account is one equity account; the roll-forward lines come
// from the source_type of the entries that touch it. LP capital is credit-normal,
// so a posting's contribution to capital is the NEGATED signed amount (a credit,
// which is negative in debit-positive convention, increases capital).
//
//   ending = beginning + contributions + distributions + managementFees + expenses
//          + operatingIncome + realizedGains + unrealizedGains + transfers
//          + carriedInterest + unclassified
//
// contributions are positive; distributions/fees/expenses/carry are negative;
// income, gains and transfers are signed. `ending` is computed as the RAW SUM of
// capital deltas, never from the buckets — so it always ties to the ledger no
// matter how lines are categorized. That invariant is what makes re-bucketing safe.
//
// PERIODS. Passing a { start, end } window turns this into a period statement:
// `beginning` becomes the capital balance carried in from before `start`, the
// activity lines cover only the window, and `ending` is the balance as of `end`.
// With no window it's the inception-to-date view, where `beginning` holds only
// explicit opening_balance entries. Both satisfy the same tie-out identity.

export type RollForwardBucket =
  | 'beginning'
  | 'contributions'
  | 'distributions'
  | 'managementFees'
  | 'expenses'
  | 'operatingIncome'
  | 'realizedGains'
  | 'unrealizedGains'
  | 'fxTranslation'
  | 'transfers'
  | 'carriedInterest'
  | 'unclassified'

/** Map a journal entry source_type to a roll-forward line. */
export function bucketForSourceType(sourceType: string | null | undefined): RollForwardBucket {
  switch (sourceType) {
    case 'opening_balance':
      return 'beginning'
    case 'capital_call':
    case 'contribution':
      return 'contributions'
    case 'distribution':
      return 'distributions'
    case 'fee':
    case 'management_fee':
      return 'managementFees'
    case 'expense':
    case 'partnership_expense':
    case 'organizational_expense':
      return 'expenses'
    case 'income':
      // Interest, dividends, and other operating income — distinct from investment
      // gains, which is why this no longer shares a line with them.
      return 'operatingIncome'
    case 'realized_gain':
    case 'gain':
      return 'realizedGains'
    case 'valuation':
    case 'unrealized':
    // The tax book's reversal of a partner's unrealized allocation: it lands on the same line, so
    // a tax-basis capital account nets its unrealized gains to nothing.
    case 'tax_adj_unrealized':
      return 'unrealizedGains'
    case 'fx_revaluation':
    // The tax book's reversal of a partner's unrealized translation, on the same line.
    case 'tax_adj_fx':
      // A currency swing is not investment performance. Its own line, so an LP can see
      // how the portfolio did apart from what the exchange rate did to it.
      return 'fxTranslation'
    case 'transfer':
      // LP-to-LP assignment/secondary: nets to zero across the fund.
      return 'transfers'
    case 'carried_interest':
    case 'carry':
    case 'tax_adj_carry':
      return 'carriedInterest'
    case 'carry_distribution':
      // Carried interest PAID out — a cash distribution of carry, kept separate from
      // return-of-capital distributions and from the accrual mark. It nets against the accrual
      // on the carriedInterest line (which then reads as carry accrued-but-unpaid), and the GP
      // panel reads it back by source_type to show carry paid on its own.
      return 'carriedInterest'
    default:
      // Catch-all for `manual` and any source_type we don't recognize. It should be
      // zero on clean books, and the UI only shows the line when it isn't — but the
      // bucket must exist, or a manual posting to LP capital would vanish from the
      // roll-forward while still sitting inside `ending`.
      return 'unclassified'
  }
}

export interface CapitalPosting {
  entryId?: string
  currency?: string
  lpEntityId: string
  /** Signed, debit-positive posting amount to the LP's equity account. */
  amount: number
  sourceType?: string | null
  /** Entry date (YYYY-MM-DD). Required for period scoping; ignored without a window. */
  entryDate?: string | null
}

export interface CapitalAccount {
  beginning: number
  contributions: number
  distributions: number
  managementFees: number
  expenses: number
  operatingIncome: number
  realizedGains: number
  unrealizedGains: number
  fxTranslation: number
  transfers: number
  carriedInterest: number
  unclassified: number
  ending: number
}

/** The activity lines, in statement order. `beginning`/`ending` bracket them. */
export const ACTIVITY_FIELDS: (keyof CapitalAccount)[] = [
  'contributions',
  'distributions',
  'managementFees',
  'expenses',
  'operatingIncome',
  'realizedGains',
  'unrealizedGains',
  'fxTranslation',
  'transfers',
  'carriedInterest',
  'unclassified',
]

export const CAPITAL_ACCOUNT_LABELS: Record<keyof CapitalAccount, string> = {
  beginning: 'Beginning capital',
  contributions: 'Contributions',
  distributions: 'Distributions',
  managementFees: 'Management fees',
  expenses: 'Partnership expenses',
  operatingIncome: 'Operating income',
  realizedGains: 'Net realized gain / (loss)',
  unrealizedGains: 'Net unrealized gain / (loss)',
  fxTranslation: 'Foreign currency translation',
  transfers: 'Transfers',
  carriedInterest: 'Carried interest accrued',
  unclassified: 'Unclassified',
  ending: 'Ending capital',
}

export function emptyAccount(): CapitalAccount {
  return {
    beginning: 0,
    contributions: 0,
    distributions: 0,
    managementFees: 0,
    expenses: 0,
    operatingIncome: 0,
    realizedGains: 0,
    unrealizedGains: 0,
    fxTranslation: 0,
    transfers: 0,
    carriedInterest: 0,
    unclassified: 0,
    ending: 0,
  }
}

/** Round to cents to keep the roll-forward free of float drift. */
function r(n: number): number {
  return Math.round((n + Number.EPSILON) * 100) / 100
}

export interface CapitalPeriod {
  /** Inclusive start (YYYY-MM-DD). Activity before this rolls into `beginning`. */
  start?: string | null
  /** Inclusive end (YYYY-MM-DD). Activity after this is excluded entirely. */
  end?: string | null
}

/**
 * Build per-LP capital accounts from postings to LP equity accounts.
 *
 * With a `period`, this is a period statement: `beginning` is everything before
 * `start`, the activity lines cover `[start, end]`, and `ending` is the balance at
 * `end`. Without one, it's inception-to-date.
 *
 * `ending` is always the raw sum of capital deltas in scope — never derived from
 * the buckets — so it ties to the ledger regardless of categorization.
 */
export function computeCapitalAccounts(
  postings: CapitalPosting[],
  period?: CapitalPeriod
): Map<string, CapitalAccount> {
  const start = period?.start || null
  const end = period?.end || null

  const out = new Map<string, CapitalAccount>()
  for (const p of postings) {
    if (!p.lpEntityId) continue
    const date = p.entryDate ?? null

    // Outside the window entirely — not part of this statement.
    if (end && date && date > end) continue

    const acct = out.get(p.lpEntityId) ?? emptyAccount()
    const capitalDelta = -p.amount // credit increases capital

    // Everything before the window is carried in as opening capital, whatever its
    // source_type — that IS what "beginning capital" means on a period statement.
    const isCarriedIn = !!start && !!date && date < start
    const field: keyof CapitalAccount = isCarriedIn
      ? 'beginning'
      : bucketForSourceType(p.sourceType)

    acct[field] = r(acct[field] + capitalDelta)
    acct.ending = r(acct.ending + capitalDelta)
    out.set(p.lpEntityId, acct)
  }
  return out
}

/** Total fund NAV = sum of every LP's ending capital. */
export function totalNav(accounts: Map<string, CapitalAccount>): number {
  let sum = 0
  for (const a of Array.from(accounts.values())) sum += a.ending
  return r(sum)
}

/**
 * Does the roll-forward add up? beginning + activity must equal ending. A failure
 * means a posting was counted into `ending` but into no line — i.e. a bug here, not
 * bad data, since `unclassified` catches every unknown source_type.
 */
export function rollForwardTies(a: CapitalAccount): boolean {
  const sum = ACTIVITY_FIELDS.reduce((s, f) => s + a[f], a.beginning)
  return Math.abs(r(sum) - a.ending) < 0.005
}
