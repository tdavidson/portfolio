// Portfolio construction — how much investable capital is left, how many more deals fit, and
// what exit the portfolio needs to return the target multiple.
//
// PURE. No I/O, no Supabase, and no clock except the `today` a caller passes in. That is
// deliberate and load-bearing: the SAME function runs on the server (to seed the page) and in
// the browser (on every keystroke), so a GP twiddling a check size gets an instant answer
// instead of a round trip. It also means the arithmetic is pinned by unit tests rather than by
// a screenshot.
//
// WHAT IS DERIVED vs WHAT IS STATED. `ConstructionActuals` is what the system knows — committed
// capital from the commitment events, fees and expenses INCURRED from the ledger, capital
// deployed from the portfolio tracker. `ConstructionAssumptions` is what the GP states about the
// future. The two never mix: nothing a user types can move a derived number.
//
// NOT the ledger forecast (plans/plan-forecast.md). That compiles hypotheticals into journal
// postings so the statements forecast themselves. Construction never touches a journal — nobody
// is asking for a forecast balance sheet here — so it is deliberately built apart from it.

import type { FeeBasis } from './fees'

const r = (n: number) => Math.round(n * 100) / 100

/**
 * One deal in the FORWARD-LOOKING portfolio.
 *
 * Actuals are not stage-classified: `investment_transactions.round_name` is free text
 * ("Seed", "Pre-Seed Extension", "SAFE") and normalising it is a guess that would silently
 * mis-weight the whole return model. So a row describes one deal not yet done.
 */
export interface ConstructionStage {
  key: string
  label: string
  initialCheck: number
  initialPostMoney: number
  /** Follow-on dollars per initial dollar. 1 = reserve a second check the size of the first. */
  followOnMultiple: number
  /** Direct dollar input used by the inline table; falls back to initialCheck × multiple. */
  followOnCheck?: number
  /** Fraction of initial ownership surviving to exit. 0.3 = diluted to 30% of entry ownership. */
  dilutionFactor: number
  /** Direct exit-ownership input; falls back to initial ownership × dilution factor. */
  ownershipAtExit?: number
  /** Additional dilution from current/entry ownership to exit, expressed as a decimal. */
  additionalDilution?: number
  /** Expected company exit value. Zero means the exit has not been forecast yet. */
  expectedExitValue?: number
  /** Direct return multiple used when the fund forecasts every company by MOIC. */
  forecastMoic?: number
  /** Distinguishes an explicit 0x write-off from an unset override that uses the fund default. */
  forecastMoicOverride?: boolean
  /** How this deal's proceeds are forecast. */
  returnMethod?: ReturnForecastMethod
  // ── Timing, stated per deal. Absent = the fund-wide pacing (construction-forecast.ts). ──
  /** Years from today the initial check is written. */
  investInYears?: number | null
  /** Years from the initial check to the exit. */
  exitInYears?: number | null
  /** Years from the initial check to the follow-on. */
  followOnInYears?: number | null
  // ── How the simulation varies THIS deal. Absent = the fund-wide setting. ──
  simLossRate?: number | null
  simDispersion?: number | null
  simExitSpreadYears?: number | null
}

export type ReturnForecastMethod = 'ownership' | 'moic'

/** Forward-looking assumptions layered onto one company the fund already owns. */
export interface ConstructionPositionForecast {
  companyId: string
  /** Additional capital still expected to go into this company. */
  plannedFollowOn: number
  /** Expected fund ownership at exit, expressed as a decimal (2% = 0.02). */
  ownershipAtExit: number
  /** Additional dilution from current ownership to exit, expressed as a decimal. */
  additionalDilution?: number
  /** Expected company exit value. */
  expectedExitValue: number
  /** Direct return multiple used when the fund forecasts every company by MOIC. */
  forecastMoic?: number
  /** Distinguishes an explicit 0x write-off from an unset override that uses the fund default. */
  forecastMoicOverride?: boolean
  /** How this deal's proceeds are forecast. */
  returnMethod?: ReturnForecastMethod
  // ── Timing, stated per company. Absent = the fund-wide pacing (construction-forecast.ts). ──
  /** Years from today to the exit. */
  exitInYears?: number | null
  /** Years from today the planned follow-on is drawn. */
  followOnInYears?: number | null
  // ── How the simulation varies THIS company. Absent = the fund-wide setting. ──
  simLossRate?: number | null
  simDispersion?: number | null
  simExitSpreadYears?: number | null
}

/**
 * How the plan lands on the calendar (lib/accounting/construction-forecast.ts). Every field is
 * starts from venture-industry base rates and can be adjusted for the fund.
 */
export interface PacingAssumptions {
  /** Years from today over which the remaining planned initial checks are written. 0 = all now. */
  deploymentYears: number
  /** Years after an initial check that its follow-on reserve is drawn. */
  followOnLagYears: number
  /** Years from a planned deal's initial check to its exit. */
  holdYears: number
  /** Years from today to the exit of the companies the fund already holds. */
  existingHoldYears: number
  /** Years to project. 0 = far enough to see every planned exit. */
  horizonYears: number
  /** How unrealized value moves toward the forecast: flat at carrying value, or straight-line. */
  accretion: 'none' | 'linear'
}

export const DEFAULT_PACING: PacingAssumptions = {
  deploymentYears: 0,
  followOnLagYears: 0,
  holdYears: 6,
  existingHoldYears: 6,
  horizonYears: 0,
  accretion: 'linear',
}

/** The Monte Carlo settings (lib/accounting/construction-simulation.ts). */
export interface SimulationAssumptions {
  /** Runs per simulation. An engine setting, not a strategy one. */
  runs: number
  /** PRNG seed. The same seed and assumptions reproduce the same bands. */
  seed: number
  /** Probability a deal is written off entirely. 0–1. */
  lossRate: number
  /** Spread of surviving outcomes around the forecast: the log-normal sigma. 0 = no spread. */
  dispersion: number
  /** Each exit lands uniformly within ± this many years of its scheduled year. */
  holdSpreadYears: number
  /** Cap on any single deal's multiple of cost. 0 = no cap. */
  maxMoic: number
  /** The net multiple the fund is underwriting to, for the probability of reaching it. 0 = unset. */
  targetMultiple: number
  /** Gross deal MOIC used when a company has no explicit return forecast. */
  defaultExitMultiple: number
}

export const DEFAULT_SIMULATION: SimulationAssumptions = {
  runs: 2000,
  seed: 1,
  lossRate: 0.5,
  dispersion: 1.25,
  holdSpreadYears: 2,
  maxMoic: 50,
  targetMultiple: 3,
  defaultExitMultiple: 3,
}

export interface ConstructionAssumptions {
  feeAnnualRate: number
  feeBasis: FeeBasis
  /** Number of future years included in the management-fee and partnership-expense forecast. */
  feeTermYears: number
  /** Legacy persisted field retained for row compatibility; it no longer drives the forecast. */
  feeStartDate: string
  feeStepDownYear: number | null
  feeStepDownRate: number | null
  annualPartnershipExpense: number
  remainingOrgCosts: number
  targetPortfolioSize: number
  targetFundMultiple: number
  stages: ConstructionStage[]
  positionForecasts: ConstructionPositionForecast[]
  /** When the plan happens. Layered on the model by construction-forecast.ts; the model ignores it. */
  pacing: PacingAssumptions
  /** How the outcomes are spread. Used by construction-simulation.ts; the model ignores it. */
  simulation: SimulationAssumptions
}

/** One existing portfolio company, derived from the tracker and never accepted from the client. */
export interface ConstructionPositionActual {
  companyId: string
  name: string
  stage: string | null
  status: string
  investedInitial: number
  investedFollowOn: number
  investedTotal: number
  /** Earliest dated investment transaction for this company, when the tracker has one. */
  firstInvestmentDate?: string | null
  /** Residual fair value plus any realized proceeds. */
  currentValue: number
  currentMoic: number | null
  /** Most recently recorded ownership, expressed as a decimal. */
  currentOwnership: number | null
  currentPostMoney: number | null
  distributions: number
}

export interface ConstructionActuals {
  /** From the commitment events or lp_positions — does NOT require fund accounting. */
  committedCapital: number
  /**
   * The share of commitments that pays management fees (0–1). The GP entity's own stake pays no
   * fee, so a fund whose GP commits 1% charges fees on 99% of its commitments. Omitted = all.
   */
  feePayingShare?: number
  /** From capital accounts. Optional for backwards-compatible pure-model callers. */
  calledCapital?: number
  /** Complete resolved capital figures, independent of whether journal entries exist. */
  capitalAvailable?: boolean
  /** From capital accounts. Optional for backwards-compatible pure-model callers. */
  uncalledCapital?: number
  /** Capital returned to partners to date. */
  distributedCapital?: number
  /** LP-only baseline and the vehicle waterfall used to present net forecast returns. */
  waterfall?: ConstructionWaterfallProjection
  /**
   * Ledger-only, all three. On an LP-tracking vehicle they come back as 0, which would overstate
   * investable capital — so `ledgerAvailable` says so, and the model warns rather than implying
   * the fund has spent nothing.
   */
  managementFeesIncurred: number
  orgCostsIncurred: number
  partnershipExpensesIncurred: number
  ledgerAvailable: boolean
  /** From the portfolio tracker, split by lib/accounting/soi.ts. */
  deployedInitial: number
  deployedFollowOn: number
  companyCount: number
  currentValue: number
  nav: number
  /** Posted ledger cash available to fund future investments and expenses. */
  cashBalance?: number
  /** Optional for backwards-compatible callers; the API always supplies it. */
  positions?: ConstructionPositionActual[]
}

export interface ConstructionWaterfallProjection {
  asOf: string
  kind: 'none' | 'straight' | 'american' | 'european'
  carryRate: number
  prefRate: number
  catchupRate: number
  prefCompounds: boolean
  lpCommitmentShare: number
  lpCalledCapital: number
  lpDistributedCapital: number
  fundDistributedCapital: number
  lpNav: number
  contributions: { date: string; amount: number }[]
  distributions?: { date: string; amount: number }[]
  /**
   * Carry the GP has already been paid, worked out from the LPs' distributions because the books
   * record none (see construction-service.ts). Present only when inferred; it is already inside
   * fundDistributedCapital − lpDistributedCapital.
   */
  carryPaidInferred?: number
}

/**
 * FUND-SPECIFIC PLANS START BLANK; RETURN FORECASTS START WITH INDUSTRY BASELINES.
 *
 * Every field describing what THIS fund intends — the planned deals, how many companies it is
 * building toward, its portfolio target, and its fee terms — starts empty. The first
 * version of this shipped a pre-seed/seed/post-seed mix at $500k checks into $7M post-money and
 * a 20-company target, which were one firm's parameters lifted from the workbook this model
 * replaces. Presented as a default they read as neutral, and a fund with a different strategy
 * would have had to notice the numbers were wrong before they could correct them. A blank field
 * asks a question; a wrong default answers one nobody asked.
 *
 * Pacing and outcome-shape fields are different: they need usable initial values to produce a
 * forecast, so those begin with documented venture-industry baselines and remain editable where
 * the choice is legible to a fund manager.
 */
export const DEFAULT_ASSUMPTIONS: ConstructionAssumptions = {
  feeAnnualRate: 0,
  feeBasis: 'committed',
  feeTermYears: 0,
  feeStartDate: '',
  feeStepDownYear: null,
  feeStepDownRate: null,
  annualPartnershipExpense: 0,
  remainingOrgCosts: 0,
  targetPortfolioSize: 0,
  targetFundMultiple: 0,
  stages: [],
  positionForecasts: [],
  pacing: DEFAULT_PACING,
  simulation: DEFAULT_SIMULATION,
}

/** A new, empty deal row for the page's "Add forecast row" control. Named, and nothing else. */
export function blankStage(label = ''): ConstructionStage {
  return {
    key: `stage_${Math.random().toString(36).slice(2, 8)}`,
    label,
    initialCheck: 0,
    initialPostMoney: 0,
    followOnMultiple: 0,
    followOnCheck: 0,
    dilutionFactor: 0,
    ownershipAtExit: 0,
    additionalDilution: 0,
    expectedExitValue: 0,
    forecastMoic: 0,
    returnMethod: 'moic',
  }
}

const FEE_BASES: FeeBasis[] = ['committed', 'invested', 'nav']

const num = (v: unknown, fallback: number): number =>
  typeof v === 'number' && Number.isFinite(v) ? v : fallback

const nullableNum = (v: unknown): number | null =>
  typeof v === 'number' && Number.isFinite(v) ? v : null

/** An optional per-deal number: absent or malformed reads as "not stated", never as zero. */
const optionalNonNeg = (v: unknown, max = Infinity): number | undefined =>
  typeof v === 'number' && Number.isFinite(v) ? Math.min(max, Math.max(0, v)) : undefined
const dealOverrides = (o: Record<string, unknown>) => ({
  simLossRate: optionalNonNeg(o.simLossRate, 0.99),
  simDispersion: optionalNonNeg(o.simDispersion),
  simExitSpreadYears: optionalNonNeg(o.simExitSpreadYears, 50),
})

/**
 * Read a stored row (or nothing) into a complete, valid assumptions object.
 *
 * There is no zod in this repo, so this is THE validation boundary: everything reaching
 * `constructionModel` has been through here. Structurally malformed rows are dropped, while a
 * valid but incomplete row is retained so a newly added forecast survives autosave. The model
 * explicitly treats a zero post-money as zero ownership rather than dividing by zero.
 */
export function parseAssumptions(raw: unknown, _vintageYear: number | null): ConstructionAssumptions {
  const o = (raw ?? {}) as Record<string, unknown>
  const basis = FEE_BASES.includes(o.feeBasis as FeeBasis) ? (o.feeBasis as FeeBasis) : 'committed'

  const rawStages = Array.isArray(o.stages) ? o.stages : null
  const stages: ConstructionStage[] = rawStages
    ? rawStages
        .map(s => s as Record<string, unknown>)
        .filter(s =>
          typeof s?.key === 'string' &&
          typeof s?.label === 'string' &&
          Number.isFinite(s?.initialCheck) &&
          Number.isFinite(s?.initialPostMoney) &&
          Number.isFinite(s?.followOnMultiple) &&
          Number.isFinite(s?.dilutionFactor))
        // Older versions stored one aggregate row with an editable deal count. Expand it at
        // the validation boundary so each saved deal keeps its economics while the current
        // model can consistently treat one entered row as one company.
        .flatMap(s => {
          const legacyCount = Number.isFinite(s.deals)
            ? Math.max(1, Math.floor(s.deals as number))
            : 1
          return Array.from({ length: legacyCount }, (_, i) => ({
            key: i === 0 ? s.key as string : `${s.key}__${i + 1}`,
            label: s.label as string,
            initialCheck: s.initialCheck as number,
            initialPostMoney: s.initialPostMoney as number,
            followOnMultiple: s.followOnMultiple as number,
            followOnCheck: Number.isFinite(s.followOnCheck) ? Math.max(0, s.followOnCheck as number) : undefined,
            dilutionFactor: s.dilutionFactor as number,
            ownershipAtExit: Number.isFinite(s.ownershipAtExit) ? Math.max(0, s.ownershipAtExit as number) : undefined,
            additionalDilution: Number.isFinite(s.additionalDilution)
              ? Math.min(1, Math.max(0, s.additionalDilution as number))
              : undefined,
            expectedExitValue: num(s.expectedExitValue, 0),
            forecastMoic: Math.max(0, num(s.forecastMoic, 0)),
            forecastMoicOverride: s.forecastMoicOverride === true,
            returnMethod: s.returnMethod === 'moic' ? 'moic' : 'ownership',
            investInYears: optionalNonNeg(s.investInYears, 50),
            exitInYears: optionalNonNeg(s.exitInYears, 50),
            followOnInYears: optionalNonNeg(s.followOnInYears, 50),
            ...dealOverrides(s),
          }))
        })
    : []

  const rawPositionForecasts = Array.isArray(o.positionForecasts) ? o.positionForecasts : []
  const positionForecasts: ConstructionPositionForecast[] = rawPositionForecasts
    .map(f => f as Record<string, unknown>)
    .filter(f => typeof f.companyId === 'string' && f.companyId.length > 0)
    .map(f => ({
      companyId: f.companyId as string,
      plannedFollowOn: Math.max(0, num(f.plannedFollowOn, 0)),
      ownershipAtExit: Math.max(0, num(f.ownershipAtExit, 0)),
      additionalDilution: Number.isFinite(f.additionalDilution)
        ? Math.min(1, Math.max(0, f.additionalDilution as number))
        : undefined,
      expectedExitValue: Math.max(0, num(f.expectedExitValue, 0)),
      forecastMoic: Math.max(0, num(f.forecastMoic, 0)),
      forecastMoicOverride: f.forecastMoicOverride === true,
      returnMethod: f.returnMethod === 'moic' ? 'moic' : 'ownership',
      exitInYears: optionalNonNeg(f.exitInYears, 50),
      followOnInYears: optionalNonNeg(f.followOnInYears, 50),
      ...dealOverrides(f),
    }))

  const p = (o.pacing ?? {}) as Record<string, unknown>
  const pacing: PacingAssumptions = {
    deploymentYears: Math.max(0, num(p.deploymentYears, DEFAULT_PACING.deploymentYears)),
    followOnLagYears: Math.max(0, num(p.followOnLagYears, DEFAULT_PACING.followOnLagYears)),
    holdYears: Math.max(0, num(p.holdYears, DEFAULT_PACING.holdYears)),
    existingHoldYears: Math.max(0, num(p.existingHoldYears, DEFAULT_PACING.existingHoldYears)),
    horizonYears: Math.max(0, num(p.horizonYears, DEFAULT_PACING.horizonYears)),
    accretion: p.accretion === 'none' ? 'none' : 'linear',
  }
  const m = (o.simulation ?? {}) as Record<string, unknown>
  const simulation: SimulationAssumptions = {
    runs: Math.max(1, Math.min(20_000, Math.floor(num(m.runs, DEFAULT_SIMULATION.runs)))),
    seed: Math.max(0, Math.floor(num(m.seed, DEFAULT_SIMULATION.seed))),
    lossRate: Math.min(0.99, Math.max(0, num(m.lossRate, DEFAULT_SIMULATION.lossRate))),
    dispersion: Math.max(0, num(m.dispersion, DEFAULT_SIMULATION.dispersion)),
    holdSpreadYears: Math.max(0, num(m.holdSpreadYears, DEFAULT_SIMULATION.holdSpreadYears)),
    maxMoic: Math.max(0, num(m.maxMoic, DEFAULT_SIMULATION.maxMoic)),
    targetMultiple: Math.max(0, num(m.targetMultiple, DEFAULT_SIMULATION.targetMultiple)),
    defaultExitMultiple: Math.max(0, num(m.defaultExitMultiple, DEFAULT_SIMULATION.defaultExitMultiple)),
  }

  return {
    feeAnnualRate: num(o.feeAnnualRate, DEFAULT_ASSUMPTIONS.feeAnnualRate),
    feeBasis: basis,
    feeTermYears: num(o.feeTermYears, DEFAULT_ASSUMPTIONS.feeTermYears),
    // Retain old persisted dates for storage compatibility. Forecasting is driven directly by
    // feeTermYears, which is the user-entered number of future years to model.
    feeStartDate: typeof o.feeStartDate === 'string' && o.feeStartDate
      ? o.feeStartDate
      : '',
    feeStepDownYear: nullableNum(o.feeStepDownYear),
    feeStepDownRate: nullableNum(o.feeStepDownRate),
    annualPartnershipExpense: num(o.annualPartnershipExpense, 0),
    remainingOrgCosts: num(o.remainingOrgCosts, 0),
    targetPortfolioSize: num(o.targetPortfolioSize, DEFAULT_ASSUMPTIONS.targetPortfolioSize),
    targetFundMultiple: num(o.targetFundMultiple, DEFAULT_ASSUMPTIONS.targetFundMultiple),
    stages,
    positionForecasts,
    pacing,
    simulation,
  }
}

/**
 * Management fees not yet incurred, over the user-entered forward forecast term.
 *
 * Reuses lib/accounting/fees.ts's semantics — fee = basis × rate × periodFraction — but at the
 * FUND level rather than per LP. This is a planning number over a ten-year horizon, and per-LP
 * side letters and exemptions net out well inside its error bars; modelling them here would add
 * a second, drifting copy of the fee engine for no gain in the answer.
 *
 * Each remaining year is charged at its OWN rate, so a step-down lands on the right years rather
 * than being averaged across the whole remaining term.
 *
 * Returns 0 when no forecast years remain.
 */
export function projectRemainingFees(
  a: ConstructionAssumptions,
  committedCapital: number,
  deployedTotal: number,
  nav: number,
  _today: Date = new Date(),
): number {
  return projectFeesFromFundYear(a, committedCapital, deployedTotal, nav, 0)
}

/**
 * The fee charged in ONE forward year (1-based) of the term — what the pacing schedule books in
 * each year. Sums to `projectRemainingFees` over the term, step-down included.
 */
export function projectFeesForYear(
  a: ConstructionAssumptions,
  committedCapital: number,
  deployedTotal: number,
  nav: number,
  year: number,
): number {
  if (year < 1 || year > Math.ceil(a.feeTermYears)) return 0
  return r(
    projectFeesFromFundYear(a, committedCapital, deployedTotal, nav, year - 1)
    - projectFeesFromFundYear(a, committedCapital, deployedTotal, nav, Math.min(year, a.feeTermYears)),
  )
}

/** Project fees from a stated fund year through the end of the term. */
function projectFeesFromFundYear(
  a: ConstructionAssumptions,
  committedCapital: number,
  deployedTotal: number,
  nav: number,
  fromFundYear: number,
): number {
  if (a.feeTermYears - fromFundYear <= 0) return 0

  const basisAmount =
    a.feeBasis === 'invested' ? deployedTotal :
    a.feeBasis === 'nav' ? nav :
    committedCapital

  // Walk the remaining term year by year. `yr` is the fund year (1-based) the slice sits in; a
  // partial first or last slice charges pro-rata.
  let fees = 0
  let cursor = fromFundYear
  while (cursor < a.feeTermYears) {
    const yr = Math.floor(cursor) + 1
    const sliceEnd = Math.min(Math.floor(cursor) + 1, a.feeTermYears)
    const rate = a.feeStepDownYear != null && a.feeStepDownRate != null && yr >= a.feeStepDownYear
      ? a.feeStepDownRate
      : a.feeAnnualRate
    fees += basisAmount * rate * (sliceEnd - cursor)
    cursor = sliceEnd
  }
  return r(fees)
}

export interface CapitalBlock {
  committedCapital: number
  /** Share of commitments charged management fees (the GP's own stake is exempt). */
  feePayingShare?: number
  calledCapital: number
  uncalledCapital: number
  feesIncurred: number
  feesProjected: number
  lifetimeFees: number
  orgCostsIncurred: number
  orgCostsProjected: number
  expensesIncurred: number
  expensesProjected: number
  lifetimeExpenses: number
  incurredExpenses: number
  projectedExpenses: number
  totalExpenses: number
  investable: number
  /** Whether the incurred figures came from a ledger at all. */
  ledgerAvailable: boolean

  deployedInitial: number
  deployedFollowOn: number
  deployedTotal: number
  remaining: number

  companyCount: number
  /** Null until a target portfolio size is stated — NOT a negative number derived from 0. */
  plannedNewDeals: number | null
  /** What the deal rows would cost: Σ check + follow-on. */
  plannedCost: number
  /** Follow-on dollars entered against companies already in the portfolio. */
  plannedExistingFollowOn: number
  /** New checks in the remaining-portfolio plan. */
  plannedNewCapital: number
  /** Follow-on reserves in the remaining-portfolio plan. */
  plannedNewFollowOn: number
  /** Actual plus planned new capital. */
  projectedNew: number
  /** Actual plus all planned follow-on capital. */
  projectedFollowOn: number
  /** remaining − plannedCost. Negative means the mix does not fit. Null with no mix stated. */
  gap: number | null
  /** remaining ÷ plannedNewDeals. Null when there are no deals left to do. */
  avgPerRemainingDeal: number | null
}

export interface StageReturn extends ConstructionStage {
  /** initialCheck / initialPostMoney. */
  initialOwnership: number
  /** initialOwnership × dilutionFactor. */
  ownershipAtExit: number
  /** The exit valuation at which this stage's ownership alone returns the whole fund. */
  exitToReturnFund: number
  /** Initial check plus reserved follow-on — what this deal consumes. */
  allocation: number
  plannedInitial: number
  plannedFollowOn: number
  /** A planned deal begins at cost until a mark exists. */
  currentValue: number
  currentMoic: number | null
  /** Expected proceeds from this deal. */
  estimatedReturn: number | null
  estimatedMoic: number | null
  /** Exit value used by the ownership method, including the automatic at-cost default. */
  forecastExitValue: number
  returnMethod: ReturnForecastMethod
}

export interface PositionReturn {
  actual: ConstructionPositionActual
  forecast: ConstructionPositionForecast
  /** Residual value. Zero for a fully exited company. */
  currentValue: number
  /** Current total value / invested, using realized proceeds for an exited company. */
  currentMoic: number | null
  /** Future forecast proceeds only; realized proceeds remain separate. */
  estimatedReturn: number | null
  /** (Realized proceeds + forecast proceeds) / total invested capital. */
  estimatedMoic: number | null
  /** Exit value used by the ownership method, including the automatic current-value default. */
  forecastExitValue: number
  returnMethod: ReturnForecastMethod
  exitToReturnFund: number | null
  isForecasted: boolean
}

export interface SensitivityRow {
  ownershipAtExit: number
  /** Null until a target multiple and portfolio size are both stated. */
  avgExitForTargetReturn: number | null
  exitToReturnFund: number
  /** Forecasted net fund MOIC if the portfolio exits at this average ownership. */
  netMoic: number | null
  /** The row derived from the portfolio plan rather than stated. */
  isWeightedAverage: boolean
}

export interface ReturnsBlock {
  targetFundMultiple: number
  /** Null until a target multiple is stated. 0× is not a target, it is an unanswered question. */
  requiredPortfolioValue: number | null
  /**
   * The same required value expressed against INVESTABLE capital rather than committed. A "5x
   * fund" is 5× committed, but only ~76% of committed is ever invested — so the portfolio has to
   * clear the larger number, and that is the one worth stating out loud.
   */
  impliedMultipleOnInvested: number | null
  stages: StageReturn[]
  /** Deal-weighted. Null when the plan has no deals — never Infinity. */
  wAvgOwnershipAtExit: number | null
  avgExitForTargetReturn: number | null
  exitToReturnFund: number | null
  sensitivity: SensitivityRow[]
  positions: PositionReturn[]
  currentPortfolioValue: number
  estimatedExistingValue: number
  estimatedFutureValue: number
  estimatedPortfolioValue: number
  /** Realized proceeds plus all active-company and planned-deal forecast proceeds. */
  forecastedTotalValue: number
  /** Current portfolio value plus realized investment proceeds, divided by deployed capital. */
  actualGrossMoic: number | null
  /** Fund NAV plus LP distributions, divided by called capital. */
  actualNetMoic: number | null
  estimatedGrossMoic: number | null
  /** Forecasted total value divided by committed capital. */
  estimatedNetMoic: number | null
  /** Estimated portfolio value less the return target. */
  targetGap: number | null
}

export interface ConstructionResult {
  capital: CapitalBlock
  returns: ReturnsBlock
  warnings: string[]
}

const usd = (n: number) =>
  n.toLocaleString('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 })

/**
 * The whole model. The retained date parameter keeps existing callers compatible; projections
 * themselves use the explicit forward term rather than an inferred start date.
 *
 * The warnings are the point of the page, not decoration: a portfolio plan that costs more than
 * remains, or whose entered deals do not add up to the deals still to do, is a plan that will not
 * happen. The spreadsheet this replaces could not tell its author either of those things.
 */
export function constructionModel(
  actuals: ConstructionActuals,
  a: ConstructionAssumptions,
  _today: Date = new Date(),
): ConstructionResult {
  const warnings: string[] = []

  // ── Investable capital ──────────────────────────────────────────────────────
  const deployedTotal = r(actuals.deployedInitial + actuals.deployedFollowOn)

  // The entered term is always forward-looking: it is the number of years from now to forecast,
  // regardless of whether historical actuals come from the ledger or the portfolio tracker.
  // Only the fee-paying commitments are charged (the GP's own stake is not) — see feePayingShare.
  const feePayingShare = Math.min(1, Math.max(0, actuals.feePayingShare ?? 1))
  const feesProjected = r(projectRemainingFees(a, actuals.committedCapital, deployedTotal, actuals.nav) * feePayingShare)
  const lifetimeFees = r(actuals.managementFeesIncurred + feesProjected)

  const expenseProjectionYears = Math.max(0, a.feeTermYears)
  const orgCostsProjected = r(a.remainingOrgCosts)
  const expensesProjected = r(a.annualPartnershipExpense * expenseProjectionYears)
  const lifetimeExpenses = r(
    actuals.orgCostsIncurred + orgCostsProjected + actuals.partnershipExpensesIncurred + expensesProjected,
  )
  const incurredExpenses = r(actuals.managementFeesIncurred + actuals.orgCostsIncurred + actuals.partnershipExpensesIncurred)
  const projectedExpenses = r(feesProjected + orgCostsProjected + expensesProjected)
  const totalExpenses = r(incurredExpenses + projectedExpenses)

  const investable = r(actuals.committedCapital - totalExpenses)
  const remaining = r(investable - deployedTotal)

  // Nothing is assumed about the plan until the GP states it. A target of 0 is "not answered
  // yet", not "a portfolio of nothing" — so it yields null rather than a negative deal count.
  const hasTarget = a.targetPortfolioSize > 0
  const hasMix = a.stages.length > 0
  const exitedCompanyIds = new Set((actuals.positions ?? []).filter(p => p.status === 'exited').map(p => p.companyId))
  const activePositionForecasts = a.positionForecasts.filter(f => !exitedCompanyIds.has(f.companyId))
  const hasPlan = hasMix || activePositionForecasts.some(f => f.plannedFollowOn > 0)
  const plannedNewDeals = hasTarget ? a.targetPortfolioSize - actuals.companyCount : null
  const plannedExistingFollowOn = r(activePositionForecasts.reduce((s, f) => s + f.plannedFollowOn, 0))
  const plannedNewCapital = r(a.stages.reduce((s, st) => s + st.initialCheck, 0))
  const plannedNewFollowOn = r(a.stages.reduce((s, st) => s + (st.followOnCheck ?? st.initialCheck * st.followOnMultiple), 0))
  const plannedCost = r(plannedExistingFollowOn + plannedNewCapital + plannedNewFollowOn)
  const gap = hasPlan ? r(remaining - plannedCost) : null
  const stageDeals = a.stages.length

  if (!actuals.ledgerAvailable) {
    warnings.push(
      'Fees and expenses are not on the ledger for this vehicle, so projected management fees ' +
      'and partnership expenses cover the full stated fund term.',
    )
  }
  // Only warn about a plan that EXISTS. An unconfigured page is not a fund in trouble, and
  // shouting at someone who has not filled the form in yet trains them to ignore the warnings.
  if (gap != null && gap < 0) {
    warnings.push(`The portfolio plan needs more capital than remains — it is short by ${usd(Math.abs(gap))}.`)
  }
  if (hasMix && plannedNewDeals != null && stageDeals !== plannedNewDeals) {
    warnings.push(`The portfolio plan contains ${stageDeals} deals, but ${plannedNewDeals} remain to reach a portfolio of ${a.targetPortfolioSize}.`)
  }

  // ── The return model ────────────────────────────────────────────────────────
  //
  // KNOWN SIMPLIFICATION: follow-on dollars buy pro-rata that reduces dilution, but
  // `dilutionFactor` does not react to `followOnMultiple`. Keeping them independent means the
  // dilution assumption stays something the GP STATES rather than something the model infers
  // from a reserve number. Revisit only if the two are observed to drift in practice.
  const stageReturns: StageReturn[] = a.stages.map(st => {
    // Incomplete rows persist while the user fills them. A zero post-money therefore means the
    // ownership is not priced yet, never Infinity.
    const initialOwnership = st.initialPostMoney > 0 ? st.initialCheck / st.initialPostMoney : 0
    const plannedInitial = r(st.initialCheck)
    const plannedFollowOn = r(st.followOnCheck ?? st.initialCheck * st.followOnMultiple)
    const allocation = r(plannedInitial + plannedFollowOn)
    const legacyOwnership = st.ownershipAtExit ?? initialOwnership * st.dilutionFactor
    const additionalDilution = st.additionalDilution != null
      ? Math.min(1, Math.max(0, st.additionalDilution))
      : initialOwnership > 0 && legacyOwnership > 0
        ? Math.min(1, Math.max(0, 1 - legacyOwnership / initialOwnership))
        : 0
    const ownershipAtExit = initialOwnership > 0
      ? initialOwnership * (1 - additionalDilution)
      : legacyOwnership
    const returnMethod: ReturnForecastMethod = st.returnMethod === 'moic' ? 'moic' : 'ownership'
    // An untouched planned deal starts at cost: its exit value is the valuation at which the
    // forecast ownership returns the planned allocation before any additional dilution.
    const forecastExitValue = (st.expectedExitValue ?? 0) > 0
      ? st.expectedExitValue ?? 0
      : initialOwnership > 0 ? allocation / initialOwnership : 0
    const defaultMoic = allocation > 0 ? a.simulation.defaultExitMultiple : 0
    const hasForecastMoicOverride = st.forecastMoicOverride === true || (st.forecastMoic ?? 0) > 0
    const forecastMoic = hasForecastMoicOverride ? st.forecastMoic ?? 0 : defaultMoic
    const estimatedReturn = returnMethod === 'moic'
      ? allocation > 0 ? r(allocation * forecastMoic) : null
      : forecastExitValue > 0 && ownershipAtExit > 0
        ? r(forecastExitValue * ownershipAtExit)
        : allocation > 0 ? allocation : null
    return {
      ...st,
      initialOwnership,
      ownershipAtExit,
      additionalDilution,
      exitToReturnFund: ownershipAtExit > 0 ? r(actuals.committedCapital / ownershipAtExit) : 0,
      allocation,
      plannedInitial,
      plannedFollowOn,
      forecastMoic,
      forecastExitValue,
      returnMethod,
      currentValue: allocation,
      currentMoic: allocation > 0 ? 1 : null,
      estimatedReturn,
      estimatedMoic: estimatedReturn != null && allocation > 0 ? estimatedReturn / allocation : null,
    }
  })

  const forecasts = new Map(a.positionForecasts.map(f => [f.companyId, f]))
  const positionReturns: PositionReturn[] = (actuals.positions ?? []).map(actual => {
    const storedForecast = forecasts.get(actual.companyId) ?? {
      companyId: actual.companyId,
      plannedFollowOn: 0,
      ownershipAtExit: actual.currentOwnership ?? 0,
      additionalDilution: 0,
      expectedExitValue: 0,
      forecastMoic: 0,
      returnMethod: 'moic' as const,
    }
    const isExited = actual.status === 'exited'
    const currentValue = r(isExited ? 0 : actual.currentValue)
    const currentMoic = actual.investedTotal > 0
      ? (isExited ? actual.distributions : currentValue) / actual.investedTotal
      : null
    const currentOwnership = actual.currentOwnership ?? 0
    const legacyOwnership = storedForecast.ownershipAtExit || currentOwnership
    const additionalDilution = storedForecast.additionalDilution != null
      ? Math.min(1, Math.max(0, storedForecast.additionalDilution))
      : currentOwnership > 0 && legacyOwnership > 0
        ? Math.min(1, Math.max(0, 1 - legacyOwnership / currentOwnership))
        : 0
    const forecastOwnership = currentOwnership > 0
      ? currentOwnership * (1 - additionalDilution)
      : legacyOwnership
    const returnMethod: ReturnForecastMethod = storedForecast.returnMethod === 'moic' ? 'moic' : 'ownership'
    const plannedFollowOn = isExited ? 0 : storedForecast.plannedFollowOn
    const invested = actual.investedTotal + plannedFollowOn
    // No input is required for the base case: zero dilution plus the implied current exit value
    // produces forecast proceeds equal to current value.
    const forecastExitValue = storedForecast.expectedExitValue > 0
      ? storedForecast.expectedExitValue
      : currentOwnership > 0 ? currentValue / currentOwnership : 0
    const defaultMoic = invested > 0 ? a.simulation.defaultExitMultiple : 0
    const hasForecastMoicOverride = storedForecast.forecastMoicOverride === true || (storedForecast.forecastMoic ?? 0) > 0
    const enteredForecastMoic = hasForecastMoicOverride ? storedForecast.forecastMoic ?? 0 : defaultMoic
    // Do not make the default forecast imply that the current carrying-value multiple disappears.
    // A GP can still model uncertainty through the simulation, while the deterministic case starts
    // no lower than the position's current result.
    const forecastMoic = hasForecastMoicOverride
      ? enteredForecastMoic
      : Math.max(currentMoic ?? 0, enteredForecastMoic)
    const estimatedReturn = isExited
      ? null
      : returnMethod === 'moic'
        ? invested > 0 ? r(invested * forecastMoic) : currentValue
        : forecastOwnership > 0 && forecastExitValue > 0
          ? r(forecastOwnership * forecastExitValue)
          : currentValue
    const forecast: ConstructionPositionForecast = isExited
      ? { companyId: actual.companyId, plannedFollowOn: 0, ownershipAtExit: 0, additionalDilution: 0, expectedExitValue: 0, forecastMoic: 0, returnMethod }
      : { ...storedForecast, plannedFollowOn, ownershipAtExit: forecastOwnership, additionalDilution, forecastMoic, returnMethod }
    return {
      actual,
      forecast,
      currentValue,
      currentMoic,
      estimatedReturn,
      // Gross MOIC is a whole-deal measure. Realized proceeds stay in their own table column, but
      // they still belong in the numerator alongside any remaining forecast proceeds. A fully
      // exited deal therefore reports its realized MOIC instead of a blank forecast multiple.
      estimatedMoic: invested > 0
        ? (actual.distributions + (estimatedReturn ?? 0)) / invested
        : null,
      forecastExitValue,
      returnMethod,
      exitToReturnFund: !isExited && forecastOwnership > 0
        ? r(actuals.committedCapital / forecastOwnership)
        : null,
      isForecasted: !isExited,
    }
  })

  const forecastedExisting = positionReturns.filter(p => p.returnMethod === 'ownership' && p.forecast.ownershipAtExit > 0)
  const ownershipStages = stageReturns.filter(st => st.returnMethod === 'ownership')
  const totalStageDeals = ownershipStages.length
  const ownershipDealCount = totalStageDeals + forecastedExisting.length
  const wAvgOwnershipAtExit = ownershipDealCount > 0
    ? (
        ownershipStages.reduce((s, st) => s + st.ownershipAtExit, 0) +
        forecastedExisting.reduce((s, p) => s + p.forecast.ownershipAtExit, 0)
      ) / ownershipDealCount
    : null

  const requiredPortfolioValue = a.targetFundMultiple > 0
    ? r(a.targetFundMultiple * actuals.committedCapital)
    : null

  const estimatedExistingValue = r(positionReturns.reduce((s, p) => s + (p.estimatedReturn ?? 0), 0))
  const estimatedFutureValue = r(stageReturns.reduce((s, st) => s + (st.estimatedReturn ?? 0), 0))
  const estimatedPortfolioValue = r(estimatedExistingValue + estimatedFutureValue)
  const ownershipEstimatedValue = r(
    positionReturns.filter(p => p.returnMethod === 'ownership').reduce((s, p) => s + (p.estimatedReturn ?? 0), 0) +
    ownershipStages.reduce((s, st) => s + (st.estimatedReturn ?? 0), 0),
  )
  const moicEstimatedValue = r(estimatedPortfolioValue - ownershipEstimatedValue)
  const realizedPortfolioValue = r(positionReturns.reduce((s, p) => s + p.actual.distributions, 0))
  const forecastedTotalValue = r(realizedPortfolioValue + estimatedPortfolioValue)
  const projectedInvested = r(deployedTotal + plannedCost)

  const exitFor = (ownership: number): SensitivityRow => ({
    ownershipAtExit: ownership,
    // What the AVERAGE portfolio company must exit at, if every one of them reaches the target.
    avgExitForTargetReturn: requiredPortfolioValue != null && a.targetPortfolioSize > 0
      ? r(requiredPortfolioValue / ownership / a.targetPortfolioSize)
      : null,
    // What ONE company must exit at for the fund's stake in it to return the whole fund.
    exitToReturnFund: r(actuals.committedCapital / ownership),
    // Hold company exit values constant and move the plan's average ownership to this scenario.
    // Realized proceeds do not scale: they have already happened.
    netMoic: actuals.committedCapital > 0 && wAvgOwnershipAtExit && wAvgOwnershipAtExit > 0
      ? (realizedPortfolioValue + moicEstimatedValue + ownershipEstimatedValue * ownership / wAvgOwnershipAtExit) / actuals.committedCapital
      : null,
    isWeightedAverage: false,
  })

  const returns: ReturnsBlock = {
    targetFundMultiple: a.targetFundMultiple,
    requiredPortfolioValue,
    impliedMultipleOnInvested: requiredPortfolioValue != null && investable > 0
      ? Math.round((requiredPortfolioValue / investable) * 100) / 100
      : null,
    stages: stageReturns,
    wAvgOwnershipAtExit,
    avgExitForTargetReturn: requiredPortfolioValue != null && wAvgOwnershipAtExit && wAvgOwnershipAtExit > 0 && a.targetPortfolioSize > 0
      ? r(requiredPortfolioValue / wAvgOwnershipAtExit / a.targetPortfolioSize)
      : null,
    exitToReturnFund: wAvgOwnershipAtExit && wAvgOwnershipAtExit > 0
      ? r(actuals.committedCapital / wAvgOwnershipAtExit)
      : null,
    sensitivity: wAvgOwnershipAtExit && wAvgOwnershipAtExit > 0
      ? [-0.02, -0.01, 0, 0.01, 0.02]
          .map(offset => ({
            ownership: offset === 0
              ? wAvgOwnershipAtExit
              : Math.round((wAvgOwnershipAtExit + offset) * 100_000_000) / 100_000_000,
            offset,
          }))
          .filter(({ ownership }) => ownership > 0)
          .map(({ ownership, offset }) => ({ ...exitFor(ownership), isWeightedAverage: offset === 0 }))
      : [],
    positions: positionReturns,
    currentPortfolioValue: actuals.positions == null
      ? r(actuals.currentValue)
      : r(positionReturns.reduce((s, p) => s + p.currentValue, 0)),
    estimatedExistingValue,
    estimatedFutureValue,
    estimatedPortfolioValue,
    forecastedTotalValue,
    actualGrossMoic: deployedTotal > 0 ? (realizedPortfolioValue + positionReturns.reduce((s, p) => s + p.currentValue, 0)) / deployedTotal : null,
    actualNetMoic: (actuals.calledCapital ?? 0) > 0
      ? (actuals.nav + (actuals.distributedCapital ?? 0)) / (actuals.calledCapital ?? 0)
      : null,
    estimatedGrossMoic: projectedInvested > 0 ? forecastedTotalValue / projectedInvested : null,
    estimatedNetMoic: actuals.committedCapital > 0 ? forecastedTotalValue / actuals.committedCapital : null,
    targetGap: requiredPortfolioValue == null ? null : r(forecastedTotalValue - requiredPortfolioValue),
  }

  return {
    capital: {
      committedCapital: r(actuals.committedCapital),
      feePayingShare,
      calledCapital: r(actuals.calledCapital ?? 0),
      uncalledCapital: r(actuals.uncalledCapital ?? Math.max(0, actuals.committedCapital - (actuals.calledCapital ?? 0))),
      feesIncurred: r(actuals.managementFeesIncurred),
      feesProjected,
      lifetimeFees,
      orgCostsIncurred: r(actuals.orgCostsIncurred),
      orgCostsProjected,
      expensesIncurred: r(actuals.partnershipExpensesIncurred),
      expensesProjected,
      lifetimeExpenses,
      incurredExpenses,
      projectedExpenses,
      totalExpenses,
      investable,
      ledgerAvailable: actuals.ledgerAvailable,
      deployedInitial: r(actuals.deployedInitial),
      deployedFollowOn: r(actuals.deployedFollowOn),
      deployedTotal,
      remaining,
      companyCount: actuals.companyCount,
      plannedNewDeals,
      plannedCost,
      plannedExistingFollowOn,
      plannedNewCapital,
      plannedNewFollowOn,
      projectedNew: r(actuals.deployedInitial + plannedNewCapital),
      projectedFollowOn: r(actuals.deployedFollowOn + plannedExistingFollowOn + plannedNewFollowOn),
      gap,
      avgPerRemainingDeal: plannedNewDeals != null && plannedNewDeals > 0 ? r(remaining / plannedNewDeals) : null,
    },
    returns,
    warnings,
  }
}

/**
 * Where the forecasted total value COMES FROM — the three sources that add up to it.
 *
 * `forecastedTotalValue` is one number on the page, and one number cannot say whether a 3x fund
 * is 3x because a company already exited, because a lot of cost is sitting at carrying value, or
 * because the forecast is asking for a large gain that has not happened yet. Those are very
 * different plans. This splits it:
 *
 *   realizedProceeds  cash already back from exits and secondaries
 *   investedAtWork    cost basis still deployed or committed to a plan — the part that is not gain
 *   forecastGain      what the forecast asks the remaining book to add on top of that cost
 *
 * The three sum to `forecastedTotalValue` by construction, so a chart of them can never disagree
 * with the MOIC printed beside it. An exited company appears ONLY in realizedProceeds: its cost
 * is not at work any more, and counting it again would double it against a forecast it no longer
 * has (`estimatedReturn` is null for an exited row).
 *
 * `forecastGain` is signed. A marked-down book returns a negative number rather than a floored
 * zero — the caller decides how to draw that; the model does not misreport the direction.
 */
export interface ValueSources {
  realizedProceeds: number
  investedAtWork: number
  forecastGain: number
  /** Equal to `returns.forecastedTotalValue`. */
  total: number
}

export function valueSources(result: ConstructionResult): ValueSources {
  const { returns } = result
  const realizedProceeds = r(returns.positions.reduce((s, p) => s + p.actual.distributions, 0))
  const investedAtWork = r(
    returns.positions
      .filter(p => p.isForecasted)
      .reduce((s, p) => s + p.actual.investedTotal + p.forecast.plannedFollowOn, 0) +
    returns.stages.reduce((s, st) => s + st.allocation, 0),
  )
  return {
    realizedProceeds,
    investedAtWork,
    forecastGain: r(returns.estimatedPortfolioValue - investedAtWork),
    total: returns.forecastedTotalValue,
  }
}
