// Statement review: the shapes a package, a check and a finding take. See docs/spec/statement-review.md.
//
// Pure types, no imports beyond each other, so the checks, the routes, the agent tools and the
// client view all share them.

/** Where a stated figure came from, so a finding can point at it. */
export interface Citation {
  /** The document's file name, or what the figures came from ("Admin pull 2026-09-30", "CSV upload"). */
  document: string
  page?: number
  /** The row or line label as the document prints it. */
  label?: string
}

/** Income, expense and gain allocated to a capital account, each signed as it changes the account. */
export interface Allocations {
  income?: number
  /** Negative: an expense reduces the account. */
  expenses?: number
  /** Negative: the fee reduces the account. */
  managementFee?: number
  realized?: number
  unrealized?: number
  /** Negative on a limited partner charged carry, positive on the GP. */
  carry?: number
  /** The net allocation as the statement states it, where it gives one. */
  total?: number
}

export const ALLOCATION_KEYS = ['income', 'expenses', 'managementFee', 'realized', 'unrealized', 'carry'] as const
export type AllocationKey = typeof ALLOCATION_KEYS[number]

/**
 * A capital account's figures for the period. Period flows (contributions, distributions,
 * allocations) and to-date totals (paid-in, distributed) are separate fields, because packages
 * state one, the other or both.
 */
export interface CapitalFigures {
  commitment?: number
  beginning?: number
  contributions?: number
  /** Positive: a distribution reduces the account. */
  distributions?: number
  allocations?: Allocations
  ending?: number
  unfunded?: number
  /** Contributions since inception, through the period end. */
  paidInToDate?: number
  /** Distributions since inception, through the period end. */
  distributedToDate?: number
  /** Field name (`ending`, `allocations.income`) → where the package states it. */
  cite?: Record<string, Citation>
}

export const CAPITAL_FIELDS = ['commitment', 'beginning', 'contributions', 'distributions', 'ending', 'unfunded', 'paidInToDate', 'distributedToDate'] as const
export type CapitalField = typeof CAPITAL_FIELDS[number]

/** One partner's capital account as the package states it. */
export interface PartnerStatement extends CapitalFigures {
  /** The package's id for the partner (the administrator's). Falls back to the name. */
  externalId: string
  name: string
  /** The app partner this is, when the caller knows it. */
  lpEntityId?: string
}

export interface StatedLine {
  label: string
  /** Signed: an expense or a liability as the line reads, see the statement it sits in. */
  amount: number
  cite?: Citation
}

export interface FundStatements {
  /** Statement of assets, liabilities and partners' capital. Asset and liability lines positive. */
  balanceSheet?: {
    assets?: StatedLine[]
    liabilities?: StatedLine[]
    totalAssets?: number
    totalLiabilities?: number
    partnersCapital?: number
    totalLiabilitiesAndCapital?: number
    cite?: Record<string, Citation>
  }
  /** Statement of operations. Lines signed as they add to net income (expenses negative). */
  operations?: {
    lines?: StatedLine[]
    netIncome?: number
    cite?: Record<string, Citation>
  }
  /** The fund's statement of changes in partners' capital: the total across every partner. */
  partnersCapital?: CapitalFigures
  /** The total row printed under the partner schedule (the package's own sum of its partners). */
  partnerTotals?: CapitalFigures
  /** The schedule of investments' stated totals. */
  soi?: { cost?: number; fairValue?: number; cite?: Record<string, Citation> }
}

/** One line of the schedule of investments. */
export interface HoldingLine {
  name: string
  cost?: number
  fairValue?: number
  cite?: Citation
}

/** An ending cash balance by account, as the package states it. */
export interface CashLine {
  account: string
  balance: number
  cite?: Citation
}

export interface PackageDocument {
  name: string
  /** SHA-256 of the file, hex. */
  hash?: string
  kind?: string
  pages?: number
}

export type PackageSource = 'administrator' | 'books'
/** How the figures reached the review. */
export type PackageInput = 'admin_pull' | 'csv' | 'package'

/** One vehicle's statements for one period. Every part is optional: a check runs when its inputs are there. */
export interface StatementPackage {
  vehicleId: string
  periodStart: string
  periodEnd: string
  source: PackageSource
  documents: PackageDocument[]
  partners?: PartnerStatement[]
  fund?: FundStatements
  holdings?: HoldingLine[]
  cash?: CashLine[]
}

export type Severity = 'error' | 'warning' | 'info'
export type FindingStatus = 'open' | 'explained' | 'asked' | 'accepted'

export interface Finding {
  check: CheckId
  severity: Severity
  subject: { kind: 'partner' | 'holding' | 'fund' | 'account'; id?: string; label: string }
  stated?: number
  expected?: number
  difference?: number
  /** One sentence a CFO would write. */
  message: string
  cites: Citation[]
  status: FindingStatus
  note?: string
  /** Set when a known adjustment explained the finding: its severity before the adjustment. */
  adjustedFrom?: Severity
}

export type CheckId =
  | 'foots' | 'partners_sum' | 'roll_forward' | 'continuity' | 'completeness'
  | 'ledger_flows' | 'management_fee' | 'carry' | 'allocation' | 'cash' | 'soi' | 'watched_accounts'

export const CHECK_LABELS: Record<CheckId, string> = {
  foots: 'Foots',
  partners_sum: 'Partners sum to fund',
  roll_forward: 'Roll-forward',
  continuity: 'Continuity',
  completeness: 'Completeness',
  ledger_flows: 'Contributions and distributions',
  management_fee: 'Management fee',
  carry: 'Carried interest',
  allocation: 'Allocations',
  cash: 'Cash',
  soi: 'Schedule of investments',
  watched_accounts: 'Watched accounts',
}

export const CHECK_IDS = Object.keys(CHECK_LABELS) as CheckId[]

/** What one check did: ran (with how many comparisons) or could not, and why. */
export interface CheckOutcome {
  check: CheckId
  ran: boolean
  /** How many figures it compared, so "no findings" can be told apart from "nothing to check". */
  compared: number
  /** Why it could not run, or what it left out. */
  note?: string
}

/** How big a difference has to be before it is an error rather than information. */
export interface Materiality {
  /** An absolute amount in the vehicle's currency. */
  amount: number
  /** A share of fund NAV: 0.001 for 0.1%. */
  navShare: number
}

export const DEFAULT_MATERIALITY: Materiality = { amount: 0, navShare: 0 }
/** Rounding tolerance on one figure, the same as `reconcile` uses. */
export const ROUNDING_TOLERANCE = 0.01

// ---------------------------------------------------------------------------
// The app's own figures for the period (the shadow), and the vehicle's review settings
// ---------------------------------------------------------------------------

/** One partner's capital activity for the period in the app's books. */
export interface ShadowPartner {
  lpEntityId: string
  name: string
  contributions: number
  /** Positive: what was paid out. */
  distributions: number
  /** Carried interest posted to the partner in the period, signed as it changes the account. */
  carry: number
}

/** One ledger account: its balance at the period end and how much it moved in the period. */
export interface ShadowAccount {
  code: string
  name: string
  type: string
  subtype?: string | null
  /** On the account's normal side, at the period end. */
  balance: number
  /** On the account's normal side, within the period. */
  movement: number
}

export interface ShadowHolding {
  companyId: string
  name: string
  cost: number
  fairValue: number
}

/** A category the vehicle's allocation terms split, as `lib/accounting/terms.ts` names them. */
export type TermsCategory =
  | 'management_fee' | 'partnership_expense' | 'organizational_expense' | 'realized_gain'
  | 'valuation' | 'fx_revaluation' | 'income' | 'carried_interest'

/** One partner's terms for one category: left out of it, or on a negotiated weight. */
export interface ShadowPartnerTerm {
  lpEntityId: string
  category: TermsCategory
  participates: boolean
  weightOverride: number | null
  rateOverride: number | null
}

/** The vehicle's terms, as the app holds them, for the terms checks. */
export interface ShadowTerms {
  /** What income, expense and gains are split on. */
  basis: 'commitment' | 'capital_balance'
  /** Each partner's commitment in force on the period end. */
  commitments: Record<string, number>
  partnerTerms: ShadowPartnerTerm[]
  /**
   * The management fee the vehicle's fee schedule charges each partner for the fee periods that
   * start in the review period (positive). Null when the vehicle has no fee schedule.
   */
  fees: { lpEntityId: string; fee: number }[] | null
  /** Why `fees` is null, or what it left out. */
  feeNote?: string
  carry: {
    kind: string
    rate: number
    /** Who receives carry. */
    recipients: string[]
    /** Partners charged no carry: the recipients (unless the GP commit bears carry) and anyone the terms leave out. */
    carryFree: string[]
  }
}

/**
 * What the app holds for the vehicle and period, built from its own books and portfolio tracker.
 * Each part is null when the app holds nothing for it, so the check that needs it says so.
 */
export interface Shadow {
  /** Partners with capital activity in the books; null when the books hold no capital postings. */
  partners: ShadowPartner[] | null
  /** Ledger cash at the period end, and the bank feed's balance where the feed covers the date. */
  cash: { ledger: number; bank: number | null; bankThrough: string | null } | null
  holdings: ShadowHolding[] | null
  accounts: ShadowAccount[] | null
  /** The vehicle's fee, carry and allocation terms. Null when they couldn't be read. */
  terms?: ShadowTerms | null
}

/** An account the reviewer wants looked at every period. */
export interface WatchedAccount {
  /** An account code, or its name. */
  account: string
  /** What to look for, in the reviewer's words. */
  note?: string
  /** Flag the account when it moves by more than this in the period. */
  threshold?: number
}

/**
 * A difference the reviewer already knows about and expects, so a finding that matches it is
 * marked explained instead of raised again. Matches on any of check, subject and amount it names.
 */
export interface KnownAdjustment {
  description: string
  check?: CheckId
  /** Part of the finding's subject: a partner, holding or statement name. */
  subject?: string
  /** The difference it accounts for. */
  amount?: number
  /** How far from `amount` the difference may be. Default a cent. */
  tolerance?: number
}

export interface ReviewSettings {
  materiality: Materiality
  /** Free-text instructions for whoever (or whatever) reviews the package. */
  instructions: string
  watchAccounts: WatchedAccount[]
  adjustments: KnownAdjustment[]
}

export const DEFAULT_SETTINGS: ReviewSettings = { materiality: DEFAULT_MATERIALITY, instructions: '', watchAccounts: [], adjustments: [] }
