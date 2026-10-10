// Server-side portfolio-construction service. Transports authenticate, authorize, and translate
// their own contracts; all database loading, row mapping, validation, persistence, and model
// calculation live here so the web route and every agent surface share one implementation.

import type { SupabaseClient } from '@supabase/supabase-js'
import { fundEconomics } from './fund-economics'
import { loadPostedLedger } from './load'
import { accountBalances, normalBalance } from './ledger'
import { bucketForSourceType } from './capital-account'
import { loadCarryTerms } from './carry'
import { lpCapitalSummary } from './capital-calls'
import { buildSoiPositions, txnsForVehicle, type SoiCompany } from './soi'
import { resolveVehicle } from './vehicle-resolver'
import {
  constructionModel,
  parseAssumptions,
  type ConstructionActuals,
  type ConstructionAssumptions,
  type ConstructionPositionForecast,
  type ConstructionResult,
  type ConstructionStage,
} from './construction'
import { applyLpWaterfall, constructionBaseline, forecastSchedule, type ForecastSchedule, type ForecastBaseline } from './construction-forecast'
import { simulateFund, type SimulationResult } from './construction-simulation'
import type { Account } from './types'
import type { InvestmentTransaction } from '@/lib/types/database'
import type { AccessContext } from '@/lib/access/effective'

export interface ConstructionServiceContext {
  admin: SupabaseClient
  fundId: string
  /** The caller's access: the vehicle must be one of their entities. Required. */
  access: Pick<AccessContext, 'vehicles'>
}

export type ConstructionAssumptionsInput = ConstructionAssumptions

export interface ConstructionAssumptionsRow {
  fee_annual_rate?: unknown
  fee_basis?: unknown
  fee_term_years?: unknown
  fee_start_date?: unknown
  fee_step_down_year?: unknown
  fee_step_down_rate?: unknown
  annual_partnership_expense?: unknown
  remaining_org_costs?: unknown
  stages?: unknown
  position_forecasts?: unknown
  pacing?: unknown
  simulation?: unknown
}

/** The canonical camelCase result shared by tools and future versioned APIs. */
export interface ConstructionModelResponse {
  vehicle: string
  vehicleId: string | null
  vintageYear: number | null
  ledgerAvailable: boolean
  actuals: ConstructionActuals
  assumptions: ConstructionAssumptions
  forecast: ConstructionResult
  positions: ConstructionResult['returns']['positions']
  warnings: string[]
  asOf: string
  /**
   * The plan on the calendar, once pacing is stated (construction-forecast.ts). Null until then.
   * The same view the construction page headlines: LP-only and net of carry when capital figures
   * are supported and carry is configured, fund-level gross otherwise. `timelineNetOfCarry` says
   * which, so a reader cannot quote one as the other.
   */
  timeline: ForecastSchedule | null
  /** Whether `timeline` and `simulation` are the LP's net-of-carry view. */
  timelineNetOfCarry: boolean
  /** The fund-level gross schedule, when `timeline` is the net one. Null when they are the same. */
  grossTimeline: ForecastSchedule | null
  /** The Monte Carlo over that schedule, once loss or dispersion is stated. Null until then. */
  simulation: SimulationResult | null
}

/** Database snake_case to the application model accepted by parseAssumptions. */
export function mapConstructionAssumptionsRow(row: ConstructionAssumptionsRow): Record<string, unknown> {
  return {
    feeAnnualRate: Number(row.fee_annual_rate),
    feeBasis: row.fee_basis,
    feeTermYears: Number(row.fee_term_years),
    feeStartDate: row.fee_start_date ?? '',
    feeStepDownYear: row.fee_step_down_year == null ? null : Number(row.fee_step_down_year),
    feeStepDownRate: row.fee_step_down_rate == null ? null : Number(row.fee_step_down_rate),
    annualPartnershipExpense: Number(row.annual_partnership_expense),
    remainingOrgCosts: Number(row.remaining_org_costs),
    // Retired controls stay neutral until their legacy columns are removed.
    targetPortfolioSize: 0,
    targetFundMultiple: 0,
    stages: row.stages,
    positionForecasts: row.position_forecasts,
    pacing: row.pacing,
    simulation: row.simulation,
  }
}

const finite = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value)
const plainObject = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value)

function invalid(field: string): never {
  throw new Error(`Invalid portfolio-construction assumption: ${field}`)
}

function validateStage(value: unknown, index: number): asserts value is ConstructionStage {
  if (!plainObject(value)) invalid(`stages[${index}] must be an object`)
  for (const field of ['key', 'label'] as const) {
    if (typeof value[field] !== 'string') invalid(`stages[${index}].${field} must be a string`)
  }
  for (const field of ['initialCheck', 'initialPostMoney', 'followOnMultiple', 'dilutionFactor'] as const) {
    if (!finite(value[field]) || (value[field] as number) < 0) {
      invalid(`stages[${index}].${field} must be a non-negative finite number`)
    }
  }
  for (const field of ['followOnCheck', 'ownershipAtExit', 'expectedExitValue', 'forecastMoic'] as const) {
    if (value[field] != null && (!finite(value[field]) || (value[field] as number) < 0)) {
      invalid(`stages[${index}].${field} must be a non-negative finite number`)
    }
  }
  if (value.additionalDilution != null
    && (!finite(value.additionalDilution) || value.additionalDilution < 0 || value.additionalDilution > 1)) {
    invalid(`stages[${index}].additionalDilution must be between 0 and 1`)
  }
  if (value.returnMethod != null && value.returnMethod !== 'ownership' && value.returnMethod !== 'moic') {
    invalid(`stages[${index}].returnMethod must be ownership or moic`)
  }
  if (value.forecastMoicOverride != null && typeof value.forecastMoicOverride !== 'boolean') {
    invalid(`stages[${index}].forecastMoicOverride must be a boolean`)
  }
  validateDealOverrides(value, `stages[${index}]`, ['investInYears', 'exitInYears', 'followOnInYears'])
}

/** The per-deal timing and simulation overrides: each null (use the fund-wide value) or a non-negative number. */
function validateDealOverrides(value: Record<string, unknown>, where: string, timingFields: string[]): void {
  for (const field of [...timingFields, 'simDispersion', 'simExitSpreadYears']) {
    if (value[field] != null && (!finite(value[field]) || (value[field] as number) < 0)) {
      invalid(`${where}.${field} must be null or a non-negative finite number`)
    }
  }
  if (value.simLossRate != null && (!finite(value.simLossRate) || value.simLossRate < 0 || value.simLossRate > 1)) {
    invalid(`${where}.simLossRate must be null or between 0 and 1`)
  }
}

function validatePositionForecast(
  value: unknown,
  index: number,
): asserts value is ConstructionPositionForecast {
  if (!plainObject(value)) invalid(`positionForecasts[${index}] must be an object`)
  if (typeof value.companyId !== 'string' || !value.companyId) {
    invalid(`positionForecasts[${index}].companyId must be a stable company id`)
  }
  for (const field of ['plannedFollowOn', 'ownershipAtExit', 'expectedExitValue', 'forecastMoic'] as const) {
    if (!finite(value[field]) || (value[field] as number) < 0) {
      invalid(`positionForecasts[${index}].${field} must be a non-negative finite number`)
    }
  }
  if (value.additionalDilution != null
    && (!finite(value.additionalDilution) || value.additionalDilution < 0 || value.additionalDilution > 1)) {
    invalid(`positionForecasts[${index}].additionalDilution must be between 0 and 1`)
  }
  if (value.returnMethod != null && value.returnMethod !== 'ownership' && value.returnMethod !== 'moic') {
    invalid(`positionForecasts[${index}].returnMethod must be ownership or moic`)
  }
  if (value.forecastMoicOverride != null && typeof value.forecastMoicOverride !== 'boolean') {
    invalid(`positionForecasts[${index}].forecastMoicOverride must be a boolean`)
  }
  validateDealOverrides(value, `positionForecasts[${index}]`, ['exitInYears', 'followOnInYears'])
}

/** Strict write boundary. The tolerant parser remains appropriate for old stored rows. */
export function validateConstructionAssumptions(
  raw: unknown,
  vintageYear: number | null,
): ConstructionAssumptions {
  if (!plainObject(raw)) invalid('body must be an object')
  const allowed = new Set([
    'feeAnnualRate', 'feeBasis', 'feeTermYears', 'feeStartDate', 'feeStepDownYear',
    'feeStepDownRate', 'annualPartnershipExpense', 'remainingOrgCosts', 'targetPortfolioSize',
    'targetFundMultiple', 'stages', 'positionForecasts', 'pacing', 'simulation',
  ])
  const unknown = Object.keys(raw).filter(field => !allowed.has(field))
  if (unknown.length > 0) invalid(`unknown fields: ${unknown.join(', ')}`)
  if ('feeBasis' in raw && !['committed', 'invested', 'nav'].includes(String(raw.feeBasis))) {
    invalid('feeBasis must be committed, invested, or nav')
  }
  if ('feeStartDate' in raw && typeof raw.feeStartDate !== 'string') {
    invalid('feeStartDate must be a string')
  }
  for (const field of [
    'feeAnnualRate', 'feeTermYears', 'annualPartnershipExpense', 'remainingOrgCosts',
    'targetPortfolioSize', 'targetFundMultiple',
  ] as const) {
    if (field in raw && (!finite(raw[field]) || (raw[field] as number) < 0)) {
      invalid(`${field} must be a non-negative finite number`)
    }
  }
  for (const field of ['feeStepDownYear', 'feeStepDownRate'] as const) {
    if (raw[field] != null && (!finite(raw[field]) || (raw[field] as number) < 0)) {
      invalid(`${field} must be null or a non-negative finite number`)
    }
  }
  if ('stages' in raw) {
    if (!Array.isArray(raw.stages)) invalid('stages must be an array')
    raw.stages.forEach(validateStage)
  }
  if ('positionForecasts' in raw) {
    if (!Array.isArray(raw.positionForecasts)) invalid('positionForecasts must be an array')
    raw.positionForecasts.forEach(validatePositionForecast)
  }
  if ('pacing' in raw) {
    if (!plainObject(raw.pacing)) invalid('pacing must be an object')
    const p = raw.pacing
    for (const field of ['deploymentYears', 'followOnLagYears', 'holdYears', 'existingHoldYears', 'horizonYears'] as const) {
      if (field in p && (!finite(p[field]) || (p[field] as number) < 0 || (p[field] as number) > 50)) {
        invalid(`pacing.${field} must be a number of years between 0 and 50`)
      }
    }
    if ('accretion' in p && p.accretion !== 'none' && p.accretion !== 'linear') invalid('pacing.accretion must be none or linear')
    const unknownPacing = Object.keys(p).filter(f => !['deploymentYears', 'followOnLagYears', 'holdYears', 'existingHoldYears', 'horizonYears', 'accretion'].includes(f))
    if (unknownPacing.length > 0) invalid(`pacing has unknown fields: ${unknownPacing.join(', ')}`)
  }
  if ('simulation' in raw) {
    if (!plainObject(raw.simulation)) invalid('simulation must be an object')
    const m = raw.simulation
    for (const field of ['runs', 'seed', 'lossRate', 'dispersion', 'holdSpreadYears', 'maxMoic', 'targetMultiple', 'defaultExitMultiple'] as const) {
      if (field in m && (!finite(m[field]) || (m[field] as number) < 0)) invalid(`simulation.${field} must be a non-negative finite number`)
    }
    if ('runs' in m && (m.runs as number) > 20_000) invalid('simulation.runs must be at most 20000')
    if ('lossRate' in m && (m.lossRate as number) > 1) invalid('simulation.lossRate must be between 0 and 1')
    const unknownSim = Object.keys(m).filter(f => !['runs', 'seed', 'lossRate', 'dispersion', 'holdSpreadYears', 'maxMoic', 'targetMultiple', 'defaultExitMultiple'].includes(f))
    if (unknownSim.length > 0) invalid(`simulation has unknown fields: ${unknownSim.join(', ')}`)
  }
  return parseAssumptions(raw, vintageYear)
}

/** ITD expense balance in the account's normal (positive) sense. */
function expenseTotal(accounts: Account[], balances: Map<string, number>, subtype: string): number {
  return accounts
    .filter(account => account.type === 'expense' && account.subtype === subtype)
    .reduce((sum, account) => sum + normalBalance(account, balances.get(account.id) ?? 0), 0)
}

async function loadConstructionActuals(
  admin: SupabaseClient,
  fundId: string,
  vehicle: string,
): Promise<{ actuals: ConstructionActuals; vintageYear: number | null; vehicleId: string | null }> {
  const [vehicles, ledger, transactionResult, companyResult, carryTerms] = await Promise.all([
    fundEconomics(admin, fundId),
    loadPostedLedger(admin, fundId, vehicle).catch(() => null),
    (admin as any).from('investment_transactions').select('*').eq('fund_id', fundId),
    (admin as any).from('companies')
      .select('id, name, holding_type, status, industry, stage, country, portfolio_group')
      .eq('fund_id', fundId),
    loadCarryTerms(admin, fundId, vehicle),
  ])

  const economics = vehicles.find(item => item.vehicle === vehicle) ?? null
  const lpEconomics = economics ? (economics.lp ?? economics.fund) : null
  const recipientIds = new Set(carryTerms.recipients.map(recipient => recipient.lpEntityId))
  // THE GP'S OWN STAKE. The carry recipients' own commitments (the GP entity's 1%) pay no
  // management fee and bear no carry. Their share of commitments sets both: fees are charged on the
  // rest, and only the rest runs through the waterfall.
  const commitments = recipientIds.size > 0 ? await lpCapitalSummary(admin, fundId, vehicle) : []
  const totalCommitted = commitments.reduce((s, r) => s + (r.commitment ?? 0), 0)
  const recipientCommitted = commitments.filter(r => recipientIds.has(r.lpEntityId)).reduce((s, r) => s + (r.commitment ?? 0), 0)
  const gpStakeShare = totalCommitted > 0 ? Math.min(1, recipientCommitted / totalCommitted) : 0
  // Carry actually paid out to date — distributions of carry, by source type, on the books.
  const carryPaidOnBooks = (ledger?.capitalPostings ?? [])
    .filter(p => p.sourceType === 'carry_distribution')
    .reduce((s, p) => s + Math.max(0, p.amount), 0)
  // An undated posting is DROPPED, not dated today. These flows are the dated history the IRR is
  // computed from, and a historical contribution stamped with today's date is exactly the invented
  // cash-flow date the evidence rules refuse — it would read as a return earned in no time at all.
  // `journal_entries.entry_date` is NOT NULL, so this discards nothing in practice.
  const datedFlows = (bucket: 'contributions' | 'distributions', sign: 1 | -1) =>
    (ledger?.capitalPostings ?? [])
      .filter(posting => !recipientIds.has(posting.lpEntityId ?? '') && bucketForSourceType(posting.sourceType) === bucket && !!posting.entryDate)
      .map(posting => ({ date: posting.entryDate as string, amount: Math.max(0, sign * posting.amount) }))
      .filter(flow => flow.amount > 0)
  const lpContributions = datedFlows('contributions', -1)
  const lpDistributions = datedFlows('distributions', 1)
  const ledgerAvailable = !!ledger && ledger.postings.length > 0
  let managementFeesIncurred = 0
  let orgCostsIncurred = 0
  let partnershipExpensesIncurred = 0
  let cashBalance: number | undefined
  if (ledger && ledgerAvailable) {
    const balances = accountBalances(ledger.postings)
    managementFeesIncurred = expenseTotal(ledger.accounts, balances, 'management_fee')
    orgCostsIncurred = expenseTotal(ledger.accounts, balances, 'organizational_expense')
    partnershipExpensesIncurred = expenseTotal(ledger.accounts, balances, 'partnership_expense')
    const cashAccounts = ledger.accounts
      .filter(account => account.type === 'asset' && account.subtype === 'cash')
    if (ledger.postings.some(posting => cashAccounts.some(account => account.id === posting.accountId))) {
      cashBalance = cashAccounts.reduce((sum, account) => sum + normalBalance(account, balances.get(account.id) ?? 0), 0)
    }
  }

  const allTransactions = (transactionResult.data ?? []) as InvestmentTransaction[]
  const positions = buildSoiPositions(
    allTransactions,
    (companyResult.data ?? []) as SoiCompany[],
    vehicle,
    undefined,
    { includeRealized: true },
  )
  const transactionsByCompany = new Map<string, InvestmentTransaction[]>()
  for (const transaction of allTransactions) {
    const transactions = transactionsByCompany.get(transaction.company_id) ?? []
    transactions.push(transaction)
    transactionsByCompany.set(transaction.company_id, transactions)
  }

  const constructionPositions = positions.map(position => {
    const relevant = txnsForVehicle(transactionsByCompany.get(position.companyId) ?? [], vehicle)
      .sort((left, right) => (left.transaction_date ?? '').localeCompare(right.transaction_date ?? ''))
    const firstInvestment = relevant.find(transaction => transaction.transaction_type === 'investment')
    let currentOwnership: number | null = null
    let currentPostMoney: number | null = null
    for (const transaction of relevant) {
      if (transaction.ownership_pct != null) currentOwnership = Number(transaction.ownership_pct) / 100
      const postMoney = transaction.latest_postmoney_valuation ?? transaction.postmoney_valuation
      if (postMoney != null) currentPostMoney = Number(postMoney)
    }
    return {
      companyId: position.companyId,
      name: position.name,
      stage: firstInvestment?.round_name ?? position.stage,
      status: position.status,
      investedInitial: position.investedNew,
      investedFollowOn: position.investedFollowOn,
      investedTotal: position.invested,
      firstInvestmentDate: firstInvestment?.transaction_date ?? null,
      currentValue: position.status === 'exited' ? 0 : position.fairValue,
      currentMoic: position.moic,
      currentOwnership,
      currentPostMoney,
      distributions: position.distributions,
    }
  })

  // CARRY ALREADY PAID, WHEN THE BOOKS DO NOT SAY. A fund that kept no carry entries (its
  // distributions were recorded net, the carry paid outside these books) still paid it. With no
  // preferred return the waterfall is simple: once capital is back, every dollar of profit split
  // carryRate to the GP and the rest to the LPs. So the LPs' distributions beyond their capital are
  // (1 − rate) of the profit, and the carry paid is rate / (1 − rate) of that excess. With a hurdle
  // the split depends on timing this cannot reconstruct, so it is left at what the books show.
  const lpShareOfCommitments = 1 - gpStakeShare
  const carryInferred = () => {
    if (carryPaidOnBooks > 0 || carryTerms.kind === 'none' || carryTerms.carryRate <= 0 || carryTerms.prefRate > 0) return 0
    const called = (economics?.fund.paidIn ?? 0) * lpShareOfCommitments
    const distributed = (economics?.fund.distributions ?? 0) * lpShareOfCommitments
    const excess = distributed - called
    return excess > 0 ? Math.round((excess * carryTerms.carryRate / (1 - carryTerms.carryRate)) * 100) / 100 : 0
  }
  const carryPaidToDate = () => carryPaidOnBooks + carryInferred()

  return {
    vintageYear: economics?.vintageYear ?? null,
    vehicleId: economics?.id ?? null,
    actuals: {
      capitalAvailable: !!economics && economics.fund.paidIn != null && economics.fund.distributions != null && economics.fund.nav != null,
      committedCapital: economics?.fund.committed ?? 0,
      feePayingShare: 1 - gpStakeShare,
      calledCapital: economics?.fund.paidIn ?? 0,
      uncalledCapital: economics?.fund.uncalled ?? 0,
      distributedCapital: economics?.fund.distributions ?? 0,
      waterfall: economics && economics.fund.paidIn != null && economics.fund.distributions != null && economics.fund.nav != null ? {
        asOf: new Date().toISOString().slice(0, 10),
        kind: carryTerms.kind,
        carryRate: carryTerms.carryRate,
        prefRate: carryTerms.prefRate,
        catchupRate: carryTerms.catchupRate,
        prefCompounds: carryTerms.prefCompounds,
        // The LP side excludes the GP's stake. When the books class the GP entity separately,
        // `economics.lp` already leaves it out; otherwise take its share of commitments off.
        ...(() => {
          const classed = !!economics.lp && economics.fund.committed > 0 && economics.lp.committed < economics.fund.committed - 0.5
          const lpShare = classed ? economics.lp!.committed / economics.fund.committed : 1 - gpStakeShare
          return {
            lpCommitmentShare: economics.fund.committed > 0 ? lpShare : 1,
            // The fund figures are known here (the guard above); a class figure may not be.
            lpCalledCapital: (classed ? economics.lp!.paidIn : null) ?? (economics.fund.paidIn as number) * lpShare,
            lpDistributedCapital: (classed ? economics.lp!.distributions : null) ?? (economics.fund.distributions as number) * lpShare,
            lpNav: (classed ? economics.lp!.nav : null) ?? (economics.fund.nav as number) * lpShare,
          }
        })(),
        // fund − LP distributed is read as carry already paid (applyLpWaterfall). With the GP's
        // stake taken off by share, that difference would be the stake's own distributions — so
        // the fund figure is the LPs' plus the carry the books actually show paid.
        fundDistributedCapital: !!economics.lp && economics.fund.committed > 0 && economics.lp.committed < economics.fund.committed - 0.5
          ? economics.fund.distributions
          : (economics.fund.distributions as number) * (1 - gpStakeShare) + carryPaidToDate(),
        ...(carryInferred() > 0 ? { carryPaidInferred: carryInferred() } : {}),
        contributions: lpContributions,
        distributions: lpDistributions,
      } : undefined,
      managementFeesIncurred,
      orgCostsIncurred,
      partnershipExpensesIncurred,
      ledgerAvailable,
      deployedInitial: positions.reduce((sum, position) => sum + position.investedNew, 0),
      deployedFollowOn: positions.reduce((sum, position) => sum + position.investedFollowOn, 0),
      companyCount: positions.length,
      currentValue: constructionPositions.reduce((sum, position) => sum + position.currentValue, 0),
      nav: economics?.fund.nav ?? 0,
      cashBalance,
      positions: constructionPositions,
    },
  }
}

async function loadStoredAssumptions(
  ctx: ConstructionServiceContext,
  vehicleId: string | null,
  vintageYear: number | null,
): Promise<ConstructionAssumptions> {
  if (!vehicleId) return parseAssumptions(null, vintageYear)
  const { data, error } = await (ctx.admin as any)
    .from('fund_construction_models')
    .select('*')
    .eq('fund_id', ctx.fundId)
    .eq('vehicle_id', vehicleId)
    .maybeSingle()
  if (error) throw new Error(error.message)
  return parseAssumptions(data ? mapConstructionAssumptionsRow(data) : null, vintageYear)
}

function constructionResponse(args: {
  vehicle: string
  vehicleId: string | null
  vintageYear: number | null
  actuals: ConstructionActuals
  assumptions: ConstructionAssumptions
}): ConstructionModelResponse {
  const now = new Date()
  const forecast = constructionModel(args.actuals, args.assumptions, now)
  const baseline = constructionBaseline(args.actuals, forecast, now.toISOString().slice(0, 10))
  const gross = forecastSchedule(forecast, args.assumptions, args.assumptions.pacing, baseline)

  // THE SAME VIEW THE PAGE HEADLINES. forecast-section.tsx applies the vehicle's waterfall
  // whenever capital figures are supported and carry is actually configured, and shows the
  // LP-only schedule; this used to return the gross one, so the Analyst reported a fund-level
  // figure in a field called `netIrr` while the page showed the net-of-carry number for the same
  // fund and date. Same conditions here, so one metric means one thing on every surface.
  const waterfall = args.actuals.capitalAvailable === true
    && args.actuals.waterfall && args.actuals.waterfall.kind !== 'none' && args.actuals.waterfall.carryRate > 0
    ? args.actuals.waterfall
    : undefined
  const net = waterfall ? applyLpWaterfall(gross, waterfall) : null
  const schedule = net ?? gross
  const timeline = schedule.stated ? schedule : null
  // The agent's copy runs fewer paths than the page's: the summary it needs is stable at 500.
  const simulation = timeline && (args.assumptions.simulation.lossRate > 0 || args.assumptions.simulation.dispersion > 0 || args.assumptions.simulation.holdSpreadYears > 0)
    ? simulateFund(forecast, args.assumptions, args.assumptions.pacing, { ...args.assumptions.simulation, runs: Math.min(500, args.assumptions.simulation.runs) }, baseline, waterfall)
    : null
  return {
    vehicle: args.vehicle,
    vehicleId: args.vehicleId,
    vintageYear: args.vintageYear,
    ledgerAvailable: args.actuals.ledgerAvailable,
    actuals: args.actuals,
    assumptions: args.assumptions,
    forecast,
    positions: forecast.returns.positions,
    warnings: [...forecast.warnings, ...(timeline?.warnings ?? [])],
    asOf: now.toISOString(),
    timeline,
    timelineNetOfCarry: !!net,
    grossTimeline: net && gross.stated ? gross : null,
    simulation,
  }
}

export async function getConstructionModel(
  ctx: ConstructionServiceContext,
  input: { vehicle: string },
): Promise<ConstructionModelResponse> {
  const vehicle = await resolveVehicle(ctx.admin, ctx.fundId, input.vehicle, { access: ctx.access })
  const { actuals, vintageYear, vehicleId } = await loadConstructionActuals(ctx.admin, ctx.fundId, vehicle)
  const assumptions = await loadStoredAssumptions(ctx, vehicleId, vintageYear)
  return constructionResponse({ vehicle, vehicleId, vintageYear, actuals, assumptions })
}

export async function updateConstructionAssumptions(
  ctx: ConstructionServiceContext,
  input: { vehicle: string; assumptions: ConstructionAssumptionsInput },
): Promise<ConstructionModelResponse> {
  const vehicle = await resolveVehicle(ctx.admin, ctx.fundId, input.vehicle, { access: ctx.access })
  const { actuals, vintageYear, vehicleId } = await loadConstructionActuals(ctx.admin, ctx.fundId, vehicle)
  if (!vehicleId) {
    throw new Error('This vehicle has no registry row, so a construction model cannot be stored for it.')
  }
  // Validate before constructing or awaiting the write query.
  const assumptions = validateConstructionAssumptions(input.assumptions, vintageYear)
  const { error } = await (ctx.admin as any).from('fund_construction_models').upsert({
    fund_id: ctx.fundId,
    vehicle_id: vehicleId,
    fee_annual_rate: assumptions.feeAnnualRate,
    fee_basis: assumptions.feeBasis,
    fee_term_years: assumptions.feeTermYears,
    fee_start_date: assumptions.feeStartDate || null,
    fee_step_down_year: assumptions.feeStepDownYear,
    fee_step_down_rate: assumptions.feeStepDownRate,
    annual_partnership_expense: assumptions.annualPartnershipExpense,
    remaining_org_costs: assumptions.remainingOrgCosts,
    target_portfolio_size: 0,
    existing_reserve_pool: 0,
    target_fund_multiple: 0,
    stages: assumptions.stages,
    position_forecasts: assumptions.positionForecasts,
    pacing: assumptions.pacing,
    simulation: assumptions.simulation,
    updated_at: new Date().toISOString(),
  }, { onConflict: 'fund_id,vehicle_id' })
  if (error) throw new Error(error.message)
  return constructionResponse({ vehicle, vehicleId, vintageYear, actuals, assumptions })
}
