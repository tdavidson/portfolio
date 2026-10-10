// Book-to-tax differences: what the tax book has to say that the actual book does not.
//
// These books are ASC 946 — fair value, with carried interest accrued at each close on a
// hypothetical liquidation. Schedule K-1 reports TAX-basis capital. The two differ by
// construction, and this module names the differences, derives the ones that can be derived,
// and refuses to invent the ones that cannot.
//
// THE POSTURE, borrowed deliberately from lib/portfolio/lots.ts: this PROPOSES. It does not
// write, and it does not overwrite a figure a human recorded. A fund may have a reason this
// cannot infer — a late §754 election, a partner-level basis adjustment, a cost the preparer
// reclassified — and silently restating tax capital because a rule said so would be a worse bug
// than the one it fixes. Proposals go into the tax book as adjusting entries a person accepts.
//
// WHAT IS DERIVABLE, AND WHAT IS NOT.
//
//   Derivable, because the ledger already isolates it:
//     * unrealized appreciation — its own accounts (1200 asset, 4200 income)
//     * unrealized currency translation — its own accounts (1250 asset, 4300 income). Whatever
//       character a position's currency gain has when it is realized (§988 ordinary, or part of a
//       capital gain), nothing is recognised while it is unrealized, so the reversal is the same.
//     * carried interest accrued on unrealized gains — its own source_type
//     * organizational costs — its own account (5200), with §709 mechanics below
//     * syndication costs — its own account (5250), permanently non-deductible
//
//   NOT derivable, and deliberately absent rather than approximated:
//     * §704(b) capital, which is a third basis again and governs ALLOCATIONS rather than
//       reporting. Where a fund's allocations follow §704(b) rather than its GAAP capital, the
//       difference is a judgment call for the preparer.
//     * §751 hot assets, §754 / §743(b) basis step-ups on a transfer, wash sales, straddles,
//       §1256 mark-to-market, state modifications. Each needs facts this app does not hold.
//     * the CHARACTER of realized foreign currency gain under §988. The unrealized part reverses
//       (above); whether a realized one is ordinary or capital is not something a subtype can
//       answer.
//
// Everything in the second list is why the tax book takes hand-authored entries at all.

import { roundCents } from './ledger'
import { bucketForSourceType, computeCapitalAccounts, type CapitalPosting } from './capital-account'
import { carryAccrual, carryTarget, type DatedContribution, type LpEconomics, type VehicleCarryTerms } from './carry'

export type TaxDifferenceKind =
  | 'unrealized'
  | 'fx_translation'
  | 'carry_on_unrealized'
  | 'organizational_709'
  | 'syndication'

/** Timing differences reverse; permanent ones never do. The distinction drives the disclosure. */
export const DIFFERENCE_IS_PERMANENT: Record<TaxDifferenceKind, boolean> = {
  unrealized: false,
  fx_translation: false,
  carry_on_unrealized: false,
  organizational_709: false,
  syndication: true,
}

export const DIFFERENCE_LABEL: Record<TaxDifferenceKind, string> = {
  unrealized: 'Unrealized appreciation not recognised for tax',
  fx_translation: 'Unrealized currency translation not recognised for tax',
  carry_on_unrealized: 'Carried interest accrued on unrealized gains',
  organizational_709: 'Organizational costs capitalised under §709',
  syndication: 'Syndication costs — permanently non-deductible',
}

// ---------------------------------------------------------------------------
// §709 organizational costs
// ---------------------------------------------------------------------------

/** Months over which the balance amortizes once the immediate deduction is taken. */
export const ORG_AMORTIZATION_MONTHS = 180

/** The immediate deduction, before phase-out. */
export const ORG_IMMEDIATE_DEDUCTION = 5_000

/** Phase-out threshold: the immediate deduction is reduced dollar-for-dollar above this. */
export const ORG_PHASEOUT_THRESHOLD = 50_000

/**
 * The first-year deduction under §709(b): $5,000, reduced dollar-for-dollar by the amount by
 * which total organizational costs exceed $50,000 — so it vanishes entirely at $55,000.
 */
export function orgImmediateDeduction(totalOrgCosts: number): number {
  if (totalOrgCosts <= 0) return 0
  const excess = Math.max(0, totalOrgCosts - ORG_PHASEOUT_THRESHOLD)
  return roundCents(Math.max(0, Math.min(ORG_IMMEDIATE_DEDUCTION, totalOrgCosts) - excess))
}

export interface OrgAmortizationYear {
  /** Months of amortization falling in this tax year. */
  months: number
  /** The §709(b) immediate deduction, which only ever lands in the first year. */
  immediate: number
  /** Straight-line amortization of the remainder over 180 months. */
  amortization: number
  /** immediate + amortization — what tax deducts this year. */
  deductible: number
  /** What book expensed. Supplied by the caller; the difference is the adjustment. */
  bookExpense: number
  /** bookExpense − deductible. Positive means book deducted more than tax allows. */
  adjustment: number
}

/**
 * One tax year of §709 treatment.
 *
 * `monthsInYear` is how many months of the amortization period fall in this tax year — 12 in a
 * full year, fewer in the first (from the month the fund begins business) and in the last. The
 * caller computes it, because "begins business" is a fact about the fund, not about the maths.
 */
export function orgAmortizationForYear(input: {
  totalOrgCosts: number
  monthsInYear: number
  /** Months already amortized in prior years — caps the final year so it cannot overrun 180. */
  monthsAlreadyAmortized?: number
  /** Whether the §709(b) immediate deduction belongs in this year (the first one). */
  isFirstYear: boolean
  bookExpense: number
}): OrgAmortizationYear {
  const total = Math.max(0, input.totalOrgCosts)
  const immediate = input.isFirstYear ? orgImmediateDeduction(total) : 0
  const amortizable = roundCents(Math.max(0, total - immediate))

  const priorMonths = Math.max(0, input.monthsAlreadyAmortized ?? 0)
  const remainingMonths = Math.max(0, ORG_AMORTIZATION_MONTHS - priorMonths)
  const months = Math.max(0, Math.min(input.monthsInYear, remainingMonths))

  const amortization = roundCents((amortizable / ORG_AMORTIZATION_MONTHS) * months)
  const deductible = roundCents(immediate + amortization)
  return {
    months,
    immediate,
    amortization,
    deductible,
    bookExpense: roundCents(input.bookExpense),
    adjustment: roundCents(input.bookExpense - deductible),
  }
}

// ---------------------------------------------------------------------------
// Proposals
// ---------------------------------------------------------------------------

export interface ProposedAdjustment {
  kind: TaxDifferenceKind
  /**
   * The amount by which BOOK income exceeds TAX income for this difference.
   *
   * Positive means book recognised something tax does not, so the tax book reverses it out.
   * Negative means the reverse. Zero-amount differences are dropped rather than proposed, so a
   * list of proposals is a list of things to actually do.
   */
  amount: number
  permanent: boolean
  label: string
  /** Why this number, in the terms a preparer would use. Rendered next to the proposal. */
  rationale: string
}

/**
 * What the actual book recorded, for one vehicle and one tax year.
 *
 * Every field is a period movement, not a balance: a tax year's adjustment is what happened IN
 * the year. Callers derive these from postings on the actual book — this module takes numbers so
 * it can stay pure and be tested against cases nobody has a database for.
 */
export interface ActualBookYear {
  /** Change in unrealized appreciation booked this year (account 4200). */
  unrealizedChange: number
  /** Currency translation booked this year (account 4300), unrealized like the marks. */
  fxChange?: number
  /** Carried interest accrued this year on UNREALIZED gains (source_type carried_interest). */
  carryAccruedOnUnrealized: number
  /** Organizational costs expensed this year (account 5200). */
  organizationalExpense: number
  /** Total organizational costs since inception — the §709 base. */
  organizationalCostsToDate: number
  /** Syndication costs expensed this year (account 5250). */
  syndicationExpense: number
  /** §709 inputs the caller resolves from the fund's own dates. */
  org: { monthsInYear: number; monthsAlreadyAmortized: number; isFirstYear: boolean }
}

export function proposeAdjustments(year: ActualBookYear): ProposedAdjustment[] {
  const out: ProposedAdjustment[] = []

  const unrealized = roundCents(year.unrealizedChange)
  if (unrealized !== 0) {
    out.push({
      kind: 'unrealized',
      amount: unrealized,
      permanent: false,
      label: DIFFERENCE_LABEL.unrealized,
      rationale:
        'Book marks positions to fair value; tax recognises nothing until realization. Reverses ' +
        'when the position is sold, at which point the realized gain is on both bases.',
    })
  }

  const fx = roundCents(year.fxChange ?? 0)
  if (fx !== 0) {
    out.push({
      kind: 'fx_translation',
      amount: fx,
      permanent: false,
      label: DIFFERENCE_LABEL.fx_translation,
      rationale:
        'Book translates foreign-currency positions at each period-end rate; tax recognises the ' +
        'currency movement only when the position is sold or settled.',
    })
  }

  // Carry accrued on unrealized gains follows the gains: no realization, no allocation. It is an
  // equity reallocation rather than an expense, so it changes each partner's capital without
  // touching income — which is exactly why it needs its own adjustment instead of falling out of
  // the unrealized one.
  const carry = roundCents(year.carryAccruedOnUnrealized)
  if (carry !== 0) {
    out.push({
      kind: 'carry_on_unrealized',
      amount: carry,
      permanent: false,
      label: DIFFERENCE_LABEL.carry_on_unrealized,
      rationale:
        'The close accrues carry as if the fund liquidated at period-end NAV. Tax allocates it ' +
        'only on realization, so the accrual is reversed between the GP and LP capital accounts.',
    })
  }

  const org = orgAmortizationForYear({
    totalOrgCosts: year.organizationalCostsToDate,
    monthsInYear: year.org.monthsInYear,
    monthsAlreadyAmortized: year.org.monthsAlreadyAmortized,
    isFirstYear: year.org.isFirstYear,
    bookExpense: year.organizationalExpense,
  })
  if (org.adjustment !== 0) {
    out.push({
      kind: 'organizational_709',
      amount: org.adjustment,
      permanent: false,
      label: DIFFERENCE_LABEL.organizational_709,
      rationale:
        `Book expensed ${org.bookExpense.toFixed(2)}; §709 allows ` +
        `${org.deductible.toFixed(2)} this year ` +
        `(${org.immediate.toFixed(2)} immediate + ${org.amortization.toFixed(2)} over ` +
        `${org.months} of ${ORG_AMORTIZATION_MONTHS} months).`,
    })
  }

  const syndication = roundCents(year.syndicationExpense)
  if (syndication !== 0) {
    out.push({
      kind: 'syndication',
      amount: syndication,
      permanent: true,
      label: DIFFERENCE_LABEL.syndication,
      rationale:
        'Costs of selling partnership interests are never deductible and never amortized ' +
        '(§709(a)). Book expenses them; tax capitalises them permanently. This difference does ' +
        'not reverse.',
    })
  }

  return out
}

/** Net book-over-tax income difference for a year — the sum a reconciliation reports. */
export function netAdjustment(proposals: ProposedAdjustment[]): number {
  return roundCents(proposals.reduce((s, p) => s + p.amount, 0))
}

/**
 * The part of the year's carry that was earned on UNREALIZED appreciation, per partner — what the
 * tax book reverses.
 *
 * The close accrues carry on the whole NAV, realized and unrealized alike; tax allocates it only on
 * what has been realized. So the carry target is measured twice, the same way both times — once on
 * each partner's NAV, once with their unrealized appreciation (and currency translation, unrealized
 * too) taken out — and the difference is the carry that exists only because of the marks. Both
 * measurements use NAV before any carry, so a fund with nothing unrealized gets exactly nothing
 * back, whatever cadence its closes accrued on. The year's figure is that difference at year end
 * less the same at the prior year end, split by `carryAccrual` the way the close splits it.
 *
 * Signed as the capital accounts hold carry: positive debits a paying partner, negative credits a
 * recipient. Realized carry is never in it, which is what keeps the GP's §1061 and box 20 figures.
 */
export function carryOnUnrealizedForYear(
  capitalPostings: CapitalPosting[],
  terms: VehicleCarryTerms,
  priorYearEnd: string,
  yearEnd: string,
): Map<string, number> {
  const out = new Map<string, number>()
  if (terms.kind === 'none' || terms.carryRate <= 0 || terms.recipients.length === 0) return out
  const recipientIds = new Set(terms.recipients.map(r => r.lpEntityId))

  const economicsAt = (asOf: string, taxBasis: boolean) => {
    const upTo = capitalPostings.filter(p => (p.entryDate ?? '') <= asOf)
    const accounts = computeCapitalAccounts(upTo)
    const lps: LpEconomics[] = Array.from(accounts.entries())
      .filter(([id]) => !recipientIds.has(id))
      .map(([lpEntityId, a]) => ({
        lpEntityId,
        contributed: roundCents(a.contributions),
        distributed: roundCents(-a.distributions),
        nav: roundCents(a.ending - a.carriedInterest - (taxBasis ? a.unrealizedGains + a.fxTranslation : 0)),
      }))
    const contributions: DatedContribution[] = upTo
      .filter(p => !recipientIds.has(p.lpEntityId) && bucketForSourceType(p.sourceType) === 'contributions')
      .map(p => ({ date: p.entryDate ?? asOf, amount: roundCents(-p.amount) }))
      .filter(c => c.amount > 0)
    return { lps, contributions, asOf }
  }
  const yearCarry = (taxBasis: boolean) => {
    const prior = economicsAt(priorYearEnd, taxBasis)
    const current = economicsAt(yearEnd, taxBasis)
    const priorTarget = prior.lps.length ? carryTarget(prior, terms) : 0
    return current.lps.length ? carryAccrual(current, terms, priorTarget).perLp : new Map<string, number>()
  }

  const book = yearCarry(false)
  const tax = yearCarry(true)
  let total = 0
  for (const lp of new Set([...book.keys(), ...tax.keys()])) {
    const amount = roundCents((book.get(lp) ?? 0) - (tax.get(lp) ?? 0))
    if (amount === 0) continue
    out.set(lp, amount)
    total = roundCents(total + amount)
  }
  // The recipients' side, split by their percent the way buildCarryEntry splits it.
  let allocated = 0
  terms.recipients.forEach((r, i) => {
    const amt = i === terms.recipients.length - 1 ? roundCents(total - allocated) : roundCents((total * r.pct) / 100)
    allocated = roundCents(allocated + amt)
    if (amt !== 0) out.set(r.lpEntityId, roundCents((out.get(r.lpEntityId) ?? 0) - amt))
  })
  return out
}
