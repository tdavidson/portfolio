import type {
  ConstructionAssumptions,
  ConstructionPositionActual,
  ConstructionPositionForecast,
} from '@/lib/accounting/construction'
import {
  getConstructionModel,
  updateConstructionAssumptions,
  validateConstructionAssumptions,
} from '@/lib/accounting/construction-service'
import type { ActionDeps, PreviewResult } from './types'

type ScalarPatch = Partial<Pick<ConstructionAssumptions,
  | 'feeAnnualRate'
  | 'feeBasis'
  | 'feeTermYears'
  | 'feeStartDate'
  | 'feeStepDownYear'
  | 'feeStepDownRate'
  | 'annualPartnershipExpense'
  | 'remainingOrgCosts'
  | 'targetPortfolioSize'
  | 'targetFundMultiple'
  | 'stages'
>>

export interface UpdatePortfolioConstructionInput extends ScalarPatch {
  vehicle: string
  /** Per-company patches keyed by the stable companies.id UUID. */
  positionForecasts?: Record<string, Partial<Omit<ConstructionPositionForecast, 'companyId'>>>
  explanation?: string
}

const ASSUMPTION_FIELDS = [
  'feeAnnualRate',
  'feeBasis',
  'feeTermYears',
  'feeStartDate',
  'feeStepDownYear',
  'feeStepDownRate',
  'annualPartnershipExpense',
  'remainingOrgCosts',
  'targetPortfolioSize',
  'targetFundMultiple',
  'stages',
  'positionForecasts',
] as const

const TOP_LEVEL_FIELDS = new Set<string>(['vehicle', 'explanation', ...ASSUMPTION_FIELDS])
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

function changedFields(
  input: UpdatePortfolioConstructionInput,
): Array<(typeof ASSUMPTION_FIELDS)[number]> {
  return ASSUMPTION_FIELDS.filter(field => input[field] !== undefined)
}

function validatePatchEnvelope(input: UpdatePortfolioConstructionInput): void {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new Error('Construction update must be an object')
  }
  const unknown = Object.keys(input).filter(field => !TOP_LEVEL_FIELDS.has(field))
  if (unknown.length > 0) throw new Error(`Construction updates cannot change: ${unknown.join(', ')}`)
  if (typeof input.vehicle !== 'string' || !input.vehicle.trim()) throw new Error('vehicle is required')
  if (input.explanation != null && typeof input.explanation !== 'string') {
    throw new Error('explanation must be a string')
  }
  if (changedFields(input).length === 0) {
    throw new Error('Specify at least one construction assumption to change')
  }
}

function applyPatch(
  before: ConstructionAssumptions,
  input: UpdatePortfolioConstructionInput,
  actualPositions: ConstructionPositionActual[],
  vintageYear: number | null,
): ConstructionAssumptions {
  validatePatchEnvelope(input)
  const fields = changedFields(input)

  const next: ConstructionAssumptions = { ...before }
  for (const field of ASSUMPTION_FIELDS) {
    if (field === 'positionForecasts' || input[field] === undefined) continue
    Object.assign(next, { [field]: input[field] })
  }

  if (input.positionForecasts !== undefined) {
    if (!input.positionForecasts || typeof input.positionForecasts !== 'object' || Array.isArray(input.positionForecasts)) {
      throw new Error('positionForecasts must be an object keyed by company UUID')
    }
    const actualById = new Map(actualPositions.map(position => [position.companyId, position]))
    const forecasts = new Map(before.positionForecasts.map(forecast => [forecast.companyId, forecast]))
    for (const [companyId, patch] of Object.entries(input.positionForecasts)) {
      if (!UUID.test(companyId)) throw new Error(`Invalid company UUID in positionForecasts: ${companyId}`)
      const actual = actualById.get(companyId)
      if (!actual) throw new Error(`Company ${companyId} is not a position in this vehicle`)
      if (!patch || typeof patch !== 'object' || Array.isArray(patch)) {
        throw new Error(`positionForecasts.${companyId} must be an object`)
      }
      const allowed = new Set([
        'plannedFollowOn', 'ownershipAtExit', 'additionalDilution', 'expectedExitValue',
        'forecastMoic', 'returnMethod',
        // Per-company timing and simulation overrides; null returns a field to the fund-wide value.
        'exitInYears', 'followOnInYears', 'simLossRate', 'simDispersion', 'simExitSpreadYears',
      ])
      const unknownForecastFields = Object.keys(patch).filter(field => !allowed.has(field))
      if (unknownForecastFields.length > 0) {
        throw new Error(`positionForecasts.${companyId} cannot change: ${unknownForecastFields.join(', ')}`)
      }
      const current = forecasts.get(companyId) ?? {
        companyId,
        plannedFollowOn: 0,
        ownershipAtExit: actual.currentOwnership ?? 0,
        additionalDilution: 0,
        expectedExitValue: 0,
        forecastMoic: 0,
        returnMethod: 'ownership' as const,
      }
      forecasts.set(companyId, { ...current, ...patch, companyId })
    }
    next.positionForecasts = Array.from(forecasts.values())
  }

  return validateConstructionAssumptions(next, vintageYear)
}

/** Read current state and show only the explicitly requested before/after fields. */
export async function previewUpdatePortfolioConstruction(
  deps: ActionDeps,
  input: UpdatePortfolioConstructionInput,
): Promise<PreviewResult> {
  validatePatchEnvelope(input)
  const model = await getConstructionModel(
    { admin: deps.admin, fundId: deps.fundId, access: deps.access },
    { vehicle: input.vehicle },
  )
  const after = applyPatch(
    model.assumptions,
    input,
    model.actuals.positions ?? [],
    model.vintageYear,
  )
  const fields = changedFields(input)
  const changes = Object.fromEntries(fields.map(field => [field, {
    before: model.assumptions[field],
    after: after[field],
  }]))
  return {
    summary: `Update ${fields.length} portfolio-construction assumption${fields.length === 1 ? '' : 's'} for ${model.vehicle}`,
    details: {
      vehicle: model.vehicle,
      changes,
      ...(input.explanation ? { explanation: input.explanation } : {}),
    },
  }
}

/** Re-read live assumptions at approval time and apply the staged patch, never staged actuals. */
export async function executeUpdatePortfolioConstruction(
  deps: ActionDeps,
  input: UpdatePortfolioConstructionInput,
): Promise<Record<string, unknown>> {
  validatePatchEnvelope(input)
  const current = await getConstructionModel(
    { admin: deps.admin, fundId: deps.fundId, access: deps.access },
    { vehicle: input.vehicle },
  )
  const assumptions = applyPatch(
    current.assumptions,
    input,
    current.actuals.positions ?? [],
    current.vintageYear,
  )
  const model = await updateConstructionAssumptions(
    { admin: deps.admin, fundId: deps.fundId, access: deps.access },
    { vehicle: current.vehicle, assumptions },
  )
  return { model }
}
