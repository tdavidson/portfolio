import { describe, it, expect } from 'vitest'
import {
  DEFAULT_ASSUMPTIONS, parseAssumptions, projectRemainingFees, constructionModel, blankStage, valueSources,
  type ConstructionAssumptions, type ConstructionActuals,
} from './construction'

const A = (over: Partial<ConstructionAssumptions> = {}): ConstructionAssumptions => ({
  ...DEFAULT_ASSUMPTIONS,
  feeAnnualRate: 0.02,
  feeBasis: 'committed',
  feeTermYears: 10,
  feeStartDate: '2020-01-01',
  ...over,
})

const dealRows = (count: number, row: Omit<ConstructionAssumptions['stages'][number], 'key'> & { key?: string }) =>
  Array.from({ length: count }, (_, i) => ({ ...row, key: `${row.key ?? 'deal'}_${i + 1}` }))

describe('projectRemainingFees', () => {
  it('charges the entered forward forecast years at the flat rate', () => {
    // A fund three years into a ten-year life enters 7: 7 future years × 2% × 20M.
    expect(projectRemainingFees(A({ feeTermYears: 7 }), 20_000_000, 0, 0, new Date('2025-01-01'))).toBe(2_800_000)
  })

  it('honours the step-down', () => {
    // Forecast years 1-5 at 2%, then years 6-10 at 1.5%.
    const stepped = projectRemainingFees(
      A({ feeStepDownYear: 6, feeStepDownRate: 0.015 }), 20_000_000, 0, 0, new Date('2025-01-01'),
    )
    expect(stepped).toBe(3_500_000)
    // And it is genuinely lower than the flat-rate projection, not merely near a constant.
    expect(stepped).toBeLessThan(projectRemainingFees(A(), 20_000_000, 0, 0, new Date('2025-01-01')))
  })

  it('does not infer elapsed years from the legacy fee start date', () => {
    const withOldDate = projectRemainingFees(A({ feeTermYears: 7, feeStartDate: '2020-01-01' }), 20_000_000, 0, 0, new Date('2025-01-01'))
    const withoutDate = projectRemainingFees(A({ feeTermYears: 7, feeStartDate: '' }), 20_000_000, 0, 0, new Date('2035-01-01'))
    expect(withOldDate).toBe(withoutDate)
  })

  it('is zero when no forecast years remain', () => {
    expect(projectRemainingFees(A({ feeTermYears: 0 }), 20_000_000, 0, 0, new Date('2025-01-01'))).toBe(0)
  })

  it('charges a fractional forecast year', () => {
    expect(projectRemainingFees(A({ feeTermYears: 0.5 }), 20_000_000, 0, 0, new Date('2029-07-01'))).toBe(200_000)
  })

  it('bases on invested capital when the basis says so', () => {
    expect(projectRemainingFees(A({ feeBasis: 'invested', feeTermYears: 7 }), 20_000_000, 8_000_000, 0, new Date('2025-01-01')))
      .toBe(1_120_000)
  })
})

describe('parseAssumptions', () => {
  // Fund-specific plans remain blank while return forecasting gets documented industry baselines.
  it('keeps the fund plan blank and supplies return baselines for an absent row', () => {
    const a = parseAssumptions(null, 2020)
    expect(a.feeStartDate).toBe('')
    expect(a.stages).toEqual([])
    expect(a.targetPortfolioSize).toBe(0)
    expect(a.targetFundMultiple).toBe(0)
    expect(a.feeAnnualRate).toBe(0)
    expect(a.feeTermYears).toBe(0)
    expect(a.pacing.holdYears).toBe(6)
    expect(a.simulation.defaultExitMultiple).toBe(3)
    expect(a.simulation.lossRate).toBe(0.5)
  })

  it('does not infer a hidden fee clock from vintage', () => {
    expect(parseAssumptions(null, null).feeStartDate).toBe('')
  })

  it('drops a malformed stage rather than producing NaN downstream', () => {
    const a = parseAssumptions({
      stages: [
        { key: 'seed', label: 'Seed', initialCheck: 500_000, initialPostMoney: 11_000_000, followOnMultiple: 1, dilutionFactor: 0.3 },
        { key: 'junk' },
      ],
    }, 2020)
    expect(a.stages).toHaveLength(1)
    expect(a.stages[0].key).toBe('seed')
  })

  it('expands legacy aggregate rows into one row per deal', () => {
    const a = parseAssumptions({
      stages: [{ key: 'seed', label: 'Seed', deals: 3, initialCheck: 500_000, initialPostMoney: 11_000_000, followOnMultiple: 1, dilutionFactor: 0.3 }],
    }, 2020)
    expect(a.stages).toHaveLength(3)
    expect(a.stages.map(s => s.key)).toEqual(['seed', 'seed__2', 'seed__3'])
    expect(a.stages.every(s => s.initialCheck === 500_000)).toBe(true)
  })

  it('keeps an incomplete stage through autosave without dividing by zero', () => {
    const a = parseAssumptions({
      stages: [{ key: 'x', label: 'X', initialCheck: 500_000, initialPostMoney: 0, followOnMultiple: 1, dilutionFactor: 0.3 }],
    }, 2020)
    expect(a.stages).toHaveLength(1)
    expect(constructionModel(ACT(), A({ stages: a.stages }), NOW).returns.stages[0].initialOwnership).toBe(0)
  })

  it('rejects a fee basis outside the CHECK constraint', () => {
    expect(parseAssumptions({ feeBasis: 'moon' }, 2020).feeBasis).toBe('committed')
  })

  it('validates per-deal return methods, dilution, and direct MOIC forecasts', () => {
    const parsed = parseAssumptions({
      positionForecasts: [{ companyId: 'company-1', forecastMoic: 3.5, additionalDilution: 0.2, returnMethod: 'moic' }],
      stages: [{
        key: 'seed', label: 'Seed', initialCheck: 500_000, initialPostMoney: 10_000_000,
        followOnMultiple: 0, dilutionFactor: 0, forecastMoic: 4, additionalDilution: 2,
        returnMethod: 'moic',
      }],
    }, null)
    expect(parsed.positionForecasts[0].forecastMoic).toBe(3.5)
    expect(parsed.positionForecasts[0].additionalDilution).toBe(0.2)
    expect(parsed.positionForecasts[0].returnMethod).toBe('moic')
    expect(parsed.stages[0].forecastMoic).toBe(4)
    expect(parsed.stages[0].additionalDilution).toBe(1)
    expect(parsed.stages[0].returnMethod).toBe('moic')
    expect(parseAssumptions({ positionForecasts: [{ companyId: 'company-1', returnMethod: 'invalid' }] }, null).positionForecasts[0].returnMethod).toBe('ownership')
  })
})

// Fund III, as the workbook states it. No future fee years are entered, so feesProjected is
// exactly 0 and the whole lifetime fee arrives as an incurred actual. The waterfall is then
// independent of fee-projection assumptions.
const NOW = new Date('2025-01-01')
const RUN_OUT = { feeTermYears: 0 } as const

const ACT = (over: Partial<ConstructionActuals> = {}): ConstructionActuals => ({
  committedCapital: 20_000_000,
  calledCapital: 12_000_000,
  uncalledCapital: 8_000_000,
  managementFeesIncurred: 3_650_000,     // workbook B53
  orgCostsIncurred: 50_000,              // workbook B51
  partnershipExpensesIncurred: 650_000,  // workbook B52
  ledgerAvailable: true,
  deployedInitial: 8_000_000,
  deployedFollowOn: 1_500_000,
  companyCount: 18,
  currentValue: 11_000_000,
  nav: 11_000_000,
  ...over,
})

describe('constructionModel — capital', () => {
  it('walks committed down to investable', () => {
    const m = constructionModel(ACT(), A(RUN_OUT), NOW)
    expect(m.capital.feesProjected).toBe(0)
    expect(m.capital.lifetimeFees).toBeCloseTo(3_650_000, 2)
    expect(m.capital.lifetimeExpenses).toBeCloseTo(700_000, 2)
    expect(m.capital.investable).toBeCloseTo(15_650_000, 2)  // workbook B54
    expect(m.capital.calledCapital).toBe(12_000_000)
    expect(m.capital.uncalledCapital).toBe(8_000_000)
    expect(m.capital.incurredExpenses).toBe(4_350_000)
    expect(m.capital.projectedExpenses).toBe(0)
    expect(m.capital.totalExpenses).toBe(4_350_000)
  })

  it('adds projected fees to incurred ones when the term is still running', () => {
    const running = constructionModel(ACT({ managementFeesIncurred: 1_800_000 }), A(), NOW)
    expect(running.capital.feesProjected).toBeGreaterThan(0)
    expect(running.capital.lifetimeFees).toBeCloseTo(1_800_000 + running.capital.feesProjected, 2)
    // More lifetime fees means less investable capital. That direction is the whole point.
    expect(running.capital.investable).toBeLessThan(20_000_000 - 1_800_000 - 700_000)
  })

  it('reports projected organizational costs separately from partnership expenses', () => {
    const m = constructionModel(ACT(), A({
      feeTermYears: 3,
      annualPartnershipExpense: 100_000, remainingOrgCosts: 250_000,
    }), NOW)
    expect(m.capital.orgCostsProjected).toBe(250_000)
    expect(m.capital.expensesProjected).toBe(300_000)
    expect(m.capital.lifetimeExpenses).toBeCloseTo(
      ACT().orgCostsIncurred + 250_000 + ACT().partnershipExpensesIncurred + m.capital.expensesProjected,
      2,
    )
  })

  it('remaining is investable less deployed capital', () => {
    const m = constructionModel(ACT(), A(RUN_OUT), NOW)
    // 15,650,000 − 9,500,000
    expect(m.capital.remaining).toBeCloseTo(6_150_000, 2)
    expect(m.capital.deployedTotal).toBe(9_500_000)
  })

  it('counts the deals still to do against the target portfolio size', () => {
    const m = constructionModel(ACT(), A({ ...RUN_OUT, targetPortfolioSize: 20 }), NOW)
    expect(m.capital.plannedNewDeals).toBe(2)
    expect(m.capital.avgPerRemainingDeal).toBeCloseTo(6_150_000 / 2, 2)
  })

  it('costs the stage mix and reports the gap', () => {
    // 2 seed deals × 500k × (1 + 1.0 follow-on) = 2M planned against 6,150,000 remaining.
    const stages = dealRows(2, { key: 'seed', label: 'Seed', initialCheck: 500_000, initialPostMoney: 11_000_000, followOnMultiple: 1, dilutionFactor: 0.3 })
    const m = constructionModel(ACT(), A({ ...RUN_OUT, stages, targetPortfolioSize: 20 }), NOW)
    expect(m.capital.plannedCost).toBe(2_000_000)
    expect(m.capital.gap).toBeCloseTo(4_150_000, 2)
    expect(m.warnings).toEqual([])
  })

  it('warns when the mix costs more than remains', () => {
    const stages = dealRows(2, { key: 'seed', label: 'Seed', initialCheck: 2_000_000, initialPostMoney: 11_000_000, followOnMultiple: 1, dilutionFactor: 0.3 })
    const m = constructionModel(ACT(), A({ ...RUN_OUT, stages, targetPortfolioSize: 20 }), NOW)
    expect(m.capital.gap).toBeLessThan(0)
    expect(m.warnings.some(w => w.includes('more capital than remains'))).toBe(true)
  })

  it('warns when the entered deals do not add up to the deals still to do', () => {
    const stages = dealRows(7, { key: 'seed', label: 'Seed', initialCheck: 100_000, initialPostMoney: 11_000_000, followOnMultiple: 0, dilutionFactor: 0.3 })
    const m = constructionModel(ACT(), A({ ...RUN_OUT, stages, targetPortfolioSize: 20 }), NOW)
    expect(m.warnings.some(w => w.includes('7 deals') && w.includes('2'))).toBe(true)
  })

  it('projects the full fee and expense term when historical actuals have no ledger', () => {
    const m = constructionModel(
      ACT({ ledgerAvailable: false, managementFeesIncurred: 0, orgCostsIncurred: 0, partnershipExpensesIncurred: 0 }),
      A({ ...RUN_OUT, feeTermYears: 10, annualPartnershipExpense: 100_000 }), NOW,
    )
    expect(m.capital.ledgerAvailable).toBe(false)
    // The entered horizon carries all 10 future years: 20M × 2% × 10, plus 100k × 10.
    expect(m.capital.feesProjected).toBe(4_000_000)
    expect(m.capital.expensesProjected).toBe(1_000_000)
    expect(m.capital.incurredExpenses).toBe(0)
    expect(m.capital.projectedExpenses).toBe(5_000_000)
    expect(m.warnings.some(w => w.includes('not on the ledger'))).toBe(true)
  })

  it('applies fee step-downs across the entered forecast horizon', () => {
    const m = constructionModel(
      ACT({ ledgerAvailable: false, managementFeesIncurred: 0, orgCostsIncurred: 0, partnershipExpensesIncurred: 0 }),
      A({ feeStartDate: '', feeStepDownYear: 6, feeStepDownRate: 0.015 }), NOW,
    )
    // Years 1–5 at 2%, then years 6–10 at 1.5%.
    expect(m.capital.feesProjected).toBe(3_500_000)
  })
})

describe('constructionModel — returns', () => {
  const MIX = [
    ...dealRows(5, { key: 'pre_seed', label: 'Pre-seed', initialCheck: 500_000, initialPostMoney: 7_000_000, followOnMultiple: 1, dilutionFactor: 0.3 }),
    ...dealRows(10, { key: 'seed', label: 'Seed', initialCheck: 500_000, initialPostMoney: 11_000_000, followOnMultiple: 1, dilutionFactor: 0.3 }),
    ...dealRows(5, { key: 'post_seed', label: 'Post-seed', initialCheck: 250_000, initialPostMoney: 20_000_000, followOnMultiple: 1, dilutionFactor: 0.4 }),
  ]

  it('derives initial and exit ownership per stage', () => {
    const m = constructionModel(ACT(), A({ ...RUN_OUT, stages: MIX }), NOW)
    const preSeed = m.returns.stages.find(s => s.key === 'pre_seed_1')!
    expect(preSeed.initialOwnership).toBeCloseTo(0.0714286, 6)   // 500k / 7M
    expect(preSeed.ownershipAtExit).toBeCloseTo(0.0214286, 6)    // × 0.3
    expect(preSeed.exitToReturnFund).toBeCloseTo(933_333_333, -3) // 20M / 0.0214286
    expect(preSeed.allocation).toBe(1_000_000)                    // one 500k check + one 500k follow-on
  })

  it('weights ownership at exit by deal count', () => {
    const m = constructionModel(ACT(), A({ ...RUN_OUT, stages: MIX }), NOW)
    // (0.0214286×5 + 0.0136364×10 + 0.005×5) / 20
    expect(m.returns.wAvgOwnershipAtExit).toBeCloseTo(0.0134253, 6)
  })

  it('computes the required portfolio value and the average exit that reaches it', () => {
    const m = constructionModel(ACT(), A({ ...RUN_OUT, stages: MIX, targetFundMultiple: 5, targetPortfolioSize: 20 }), NOW)
    expect(m.returns.requiredPortfolioValue).toBe(100_000_000)      // workbook B61
    expect(m.returns.avgExitForTargetReturn).toBeCloseTo(372_430_000, -4)  // workbook F63
  })

  it('states the multiple on invested alongside the multiple on committed', () => {
    const m = constructionModel(ACT(), A({ ...RUN_OUT, stages: MIX, targetFundMultiple: 5 }), NOW)
    // 100M / 15,650,000 investable — the number the portfolio actually has to clear.
    expect(m.returns.impliedMultipleOnInvested).toBeCloseTo(6.39, 2)
  })

  it('bands sensitivity one and two percentage points around the portfolio plan', () => {
    const stages = [{
      key: 'seed', label: 'Seed', initialCheck: 500_000, initialPostMoney: 10_000_000,
      followOnMultiple: 0, dilutionFactor: 0, ownershipAtExit: 0.05,
    }]
    const m = constructionModel(ACT(), A({ ...RUN_OUT, stages, targetFundMultiple: 5, targetPortfolioSize: 20 }), NOW)
    expect(m.returns.sensitivity.map(row => row.ownershipAtExit)).toEqual([0.03, 0.04, 0.05, 0.06, 0.07])
    expect(m.returns.sensitivity.find(row => row.isWeightedAverage)?.ownershipAtExit).toBe(0.05)
  })

  it('is null rather than Infinity when the mix has no deals', () => {
    const m = constructionModel(ACT(), A({ ...RUN_OUT, stages: [] }), NOW)
    expect(m.returns.wAvgOwnershipAtExit).toBeNull()
    expect(m.returns.avgExitForTargetReturn).toBeNull()
    expect(m.returns.exitToReturnFund).toBeNull()
    expect(m.returns.sensitivity.every(row => !row.isWeightedAverage)).toBe(true)
  })
})

describe('inline portfolio forecast', () => {
  const position = {
    companyId: 'company-1', name: 'Known Co', stage: 'Seed', status: 'active',
    investedInitial: 500_000, investedFollowOn: 100_000, investedTotal: 600_000,
    currentValue: 900_000, currentMoic: 1.5, currentOwnership: 0.03,
    currentPostMoney: 30_000_000, distributions: 0,
  }

  it('rolls company follow-ons and remaining deals into new/follow-on capital', () => {
    const m = constructionModel(ACT({ positions: [position] }), A({
      ...RUN_OUT,
      positionForecasts: [{ companyId: 'company-1', plannedFollowOn: 200_000, ownershipAtExit: 0.02, expectedExitValue: 100_000_000 }],
      stages: dealRows(2, {
        key: 'seed', label: 'Seed', initialCheck: 500_000,
        initialPostMoney: 10_000_000, followOnMultiple: 0, followOnCheck: 250_000,
        dilutionFactor: 0, ownershipAtExit: 0.02, expectedExitValue: 50_000_000,
      }),
    }), NOW)

    expect(m.capital.plannedExistingFollowOn).toBe(200_000)
    expect(m.capital.plannedNewCapital).toBe(1_000_000)
    expect(m.capital.plannedNewFollowOn).toBe(500_000)
    expect(m.capital.plannedCost).toBe(1_700_000)
    expect(m.capital.projectedNew).toBe(9_000_000)
    expect(m.capital.projectedFollowOn).toBe(2_200_000)
  })

  it('updates company, remaining-portfolio, and total return metrics from inline inputs', () => {
    const m = constructionModel(ACT({ positions: [position], currentValue: 900_000 }), A({
      ...RUN_OUT,
      positionForecasts: [{ companyId: 'company-1', plannedFollowOn: 200_000, ownershipAtExit: 0.02, expectedExitValue: 100_000_000 }],
      stages: dealRows(2, {
        key: 'seed', label: 'Seed', initialCheck: 500_000,
        initialPostMoney: 10_000_000, followOnMultiple: 0, followOnCheck: 250_000,
        dilutionFactor: 0, ownershipAtExit: 0.02, expectedExitValue: 50_000_000,
      }),
    }), NOW)

    expect(m.returns.positions[0].estimatedReturn).toBe(2_000_000)
    expect(m.returns.positions[0].estimatedMoic).toBe(2.5)
    expect(m.returns.estimatedExistingValue).toBe(2_000_000)
    expect(m.returns.estimatedFutureValue).toBe(2_000_000)
    expect(m.returns.estimatedPortfolioValue).toBe(4_000_000)
  })

  it('keeps realized proceeds separate from forecasted proceeds', () => {
    const partiallyRealized = { ...position, distributions: 300_000 }
    const m = constructionModel(ACT({ positions: [partiallyRealized] }), A({
      ...RUN_OUT,
      positionForecasts: [{ companyId: 'company-1', plannedFollowOn: 200_000, ownershipAtExit: 0.02, expectedExitValue: 100_000_000 }],
    }), NOW)
    expect(m.returns.positions[0].currentMoic).toBe(1.5)
    expect(m.returns.positions[0].actual.distributions).toBe(300_000)
    expect(m.returns.positions[0].estimatedReturn).toBe(2_000_000)
    expect(m.returns.positions[0].estimatedMoic).toBeCloseTo(2_300_000 / 800_000, 8)
    expect(m.returns.forecastedTotalValue).toBe(2_300_000)
    expect(m.returns.estimatedNetMoic).toBeCloseTo(2_300_000 / 20_000_000, 8)
  })

  it('uses direct MOIC independently for each existing and planned company', () => {
    const m = constructionModel(ACT({ positions: [position] }), A({
      ...RUN_OUT,
      positionForecasts: [{ companyId: 'company-1', plannedFollowOn: 200_000, ownershipAtExit: 0.02, expectedExitValue: 100_000_000, forecastMoic: 3, returnMethod: 'moic' }],
      stages: [{
        key: 'seed', label: 'Seed', initialCheck: 500_000, initialPostMoney: 10_000_000,
        followOnMultiple: 0, followOnCheck: 250_000, dilutionFactor: 0,
        ownershipAtExit: 0.02, expectedExitValue: 50_000_000, forecastMoic: 4, returnMethod: 'moic',
      }],
    }), NOW)
    expect(m.returns.positions[0].estimatedReturn).toBe(2_400_000)
    expect(m.returns.positions[0].estimatedMoic).toBe(3)
    expect(m.returns.stages[0].estimatedReturn).toBe(3_000_000)
    expect(m.returns.stages[0].estimatedMoic).toBe(4)
    expect(m.returns.estimatedPortfolioValue).toBe(5_400_000)
    expect(m.returns.estimatedNetMoic).toBeCloseTo(5_400_000 / 20_000_000, 8)
  })

  it('uses the fund-wide exit multiple without requiring a company input', () => {
    const m = constructionModel(ACT({ positions: [position] }), A({ ...RUN_OUT }), NOW)
    const result = m.returns.positions[0]
    expect(result.estimatedReturn).toBe(1_800_000)
    expect(result.estimatedMoic).toBe(3)
    expect(result.forecastExitValue).toBe(30_000_000)
    expect(result.forecast.ownershipAtExit).toBe(0.03)
    expect(result.forecast.additionalDilution).toBe(0)
  })

  it('calculates forecast ownership and required fund-return exit from additional dilution', () => {
    const m = constructionModel(ACT({ positions: [position] }), A({
      ...RUN_OUT,
      positionForecasts: [{
        companyId: 'company-1', plannedFollowOn: 0, ownershipAtExit: 0,
        additionalDilution: 0.25, expectedExitValue: 100_000_000, returnMethod: 'ownership',
      }],
    }), NOW)
    const result = m.returns.positions[0]
    expect(result.forecast.ownershipAtExit).toBeCloseTo(0.0225, 8)
    expect(result.estimatedReturn).toBe(2_250_000)
    expect(result.exitToReturnFund).toBeCloseTo(20_000_000 / 0.0225, 2)
    expect(result.estimatedMoic).toBe(3.75)
  })

  it('shows net MOIC for each ownership sensitivity scenario', () => {
    const partiallyRealized = { ...position, distributions: 300_000 }
    const m = constructionModel(ACT({ positions: [partiallyRealized] }), A({
      ...RUN_OUT,
      positionForecasts: [{ companyId: 'company-1', plannedFollowOn: 0, ownershipAtExit: 0.02, expectedExitValue: 100_000_000 }],
    }), NOW)
    const base = m.returns.sensitivity.find(row => row.isWeightedAverage)!
    const upside = m.returns.sensitivity.find(row => row.ownershipAtExit === 0.04)!
    expect(base.netMoic).toBeCloseTo(2_300_000 / 20_000_000, 8)
    expect(upside.netMoic).toBeCloseTo(4_300_000 / 20_000_000, 8)
  })

  it('keeps direct inline dollar and ownership inputs through validation', () => {
    const parsed = parseAssumptions({
      positionForecasts: [{ companyId: 'company-1', plannedFollowOn: 200_000, ownershipAtExit: 0.02, expectedExitValue: 100_000_000 }],
      stages: [{
        key: 'seed', label: 'Seed', deals: 2, initialCheck: 500_000,
        initialPostMoney: 10_000_000, followOnMultiple: 0, followOnCheck: 250_000,
        dilutionFactor: 0, ownershipAtExit: 0.02, expectedExitValue: 50_000_000,
      }],
    }, null)
    expect(parsed.positionForecasts[0].plannedFollowOn).toBe(200_000)
    expect(parsed.stages).toHaveLength(2)
    expect(parsed.stages[0].followOnCheck).toBe(250_000)
    expect(parsed.stages[0].ownershipAtExit).toBe(0.02)
    expect(parsed.stages[0].expectedExitValue).toBe(50_000_000)
  })

  it('starts each planned deal at cost and a 1.00x current MOIC', () => {
    const m = constructionModel(ACT(), A({
      ...RUN_OUT,
      stages: [{
        key: 'seed', label: 'Seed', initialCheck: 500_000,
        initialPostMoney: 10_000_000, followOnMultiple: 0, followOnCheck: 250_000,
        dilutionFactor: 0, ownershipAtExit: 0.02, expectedExitValue: 50_000_000,
      }],
    }), NOW)
    expect(m.returns.stages[0].currentValue).toBe(750_000)
    expect(m.returns.stages[0].currentMoic).toBe(1)
  })

  it('uses recorded gross proceeds for exited companies and ignores stale forecasts', () => {
    const exited = {
      ...position, status: 'exited', currentValue: 2_000_000, distributions: 1_200_000,
    }
    const m = constructionModel(ACT({ positions: [exited], currentValue: 2_000_000 }), A({
      ...RUN_OUT,
      positionForecasts: [{ companyId: 'company-1', plannedFollowOn: 200_000, ownershipAtExit: 0.02, expectedExitValue: 100_000_000 }],
    }), NOW)
    expect(m.returns.positions[0].currentValue).toBe(0)
    expect(m.returns.positions[0].currentMoic).toBe(2)
    expect(m.returns.positions[0].estimatedReturn).toBeNull()
    expect(m.returns.positions[0].estimatedMoic).toBe(2)
    expect(m.returns.positions[0].exitToReturnFund).toBeNull()
    expect(m.returns.positions[0].forecast.plannedFollowOn).toBe(0)
    expect(m.capital.plannedExistingFollowOn).toBe(0)
    expect(m.returns.currentPortfolioValue).toBe(0)
    expect(m.returns.estimatedExistingValue).toBe(0)
    expect(m.returns.forecastedTotalValue).toBe(1_200_000)
    expect(m.returns.estimatedNetMoic).toBeCloseTo(1_200_000 / 20_000_000, 8)
  })
})

// The model this replaces, end to end. If these drift, the page and the GP's spreadsheet
// disagree about the same fund — the failure that matters most.
describe('Fund III, against the source workbook', () => {
  it('reproduces the investable-capital and return figures', () => {
    const m = constructionModel(
      ACT(),
      A({
        ...RUN_OUT,
        stages: [
          ...dealRows(5, { key: 'pre_seed', label: 'Pre-seed', initialCheck: 500_000, initialPostMoney: 7_000_000, followOnMultiple: 1, dilutionFactor: 0.3 }),
          ...dealRows(10, { key: 'seed', label: 'Seed', initialCheck: 500_000, initialPostMoney: 11_000_000, followOnMultiple: 1, dilutionFactor: 0.3 }),
          ...dealRows(5, { key: 'post_seed', label: 'Post-seed', initialCheck: 250_000, initialPostMoney: 20_000_000, followOnMultiple: 1, dilutionFactor: 0.4 }),
        ],
        targetFundMultiple: 5,
        targetPortfolioSize: 20,
      }),
      NOW,
    )
    expect(m.capital.investable).toBeCloseTo(15_650_000, 2)         // workbook B54
    expect(m.returns.requiredPortfolioValue).toBe(100_000_000)        // workbook B61
    expect(m.returns.wAvgOwnershipAtExit).toBeCloseTo(0.0134, 4)     // workbook G71 / F62
    expect(m.returns.exitToReturnFund).toBeCloseTo(1_489_721_886, -4) // workbook F64
    expect(m.returns.sensitivity.find(row => row.isWeightedAverage)?.exitToReturnFund)
      .toBeCloseTo(m.returns.exitToReturnFund!, 2)
  })
})

// An unconfigured vehicle must read as unanswered, not as a fund in trouble. Shouting at someone
// who has not filled the form in yet trains them to ignore the warnings that matter.
describe('an unplanned vehicle', () => {
  const BLANK = () => constructionModel(ACT(), parseAssumptions(null, null), NOW)

  it('reports no deal count rather than a negative one', () => {
    // targetPortfolioSize 0 − 18 companies would be −18, which is not a fact about anything.
    expect(BLANK().capital.plannedNewDeals).toBeNull()
    expect(BLANK().capital.avgPerRemainingDeal).toBeNull()
  })

  it('reports no gap rather than claiming the whole fund is unspent', () => {
    expect(BLANK().capital.gap).toBeNull()
  })

  it('reports no required portfolio value rather than zero', () => {
    const m = BLANK()
    expect(m.returns.requiredPortfolioValue).toBeNull()
    expect(m.returns.impliedMultipleOnInvested).toBeNull()
    expect(m.returns.avgExitForTargetReturn).toBeNull()
    expect(m.returns.sensitivity.every(row => row.avgExitForTargetReturn === null)).toBe(true)
  })

  it('raises no stage-mix warnings at all', () => {
    expect(BLANK().warnings).toEqual([])
  })

  it('still reports what IS known — capital committed, deployed and investable', () => {
    const m = BLANK()
    expect(m.capital.committedCapital).toBe(20_000_000)
    expect(m.capital.deployedTotal).toBe(9_500_000)
    expect(m.capital.companyCount).toBe(18)
    // No fee terms stated, so nothing is projected — only what the ledger actually incurred.
    expect(m.capital.feesProjected).toBe(0)
    expect(m.capital.investable).toBeCloseTo(15_650_000, 2)
  })
})

describe('blankStage', () => {
  it('is empty apart from its label and survives autosave before it is priced', () => {
    const s = blankStage('Seed')
    expect(s.label).toBe('Seed')
    expect(s.initialCheck).toBe(0)
    expect(parseAssumptions({ stages: [s] }, null).stages).toHaveLength(1)
    expect(parseAssumptions({ stages: [{ ...s, initialPostMoney: 10_000_000 }] }, null).stages).toHaveLength(1)
  })

  it('gives each row a distinct key, so React keys and edits do not collide', () => {
    expect(blankStage().key).not.toBe(blankStage().key)
  })
})

describe('valueSources', () => {
  const position = {
    companyId: 'company-1', name: 'Known Co', stage: 'Seed', status: 'active',
    investedInitial: 500_000, investedFollowOn: 100_000, investedTotal: 600_000,
    currentValue: 900_000, currentMoic: 1.5, currentOwnership: 0.03,
    currentPostMoney: 30_000_000, distributions: 0,
  }

  // The invariant the chart depends on: the three sources ARE the forecasted total value, so a
  // stacked bar of them cannot disagree with the MOIC printed above it.
  it('splits forecasted total value into realized, cost still at work, and forecast gain', () => {
    const m = constructionModel(ACT({ positions: [position] }), A({
      ...RUN_OUT,
      positionForecasts: [{ companyId: 'company-1', plannedFollowOn: 200_000, ownershipAtExit: 0.02, expectedExitValue: 100_000_000 }],
      stages: dealRows(2, {
        key: 'seed', label: 'Seed', initialCheck: 500_000,
        initialPostMoney: 10_000_000, followOnMultiple: 0, followOnCheck: 250_000,
        dilutionFactor: 0, ownershipAtExit: 0.02, expectedExitValue: 50_000_000,
      }),
    }), NOW)
    const v = valueSources(m)

    // Cost at work = the live position's invested + its planned follow-on, plus both planned deals.
    expect(v.investedAtWork).toBe(600_000 + 200_000 + 750_000 * 2)
    expect(v.realizedProceeds).toBe(0)
    expect(v.total).toBe(m.returns.forecastedTotalValue)
    expect(v.realizedProceeds + v.investedAtWork + v.forecastGain).toBeCloseTo(v.total, 6)
  })

  // An exited company's capital is not "at work" — its whole contribution is realized proceeds,
  // and counting its cost again would double-count it against a forecast it no longer has.
  it('counts an exited company only through its realized proceeds', () => {
    const exited = { ...position, status: 'exited', currentValue: 2_000_000, distributions: 1_200_000 }
    const m = constructionModel(ACT({ positions: [exited], currentValue: 2_000_000 }), A(RUN_OUT), NOW)
    const v = valueSources(m)

    expect(v.realizedProceeds).toBe(1_200_000)
    expect(v.investedAtWork).toBe(0)
    expect(v.forecastGain).toBe(0)
    expect(v.total).toBe(m.returns.forecastedTotalValue)
  })

  // A marked-down book reports a NEGATIVE gain rather than a quietly floored zero. The chart
  // clamps for display; the model does not lie about the direction.
  it('reports a negative gain when the forecast is below cost', () => {
    const underwater = { ...position, currentValue: 200_000 }
    const m = constructionModel(ACT({ positions: [underwater] }), A({
      ...RUN_OUT,
      positionForecasts: [{
        companyId: 'company-1', plannedFollowOn: 0, ownershipAtExit: 0,
        expectedExitValue: 0, forecastMoic: 0.2, returnMethod: 'moic',
      }],
    }), NOW)
    const v = valueSources(m)

    expect(v.investedAtWork).toBe(600_000)
    expect(v.forecastGain).toBeLessThan(0)
    expect(v.realizedProceeds + v.investedAtWork + v.forecastGain).toBeCloseTo(v.total, 6)
  })

  it('keeps an explicit 0x override instead of replacing it with the fund default', () => {
    const m = constructionModel(ACT({ positions: [position] }), A({
      ...RUN_OUT,
      positionForecasts: [{
        companyId: 'company-1', plannedFollowOn: 0, ownershipAtExit: 0,
        expectedExitValue: 0, forecastMoic: 0, forecastMoicOverride: true, returnMethod: 'moic',
      }],
    }), NOW)

    expect(m.returns.positions[0].forecast.forecastMoic).toBe(0)
    expect(m.returns.positions[0].estimatedReturn).toBe(0)
    expect(m.returns.positions[0].estimatedMoic).toBe(0)
  })

  it('is all zeroes for an unplanned vehicle', () => {
    const m = constructionModel(ACT({ positions: [] }), A(RUN_OUT), NOW)
    expect(valueSources(m)).toEqual({ realizedProceeds: 0, investedAtWork: 0, forecastGain: 0, total: 0 })
  })
})
