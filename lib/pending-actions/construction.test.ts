import { beforeEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_ASSUMPTIONS } from '@/lib/accounting/construction'
import { DEFAULT_FEATURE_VISIBILITY, type FeatureVisibilityMap } from '@/lib/types/features'
import type { AccessContext } from '@/lib/access/effective'

const mocks = vi.hoisted(() => ({
  getConstructionModel: vi.fn(),
  updateConstructionAssumptions: vi.fn(),
}))

vi.mock('@/lib/accounting/construction-service', async importOriginal => {
  const original = await importOriginal<typeof import('@/lib/accounting/construction-service')>()
  return {
    ...original,
    getConstructionModel: mocks.getConstructionModel,
    updateConstructionAssumptions: mocks.updateConstructionAssumptions,
  }
})

import {
  executeUpdatePortfolioConstruction,
  previewUpdatePortfolioConstruction,
} from './construction'
import { buildAnalystTools } from '@/lib/ai/analyst-tools'

const companyId = '11111111-1111-4111-8111-111111111111'
const model = {
  vehicle: 'Fund II',
  vehicleId: 'vehicle-2',
  vintageYear: 2024,
  ledgerAvailable: true,
  actuals: {
    committedCapital: 10_000_000,
    managementFeesIncurred: 0,
    orgCostsIncurred: 0,
    partnershipExpensesIncurred: 0,
    ledgerAvailable: true,
    deployedInitial: 1_000_000,
    deployedFollowOn: 0,
    companyCount: 1,
    currentValue: 1_000_000,
    nav: 1_000_000,
    positions: [{
      companyId,
      name: 'Example Co',
      stage: 'Seed',
      status: 'active',
      investedInitial: 1_000_000,
      investedFollowOn: 0,
      investedTotal: 1_000_000,
      currentValue: 1_000_000,
      currentMoic: 1,
      currentOwnership: 0.1,
      currentPostMoney: 10_000_000,
      distributions: 0,
    }],
  },
  assumptions: { ...DEFAULT_ASSUMPTIONS, feeAnnualRate: 0.02 },
  forecast: { capital: {}, returns: { positions: [] }, warnings: [] },
  positions: [],
  warnings: [],
  asOf: '2026-09-02T12:00:00.000Z',
}

const features = Object.fromEntries(
  Object.keys(DEFAULT_FEATURE_VISIBILITY).map(key => [key, 'everyone']),
) as FeatureVisibilityMap

function access(level: 'read' | 'write'): AccessContext {
  return {
    fundId: 'fund-1',
    userId: 'user-1',
    vehicles: { all: true, ids: [] },
    role: 'member',
    features,
    grants: { accounting: level },
    defaults: {},
  }
}

const deps = (level: 'read' | 'write' = 'write') => ({
  admin: {} as any,
  fundId: 'fund-1',
  userId: 'user-1',
  access: access(level),
})

describe('update_portfolio_construction pending action', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.getConstructionModel.mockResolvedValue(model)
    mocks.updateConstructionAssumptions.mockResolvedValue(model)
  })

  it('previews explicit before/after changes without saving', async () => {
    const preview = await previewUpdatePortfolioConstruction(deps(), {
      vehicle: 'Fund II',
      feeAnnualRate: 0.015,
      positionForecasts: {
        [companyId]: { plannedFollowOn: 250_000, returnMethod: 'moic', forecastMoic: 3 },
      },
      explanation: 'Use the revised reserve plan.',
    })

    expect(preview.summary).toMatch(/2 portfolio-construction assumptions for Fund II/)
    expect(preview.details).toMatchObject({
      vehicle: 'Fund II',
      changes: {
        feeAnnualRate: { before: 0.02, after: 0.015 },
      },
      explanation: 'Use the revised reserve plan.',
    })
    expect(mocks.updateConstructionAssumptions).not.toHaveBeenCalled()
  })

  it('re-reads live state and executes through the shared service exactly once', async () => {
    await executeUpdatePortfolioConstruction(deps(), {
      vehicle: 'Fund II',
      remainingOrgCosts: 15_000,
    })

    expect(mocks.getConstructionModel).toHaveBeenCalledTimes(1)
    expect(mocks.updateConstructionAssumptions).toHaveBeenCalledTimes(1)
    expect(mocks.updateConstructionAssumptions).toHaveBeenCalledWith(
      expect.objectContaining({ fundId: 'fund-1' }),
      expect.objectContaining({
        vehicle: 'Fund II',
        assumptions: expect.objectContaining({ remainingOrgCosts: 15_000 }),
      }),
    )
  })

  it('rejects attempts to overwrite server-derived actuals', async () => {
    await expect(previewUpdatePortfolioConstruction(deps(), {
      vehicle: 'Fund II',
      committedCapital: 1,
    } as any)).rejects.toThrow(/cannot change: committedCapital/)
    expect(mocks.updateConstructionAssumptions).not.toHaveBeenCalled()
  })

  it('is advertised only to callers with accounting write access', () => {
    const readOnly = buildAnalystTools({ ...deps('read'), enableDrafts: true })
    const writer = buildAnalystTools({ ...deps('write'), enableDrafts: true })
    expect(readOnly.tools.some(tool => tool.name === 'update_portfolio_construction')).toBe(false)
    expect(writer.tools.some(tool => tool.name === 'update_portfolio_construction')).toBe(true)
  })

  it('cannot be staged by the read-only demo', () => {
    const viewer = buildAnalystTools({
      ...deps('write'),
      access: { ...access('write'), role: 'viewer' },
      enableDrafts: true,
    })
    expect(viewer.tools.some(tool => tool.name === 'update_portfolio_construction')).toBe(false)
  })
})
