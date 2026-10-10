import { describe, it, expect } from 'vitest'
import { constructionModel, DEFAULT_ASSUMPTIONS, type ConstructionActuals, type ConstructionAssumptions } from './construction'
import { applyLpWaterfall, forecastSchedule, dealTimelines, irrOf, DEFAULT_PACING, type PacingAssumptions, type ForecastBaseline } from './construction-forecast'

const actuals = (over: Partial<ConstructionActuals> = {}): ConstructionActuals => ({
  committedCapital: 10_000_000,
  calledCapital: 3_000_000,
  uncalledCapital: 7_000_000,
  managementFeesIncurred: 400_000,
  orgCostsIncurred: 50_000,
  partnershipExpensesIncurred: 50_000,
  ledgerAvailable: true,
  deployedInitial: 2_000_000,
  deployedFollowOn: 0,
  companyCount: 2,
  currentValue: 3_000_000,
  nav: 3_100_000,
  positions: [
    { companyId: 'c1', name: 'Alpha', stage: 'Seed', status: 'active', investedInitial: 1_000_000, investedFollowOn: 0, investedTotal: 1_000_000, currentValue: 2_000_000, currentMoic: 2, currentOwnership: 0.1, currentPostMoney: 20_000_000, distributions: 0 },
    { companyId: 'c2', name: 'Beta', stage: 'Seed', status: 'active', investedInitial: 1_000_000, investedFollowOn: 0, investedTotal: 1_000_000, currentValue: 1_000_000, currentMoic: 1, currentOwnership: 0.1, currentPostMoney: 10_000_000, distributions: 0 },
  ],
  ...over,
})

const assumptions = (over: Partial<ConstructionAssumptions> = {}): ConstructionAssumptions => ({
  ...DEFAULT_ASSUMPTIONS,
  feeAnnualRate: 0.02,
  feeTermYears: 5,
  annualPartnershipExpense: 20_000,
  positionForecasts: [
    { companyId: 'c1', plannedFollowOn: 500_000, ownershipAtExit: 0.1, expectedExitValue: 50_000_000, returnMethod: 'ownership', followOnInYears: 1 }, // 5m
    { companyId: 'c2', plannedFollowOn: 0, ownershipAtExit: 0, forecastMoic: 0, expectedExitValue: 0, returnMethod: 'moic' }, // defaults to the fund-wide 3x
  ],
  stages: [
    { key: 's1', label: 'Deal A', initialCheck: 1_000_000, initialPostMoney: 10_000_000, followOnMultiple: 0, followOnCheck: 500_000, dilutionFactor: 0.5, forecastMoic: 3, returnMethod: 'moic', investInYears: 0.5, followOnInYears: 1 }, // 4.5m
    { key: 's2', label: 'Deal B', initialCheck: 1_000_000, initialPostMoney: 10_000_000, followOnMultiple: 0, followOnCheck: 0, dilutionFactor: 0.5, forecastMoic: 0, returnMethod: 'moic', investInYears: 1.5 }, // fund-wide 3x = 3m
  ],
  ...over,
})

const pacing = (over: Partial<PacingAssumptions> = {}): PacingAssumptions => ({
  ...DEFAULT_PACING, deploymentYears: 2, followOnLagYears: 1, holdYears: 5, existingHoldYears: 4, horizonYears: 0, accretion: 'none', ...over,
})

const baseline: ForecastBaseline = { asOf: '2026-09-18', calledCapital: 3_000_000, distributed: 0, nav: 3_100_000 }

describe('dealTimelines', () => {
  it('uses each planned deal’s own timing and holds it for the stated years', () => {
    const model = constructionModel(actuals(), assumptions())
    const deals = dealTimelines(model, pacing())
    const planned = deals.filter(d => d.kind === 'planned')
    expect(planned.map(d => d.initialAt)).toEqual([0.5, 1.5])
    expect(planned.map(d => d.exitAt)).toEqual([5.5, 6.5])
    expect(planned[0].followOnAt).toBe(1.5)
    const existing = deals.filter(d => d.kind === 'existing')
    expect(existing.every(d => d.exitAt === 4)).toBe(true)
    expect(existing[0].followOnAt).toBe(1)
  })

  it('omits a planned deal without individual investment timing', () => {
    const model = constructionModel(actuals(), assumptions({ stages: [{ ...assumptions().stages[0], investInYears: undefined }] }))
    expect(dealTimelines(model, pacing()).filter(d => d.kind === 'planned')).toEqual([])
    expect(forecastSchedule(model, assumptions({ stages: [{ ...assumptions().stages[0], investInYears: undefined }] }), pacing(), baseline).warnings.join(' ')).toMatch(/need.*investment timing/i)
  })

  it('anchors each existing deal to its known investment date and uses the hold period', () => {
    const positions = actuals().positions!.map((position, index) => ({
      ...position,
      firstInvestmentDate: index === 0 ? '2022-09-18' : '2024-09-18',
    }))
    const model = constructionModel(actuals({ positions }), assumptions())
    const existing = dealTimelines(model, pacing({ holdYears: 6, existingHoldYears: 6 }), baseline.asOf)
      .filter(d => d.kind === 'existing')
    expect(existing[0].initialAt).toBeCloseTo(-4, 2)
    expect(existing[0].exitAt).toBeCloseTo(2, 2)
    expect(existing[1].initialAt).toBeCloseTo(-2, 2)
    expect(existing[1].exitAt).toBeCloseTo(4, 2)
  })

  it('treats a company exit override as its hold period when its investment date is known', () => {
    const positions = actuals().positions!.map(position => ({ ...position, firstInvestmentDate: '2022-09-18' }))
    const configured = assumptions({
      positionForecasts: assumptions().positionForecasts.map(forecast => forecast.companyId === 'c1' ? { ...forecast, exitInYears: 6 } : forecast),
    })
    const model = constructionModel(actuals({ positions }), configured)
    const alpha = dealTimelines(model, pacing(), baseline.asOf).find(deal => deal.key === 'c1')!
    expect(alpha.exitAt).toBeCloseTo(2, 2)
  })

  it('keeps an explicit zero-year hold instead of replacing it with the fund default', () => {
    const configured = assumptions({
      stages: assumptions().stages.map(stage => stage.key === 's1' ? { ...stage, exitInYears: 0 } : stage),
      positionForecasts: assumptions().positionForecasts.map(forecast => forecast.companyId === 'c1' ? { ...forecast, exitInYears: 0 } : forecast),
    })
    const model = constructionModel(actuals(), configured)
    const deals = dealTimelines(model, pacing(), baseline.asOf)

    expect(deals.find(deal => deal.key === 's1')?.exitAt).toBe(0.5)
    expect(deals.find(deal => deal.key === 'c1')?.exitAt).toBe(0)
    expect(deals.find(deal => deal.key === 'c1')?.timing).toBe('stated')
  })
})

describe('forecastSchedule', () => {
  it('runs to the last exit, calls capital as it is needed, and returns proceeds in the exit year', () => {
    const model = constructionModel(actuals(), assumptions())
    const s = forecastSchedule(model, assumptions(), pacing(), baseline)
    expect(s.stated).toBe(true)
    expect(s.horizonYears).toBe(7)
    expect(s.years).toHaveLength(8)
    // Year 1: Deal A's check (0.5y) and both existing follow-ons (1y); fees 2% × 10m; expenses 20k.
    const y1 = s.years[1]
    expect(y1.invested).toBe(1_500_000)
    expect(y1.fees).toBe(200_000)
    expect(y1.expenses).toBe(20_000)
    // Called capital less deployed capital and incurred expenses leaves 500k of cash to spend first.
    expect(y1.called).toBe(1_720_000 - 500_000)
    // Year 4: the existing book exits — Alpha 5m, Beta at the fund-wide 3x default.
    // Same-year fees and expenses are paid from exit proceeds, rather than requiring a call.
    expect(s.years[4].distributed).toBe(7_780_000)
    expect(s.years[4].called).toBe(0)
    // Year 6: Deal A exits at 3× its 1.5m; year 7: Deal B at the 3x default.
    expect(s.years[6].distributed).toBe(4_500_000)
    expect(s.years[7].distributed).toBe(3_000_000)
    expect(s.years[7].nav).toBe(0)
    expect(s.years[7].dpi).toBeCloseTo(15_280_000 / s.years[7].cumCalled, 6)
    expect(s.years[7].tvpi).toBe(s.years[7].dpi)
    expect(s.years[7].netIrr).toBeGreaterThan(0)
    expect(s.warnings).toEqual([])
  })

  it('stops charging fees after the fee term and expenses with it', () => {
    const model = constructionModel(actuals(), assumptions())
    const s = forecastSchedule(model, assumptions(), pacing(), baseline)
    expect(s.years[5].fees).toBe(200_000)
    expect(s.years[6].fees).toBe(0)
    expect(s.years[6].expenses).toBe(0)
  })

  it('ends recurring costs at liquidation and pays final wind-down costs from proceeds', () => {
    const longFeeTerm = assumptions({ feeTermYears: 12 })
    const model = constructionModel(actuals(), longFeeTerm)
    const s = forecastSchedule(model, longFeeTerm, pacing({ horizonYears: 10 }), baseline)
    expect(s.years[7].fees).toBe(200_000)
    expect(s.years[7].expenses).toBe(20_000)
    expect(s.years[7].distributed).toBe(2_780_000)
    expect(s.years[7].called).toBe(0)
    expect(s.years[8].fees).toBe(0)
    expect(s.years[8].expenses).toBe(0)
    expect(s.years[8].called).toBe(0)
  })

  it('leaves capital sufficiency to the investment plan instead of adding a timeline warning', () => {
    const model = constructionModel(actuals({ committedCapital: 4_000_000, uncalledCapital: 1_000_000 }), assumptions())
    const s = forecastSchedule(model, assumptions(), pacing(), baseline)
    expect(model.warnings.some(w => w.includes('more capital than remains'))).toBe(true)
    expect(s.warnings.some(w => w.includes('more than the fund can still call'))).toBe(false)
  })

  it('reports LP-only DPI and TVPI after applying the vehicle waterfall', () => {
    const model = constructionModel(actuals(), assumptions())
    const gross = forecastSchedule(model, assumptions(), pacing(), baseline)
    const net = applyLpWaterfall(gross, {
      asOf: baseline.asOf,
      kind: 'straight', carryRate: 0.2, prefRate: 0, catchupRate: 1, prefCompounds: true,
      lpCommitmentShare: 1, lpCalledCapital: baseline.calledCapital, lpDistributedCapital: 0,
      fundDistributedCapital: 0, lpNav: baseline.nav, contributions: [{ date: '2024-01-01', amount: baseline.calledCapital }],
    })
    expect(net.years.at(-1)!.dpi!).toBeLessThan(gross.years.at(-1)!.dpi!)
    expect(net.years.at(-1)!.tvpi).toBe(net.years.at(-1)!.dpi)
    expect(net.years.some(year => (year.carriedInterest ?? 0) > 0)).toBe(true)
    expect(net.years.at(-1)!.netIrr).toBeGreaterThan(0)
  })

  it("charges carry on the LPs' share only — the GP's own stake bears none", () => {
    const model = constructionModel(actuals(), assumptions())
    const gross = forecastSchedule(model, assumptions(), pacing(), baseline)
    const terms = (share: number) => ({
      asOf: baseline.asOf,
      kind: 'european' as const, carryRate: 0.2, prefRate: 0, catchupRate: 1, prefCompounds: true,
      lpCommitmentShare: share, lpCalledCapital: baseline.calledCapital * share, lpDistributedCapital: 0,
      fundDistributedCapital: 0, lpNav: baseline.nav * share, contributions: [{ date: '2024-01-01', amount: baseline.calledCapital * share }],
    })
    const carry = (share: number) => applyLpWaterfall(gross, terms(share)).years.reduce((s, y) => s + (y.carriedInterest ?? 0), 0)
    // A GP with 1% of commitments: carry is 99% of what it would be on the whole fund.
    expect(carry(0.99)).toBeCloseTo(carry(1) * 0.99, 0)
  })

  it('charges management fees on the fee-paying commitments only', () => {
    const all = constructionModel(actuals(), assumptions())
    const exempt = constructionModel(actuals({ feePayingShare: 0.99 }), assumptions())
    expect(exempt.capital.feesProjected).toBeCloseTo(all.capital.feesProjected * 0.99, 0)
  })

  it('a horizon shorter than the last exit leaves deals in NAV and says so', () => {
    const model = constructionModel(actuals(), assumptions())
    const s = forecastSchedule(model, assumptions(), pacing({ horizonYears: 5 }), baseline)
    expect(s.years).toHaveLength(6)
    expect(s.years[5].nav).toBeGreaterThan(0)
    expect(s.warnings.some(w => w.includes('after the 5-year horizon'))).toBe(true)
  })

  it('linear accretion marks NAV toward the forecast between now and the exit', () => {
    const model = constructionModel(actuals(), assumptions())
    const flat = forecastSchedule(model, assumptions(), pacing({ accretion: 'none' }), baseline)
    const accreting = forecastSchedule(model, assumptions(), pacing({ accretion: 'linear' }), baseline)
    expect(accreting.years[2].nav).toBeGreaterThan(flat.years[2].nav)
    // Both agree once everything has exited.
    expect(accreting.years[7].tvpi).toBe(flat.years[7].tvpi)
    expect(accreting.years[7].cumDistributed).toBe(flat.years[7].cumDistributed)
  })

  it('an override replaces a deal’s proceeds and exit year and nothing else', () => {
    const model = constructionModel(actuals(), assumptions())
    const s = forecastSchedule(model, assumptions(), pacing(), baseline, new Map([['s1', { proceeds: 0, exitAt: 3 }]]))
    expect(s.years[6].distributed).toBe(0)
    expect(s.years[3].distributed).toBe(0) // a write-off returns nothing
    expect(s.years[1].invested).toBe(1_500_000) // the check is still written
  })

  it('can still represent a deliberately unstated pacing plan', () => {
    const unstated = assumptions({ stages: [] })
    const model = constructionModel(actuals(), unstated)
    const empty = { ...DEFAULT_PACING, deploymentYears: 0, followOnLagYears: 0, holdYears: 0, existingHoldYears: 0 }
    expect(forecastSchedule(model, unstated, empty, baseline).stated).toBe(false)
  })
})

describe('irrOf', () => {
  it('finds the rate that doubles money in five years', () => {
    expect(irrOf([{ t: 0, amount: -100 }, { t: 5, amount: 200 }])).toBeCloseTo(Math.pow(2, 1 / 5) - 1, 6)
  })
  it('is null without a sign change or a time spread', () => {
    expect(irrOf([{ t: 0, amount: -100 }, { t: 1, amount: -50 }])).toBeNull()
    expect(irrOf([{ t: 0, amount: -100 }, { t: 0, amount: 100 }])).toBeNull()
  })
  it('uses the dated history when the baseline carries it', () => {
    const model = constructionModel(actuals(), assumptions())
    const dated = forecastSchedule(model, assumptions(), pacing(), { ...baseline, historyFlows: [{ t: -3, amount: -3_000_000 }] })
    const lump = forecastSchedule(model, assumptions(), pacing(), baseline)
    // Money called three years ago earns the same multiple over a longer time: a lower IRR.
    expect(dated.years[7].netIrr!).toBeLessThan(lump.years[7].netIrr!)
  })
})

describe('per-deal timing', () => {
  it('a company’s own exit year and follow-on timing win over the fund-wide pacing', () => {
    const model = constructionModel(actuals(), assumptions({
      positionForecasts: [
        { companyId: 'c1', plannedFollowOn: 500_000, ownershipAtExit: 0.1, expectedExitValue: 50_000_000, returnMethod: 'ownership', exitInYears: 2, followOnInYears: 0.5 },
        { companyId: 'c2', plannedFollowOn: 0, ownershipAtExit: 0, forecastMoic: 0, expectedExitValue: 0, returnMethod: 'moic' },
      ],
    }))
    const deals = dealTimelines(model, pacing())
    const alpha = deals.find(d => d.key === 'c1')!
    const beta = deals.find(d => d.key === 'c2')!
    expect(alpha).toMatchObject({ exitAt: 2, followOnAt: 0.5, timing: 'stated' })
    expect(beta).toMatchObject({ exitAt: 4, timing: 'pacing' })
    const s = forecastSchedule(model, assumptions(), pacing(), baseline)
    expect(s.years[2].distributed).toBe(4_780_000)
    expect(s.years[4].distributed).toBe(2_780_000)
  })

  it('a planned deal’s own investment year and hold win over the spread', () => {
    const model = constructionModel(actuals(), assumptions({
      stages: [
        { key: 's1', label: 'Deal A', initialCheck: 1_000_000, initialPostMoney: 10_000_000, followOnMultiple: 0, followOnCheck: 500_000, dilutionFactor: 0.5, forecastMoic: 3, returnMethod: 'moic', investInYears: 3, exitInYears: 2, followOnInYears: 1 },
      ],
    }))
    const [deal] = dealTimelines(model, pacing()).filter(d => d.kind === 'planned')
    expect(deal).toMatchObject({ initialAt: 3, followOnAt: 4, exitAt: 5, timing: 'stated' })
  })

  it('a stated per-deal exit makes the schedule stated even with no fund-wide pacing', () => {
    const model = constructionModel(actuals(), assumptions({
      positionForecasts: [{ companyId: 'c1', plannedFollowOn: 0, ownershipAtExit: 0.1, expectedExitValue: 50_000_000, returnMethod: 'ownership', exitInYears: 3 }],
    }))
    expect(forecastSchedule(model, assumptions(), DEFAULT_PACING, baseline).stated).toBe(true)
  })

  it('carries per-deal simulation overrides onto the timeline', () => {
    const model = constructionModel(actuals(), assumptions({
      positionForecasts: [{ companyId: 'c1', plannedFollowOn: 0, ownershipAtExit: 0.1, expectedExitValue: 50_000_000, returnMethod: 'ownership', simLossRate: 0.1, simDispersion: 0.5, simExitSpreadYears: 1 }],
    }))
    const alpha = dealTimelines(model, pacing()).find(d => d.key === 'c1')!
    expect(alpha).toMatchObject({ lossRate: 0.1, dispersion: 0.5, exitSpreadYears: 1 })
    const beta = dealTimelines(model, pacing()).find(d => d.key === 'c2')!
    expect(beta.lossRate).toBeUndefined()
  })
})
