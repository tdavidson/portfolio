import { describe, expect, it } from 'vitest'
import {
  carryTarget,
  carryTermsFromRow,
  datedContributions,
  replayWaterfallState,
  runWaterfall,
  splitDistribution,
  type VehicleCarryTerms,
} from '../src/index.ts'

const straight = (over: Partial<VehicleCarryTerms> = {}): VehicleCarryTerms => ({
  kind: 'straight', carryRate: 0.2, prefRate: 0, catchupRate: 1, catchupSize: 1, prefCompounds: true,
  prefBase: 'contributed', gpEntityId: 'gp', recipients: [{ lpEntityId: 'gp', pct: 100 }], ...over,
})

describe('carry that steps up', () => {
  it('runs 20% until the LPs have 2x, then 30%', () => {
    // 1,000 in and 4,000 back: 1,250 at 20% takes the LPs to 2,000, the last 1,750 splits 1,225/525.
    const r = runWaterfall(4000, { carryRate: 0.2, steps: [{ lpMultiple: 2, carryRate: 0.3 }] }, {
      contributedCapital: 1000, returnedCapital: 0, preferredPaid: 0, preferredTarget: 0, gpCarryPaid: 0,
    })
    expect(r.toReturnOfCapital).toBe(1000)
    expect(r.bands).toEqual([
      { carryRate: 0.2, catchUp: 0, catchUpToLP: 0, toLP: 1000, toGP: 250 },
      { carryRate: 0.3, catchUp: 0, catchUpToLP: 0, toLP: 1225, toGP: 525 },
    ])
    expect(r.toGP).toBe(775)
  })

  it('keeps a split going past an IRR step only when the dated cash is supplied', () => {
    const terms = { carryRate: 0.2, steps: [{ lpIrr: 0.1, carryRate: 0.3 }] }
    const base = { contributedCapital: 1000, returnedCapital: 0, preferredPaid: 0, preferredTarget: 0, gpCarryPaid: 0 }
    expect(runWaterfall(3000, terms, base).bands![1].toGP).toBe(0)
    const dated = runWaterfall(3000, terms, {
      ...base,
      irr: { asOf: '2027-01-01', contributions: [{ date: '2025-01-01', amount: 1000 }], lpDistributions: [] },
    })
    // 1,000 × 1.1^2 is what the LPs need, and they need it before the step.
    const need = 1000 * Math.pow(1.1, 2)
    expect(dated.toReturnOfCapital + dated.bands![0].toLP).toBeCloseTo(need, 1)
    expect(dated.bands![1].toGP).toBeGreaterThan(0)
  })

  it('accrues the stepped carry in the close', () => {
    const terms = straight({ carrySteps: [{ lpMultiple: 2, carryRate: 0.3 }] })
    const target = carryTarget({
      lps: [{ lpEntityId: 'lp', contributed: 1000, distributed: 0, nav: 4000 }],
      contributions: [{ date: '2025-01-01', amount: 1000 }],
      asOf: '2030-01-01',
    }, terms)
    expect(target).toBe(775)
  })

  describe('a step catch-up measured on the split', () => {
    // A half-size first catch-up, 20% until the LPs have 2.5x, then a 100% catch-up to 30% of what
    // the 20% split paid, then 30%.
    const terms = {
      carryRate: 0.2, catchUpRate: 1, catchUpSize: 0.5,
      steps: [{ lpMultiple: 2.5, carryRate: 0.3, catchUpRate: 1, catchUpMeasure: 'split' as const }],
    }
    const clean = { contributedCapital: 1000, returnedCapital: 0, preferredPaid: 0, preferredTarget: 100, gpCarryPaid: 0 }

    it('tops the GP up to 30% of the 20% split, leaving the pref out', () => {
      // 1,000 back, 100 pref, 12.50 catch-up (half of a full one). The 20% split runs 1,750 to take
      // the LPs to 2,500 (GP 350). The GP is then owed 30% of 1,750 = 525 less 350 = 175. The last
      // 1,962.50 splits 30%: 588.75 to the GP.
      const r = runWaterfall(5000, terms, clean)
      expect(r.toCatchUp).toBe(12.5)
      expect(r.bands).toEqual([
        { carryRate: 0.2, catchUp: 0, catchUpToLP: 0, toLP: 1400, toGP: 350 },
        { carryRate: 0.3, catchUp: 175, catchUpToLP: 0, toLP: 1373.75, toGP: 588.75 },
      ])
      expect(r.toGP).toBe(1126.25)
      expect(r.toLP + r.toGP).toBe(5000)
      expect(r.state.splitPaid).toBe(3712.5)
    })

    it('catches up less than the all-profit measure, which also tops up the pref', () => {
      const profit = runWaterfall(5000, { ...terms, steps: [{ ...terms.steps[0], catchUpMeasure: 'profit' as const }] }, clean)
      const split = runWaterfall(5000, terms, clean)
      expect(profit.bands![1].catchUp).toBeGreaterThan(split.bands![1].catchUp)
    })

    it('gives the same carry whether the money comes in one distribution or two', () => {
      const first = runWaterfall(3000, terms, clean)
      expect(first.bands![1].catchUp).toBe(137.5)
      const second = runWaterfall(2000, terms, first.state)
      expect(second.bands![1].catchUp).toBe(37.5)
      expect(Math.round((first.toGP + second.toGP) * 100) / 100).toBe(1126.25)
    })

    it('reads the measure from the stored row', () => {
      const t = carryTermsFromRow({
        kind: 'european', carry_rate: 0.2,
        carry_steps: [{ lpMultiple: 2.5, carryRate: 0.3, catchUpRate: 1, catchUpMeasure: 'split' }],
      })
      expect(t.carrySteps).toEqual([{ lpMultiple: 2.5, carryRate: 0.3, catchUpRate: 1, catchUpMeasure: 'split' }])
    })
  })

  it('reads well-formed steps from the stored row and drops the rest', () => {
    const t = carryTermsFromRow({
      kind: 'european', carry_rate: 0.2,
      carry_steps: [{ lpMultiple: 2, carryRate: 0.25, catchUpRate: 1 }, { carryRate: 0.3 }, { lpIrr: 0.2, lpMultiple: 3, carryRate: 0.3 }],
    })
    expect(t.carrySteps).toEqual([{ lpMultiple: 2, carryRate: 0.25, catchUpRate: 1 }])
  })
})

describe('capital that leaves fees out', () => {
  const postings = [
    { lpEntityId: 'lp', amount: -1000, sourceType: 'capital_call', entryDate: '2025-01-01' },
    { lpEntityId: 'lp', amount: 100, sourceType: 'management_fee', entryDate: '2025-03-31' },
    { lpEntityId: 'lp', amount: 50, sourceType: 'partnership_expense', entryDate: '2025-06-30' },
  ]

  it('tags the LP capital that paid the fee and the expenses, first in first out', () => {
    expect(datedContributions(postings, new Set(), '2026-01-01')).toEqual([
      { date: '2025-01-01', amount: 100, purpose: 'fees' },
      { date: '2025-01-01', amount: 50, purpose: 'expenses' },
      { date: '2025-01-01', amount: 850, purpose: 'investments' },
    ])
  })

  it('lets a later call pay a fee charged before there was capital to pay it', () => {
    expect(datedContributions([
      { lpEntityId: 'lp', amount: 100, sourceType: 'management_fee', entryDate: '2025-01-01' },
      { lpEntityId: 'lp', amount: -1000, sourceType: 'capital_call', entryDate: '2025-02-01' },
    ], new Set(), '2026-01-01')).toEqual([
      { date: '2025-02-01', amount: 100, purpose: 'fees' },
      { date: '2025-02-01', amount: 900, purpose: 'investments' },
    ])
  })

  it('returns only the invested capital before the split', () => {
    const contributions = datedContributions(postings, new Set(), '2026-01-01')
    const terms = straight({ capitalIncludes: ['investments'] })
    expect(replayWaterfallState([], contributions, terms, '2026-01-01').contributedCapital).toBe(850)
    const split = splitDistribution({
      total: 1000,
      terms,
      partners: [{ lpEntityId: 'lp', contributed: 1000, distributed: 0, ending: 850 }],
      contributions,
      priors: [],
      asOf: '2026-01-01',
    })
    expect(split.tiers.returnOfCapital).toBe(850)
    expect(split.tiers.carry).toBe(30)
  })

  it('stores the purposes as text and treats all four as the default', () => {
    expect(carryTermsFromRow({ kind: 'european', capital_includes: ['investments'] }).capitalIncludes).toEqual(['investments'])
    expect(carryTermsFromRow({ kind: 'european', capital_includes: ['investments', 'fees', 'expenses', 'other'] }).capitalIncludes).toBeUndefined()
  })
})
