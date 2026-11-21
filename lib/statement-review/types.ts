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
}

export type CheckId = 'foots' | 'partners_sum' | 'roll_forward' | 'continuity' | 'completeness'

export const CHECK_LABELS: Record<CheckId, string> = {
  foots: 'Foots',
  partners_sum: 'Partners sum to fund',
  roll_forward: 'Roll-forward',
  continuity: 'Continuity',
  completeness: 'Completeness',
}

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
