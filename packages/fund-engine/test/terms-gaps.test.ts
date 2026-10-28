import { describe, it, expect } from 'vitest'
import { realizedCapitalFromDeals } from '../src/american-carry.ts'
import { splitDistribution } from '../src/distribution-waterfall.ts'
import { carryAccrual } from '../src/carry.ts'
import { carryAccrualInputs } from '../src/economics.ts'
import { runWaterfall } from '../src/waterfall.ts'
import type { VehicleCarryTerms } from '../src/carry.ts'
import type { CapitalPosting } from '../src/capital-account.ts'

const american: VehicleCarryTerms = {
  kind: 'american', carryRate: 0.2, prefRate: 0, catchupRate: 1, prefCompounds: true,
  gpEntityId: 'gp', recipients: [{ lpEntityId: 'gp', pct: 100 }],
}
const partners = [
  { lpEntityId: 'lp', contributed: 1_000, distributed: 0, ending: 1_000 },
  { lpEntityId: 'gp', contributed: 0, distributed: 0, ending: 0 },
]
const contributions = [{ date: '2024-01-01', amount: 1_000 }]

describe('the American capital base', () => {
  it('realizes each slice of cost over the investments it came from, scaled to LP capital', () => {
    const base = realizedCapitalFromDeals([
      {
        companyId: 'a',
        investments: [{ date: '2024-01-01', amount: 300 }, { date: '2024-07-01', amount: 100 }],
        realizations: [{ date: '2025-01-01', costExited: 200 }, { date: '2025-06-01', costExited: null }],
      },
    ], { factor: 1.1 })
    // Half the basis leaves first, then (no cost stated) the rest: each split 3:1 by investment.
    expect(base).toEqual([
      { companyId: 'a', date: '2024-01-01', realizedOn: '2025-01-01', amount: 165 },
      { companyId: 'a', date: '2024-07-01', realizedOn: '2025-01-01', amount: 55 },
      { companyId: 'a', date: '2024-01-01', realizedOn: '2025-06-01', amount: 165 },
      { companyId: 'a', date: '2024-07-01', realizedOn: '2025-06-01', amount: 55 },
    ])
  })

  it('realizes a deal closed by status alone on its closing date, and never more than its basis', () => {
    const base = realizedCapitalFromDeals([
      { companyId: 'w', investments: [{ date: '2024-01-01', amount: 200 }], realizations: [{ date: '2025-01-01', costExited: 500 }], closedOn: null },
      { companyId: 'x', investments: [{ date: '2024-01-01', amount: 100 }], realizations: [], closedOn: '2025-03-01' },
      { companyId: 'held', investments: [{ date: '2024-01-01', amount: 100 }], realizations: [] },
    ], { factor: 1 })
    expect(base).toEqual([
      { companyId: 'w', date: '2024-01-01', realizedOn: '2025-01-01', amount: 200 },
      { companyId: 'x', date: '2024-01-01', realizedOn: '2025-03-01', amount: 100 },
    ])
  })

  it('pays carry on a winner once the realized deals, losers included, are back', () => {
    const realizedCapital = [
      { date: '2024-01-01', realizedOn: '2025-01-01', amount: 200 }, // written off
      { date: '2024-01-01', realizedOn: '2025-06-01', amount: 300 }, // sold, this distribution
    ]
    const s = splitDistribution({ total: 900, terms: american, partners, contributions, priors: [], asOf: '2025-06-01', realizedCapital })
    expect(s.tiers.returnOfCapital).toBe(500)
    expect(s.tiers.toGP).toBe(80) // 20% of the 400 above the realized 500
    expect(s.warnings).toEqual([])
    // The same distribution whole-fund owes back all 1,000 first: no carry yet.
    const whole = splitDistribution({ total: 900, terms: { ...american, kind: 'european' }, partners, contributions, priors: [], asOf: '2025-06-01' })
    expect(whole.tiers.toGP).toBe(0)
  })

  it('says so when it has no deals, or no deal has realized', () => {
    const none = splitDistribution({ total: 100, terms: american, partners, contributions, priors: [], asOf: '2025-06-01' })
    expect(none.warnings.join(' ')).toMatch(/no realized deals were supplied/)
    const early = splitDistribution({ total: 100, terms: american, partners, contributions, priors: [], asOf: '2025-06-01', realizedCapital: [] })
    expect(early.warnings.join(' ')).toMatch(/No deal has been realized yet/)
  })
})

describe('the close measures carry gross of carry', () => {
  const terms: VehicleCarryTerms = { ...american, kind: 'european' }
  const postings: CapitalPosting[] = [
    { lpEntityId: 'lp', amount: -1_000, sourceType: 'capital_call', entryDate: '2024-01-01' },
    { lpEntityId: 'lp', amount: -500, sourceType: 'unrealized_gain', entryDate: '2024-12-31' },
  ]
  it('posts nothing on a second close of unchanged books, and does not re-accrue carry paid', () => {
    const first = carryAccrualInputs(postings, terms.recipients, '2024-12-31')
    const a1 = carryAccrual({ ...first, asOf: '2024-12-31' }, terms, first.alreadyAccrued)
    expect(a1.delta).toBe(100)
    const booked: CapitalPosting[] = [
      ...postings,
      { lpEntityId: 'lp', amount: 100, sourceType: 'carried_interest', entryDate: '2024-12-31' },
      { lpEntityId: 'gp', amount: -100, sourceType: 'carried_interest', entryDate: '2024-12-31' },
    ]
    const second = carryAccrualInputs(booked, terms.recipients, '2024-12-31')
    expect(carryAccrual({ ...second, asOf: '2024-12-31' }, terms, second.alreadyAccrued).delta).toBe(0)
    // Paying 60 of it to the GP leaves the entitlement where it was.
    const paid = [...booked, { lpEntityId: 'gp', amount: 60, sourceType: 'carry_distribution', entryDate: '2025-01-15' }]
    const third = carryAccrualInputs(paid, terms.recipients, '2025-01-31')
    expect(third.alreadyAccrued).toBe(100)
  })
})

describe('the catch-up', () => {
  const start = { contributedCapital: 1_000, returnedCapital: 0, preferredPaid: 0, preferredTarget: 80, gpCarryPaid: 0 }

  it('is a full catch-up at any rate: 20 on 80 of pref at 20% carry, taken at the rate', () => {
    for (const [k, flow] of [[1, 20], [0.8, 25], [0.5, 40], [0.2, 100], [0.1, 200]] as const) {
      const r = runWaterfall(1_080 + flow, { carryRate: 0.2, catchUpRate: k }, start)
      expect(r.toCatchUp, `k=${k}`).toBe(20)
      expect(r.toCatchUpLP, `k=${k}`).toBe(Math.round((flow - 20) * 100) / 100)
      expect(r.toCarryGP, `k=${k}`).toBe(0) // the flow was exactly the catch-up
    }
  })

  it('stops at its size: a half catch-up is 10', () => {
    const r = runWaterfall(1_500, { carryRate: 0.2, catchUpRate: 0.1, catchUpSize: 0.5 }, start)
    expect(r.toCatchUp).toBe(10)
    expect(r.toCatchUpLP).toBe(90)
    expect(r.state.gpCatchUpPaid).toBe(10)
  })

  it('a size of 0 is no catch-up', () => {
    const r = runWaterfall(1_500, { carryRate: 0.2, catchUpRate: 1, catchUpSize: 0 }, start)
    expect(r.toCatchUp).toBe(0)
    expect(r.toCarryGP).toBe(84)
  })

  it('split carry does not count toward the catch-up when the hurdle grows', () => {
    const r = runWaterfall(100, { carryRate: 0.2, catchUpRate: 1 }, {
      contributedCapital: 1_000, returnedCapital: 1_000, preferredPaid: 80, preferredTarget: 120, gpCarryPaid: 100, gpCatchUpPaid: 20,
    })
    expect(r.toCatchUp).toBe(10) // a full catch-up on 120 of pref is 30; 20 was caught up before
  })
})

describe('the close trues each LP up to its share of the carry', () => {
  const straight: VehicleCarryTerms = {
    kind: 'straight', carryRate: 0.2, prefRate: 0, catchupRate: 1, prefCompounds: true,
    gpEntityId: 'gp', recipients: [{ lpEntityId: 'gp', pct: 100 }],
  }
  // Two LPs with 50 of profit each: a 20 target, 10 apiece.
  const lp = (id: string, nav: number, charged?: number) => ({ lpEntityId: id, contributed: 100, distributed: 0, nav, ...(charged != null ? { charged } : {}) })

  it('moves carry between LPs when earlier accruals were shared on different profits', () => {
    // A was in profit first and took 15 of the 20; the total is right but the shares are not.
    const a = carryAccrual({ lps: [lp('a', 150, 15), lp('b', 150, 5)] }, straight, 20)
    expect(a.delta).toBe(0)
    expect(Object.fromEntries(a.perLp)).toEqual({ a: -5, b: 5 })
  })

  it('charges each LP its share of the whole target, so both end at the same rate on profit', () => {
    const a = carryAccrual({ lps: [lp('a', 200, 8), lp('b', 125, 0)] }, straight, 8) // profits 100 and 25 → 25 target
    expect(a.target).toBe(25)
    expect(a.delta).toBe(17)
    expect(Object.fromEntries(a.perLp)).toEqual({ a: 12, b: 5 }) // 20 and 5 in all: 20% of each LP's profit
  })

  it('reverses every LP\'s charge when nobody is in profit', () => {
    const a = carryAccrual({ lps: [lp('a', 90, 6), lp('b', 100, 4)] }, straight, 10)
    expect(a.target).toBe(0)
    expect(a.delta).toBe(-10)
    expect(Object.fromEntries(a.perLp)).toEqual({ a: -6, b: -4 })
  })

  it('without each LP\'s charge, shares out only the change, as before', () => {
    const a = carryAccrual({ lps: [lp('a', 150), lp('b', 150)] }, straight, 20)
    expect(a.delta).toBe(0)
    expect(a.perLp.size).toBe(0)
  })
})

describe('the accrual when the GP commit bears carry', () => {
  const european: VehicleCarryTerms = {
    kind: 'european', carryRate: 0.2, prefRate: 0, catchupRate: 1, prefCompounds: true,
    gpEntityId: null, recipients: [{ lpEntityId: 'gp', pct: 100 }], gpCommitBearsCarry: true,
  }
  // 900 from the LP and 100 from the GP, both up 50%.
  const postings: CapitalPosting[] = [
    { lpEntityId: 'lp', amount: -900, sourceType: 'capital_call', entryDate: '2024-01-01' },
    { lpEntityId: 'gp', amount: -100, sourceType: 'capital_call', entryDate: '2024-01-01' },
    { lpEntityId: 'lp', amount: -450, sourceType: 'unrealized_gain', entryDate: '2024-12-31' },
    { lpEntityId: 'gp', amount: -50, sourceType: 'unrealized_gain', entryDate: '2024-12-31' },
  ]
  const accrue = (books: CapitalPosting[], terms: VehicleCarryTerms, asOf = '2024-12-31') => {
    const i = carryAccrualInputs(books, terms.recipients, asOf, terms.gpCommitBearsCarry)
    return carryAccrual({ ...i, asOf }, terms, i.alreadyAccrued, i.bearing)
  }
  const sum = (m: Map<string, number>) => Math.round([...m.values()].reduce((s, v) => s + v, 0) * 100) / 100

  it('measures the whole fund, and a single recipient posts only what the LPs bear', () => {
    const a = accrue(postings, european)
    // 20% of the fund's 500 of profit; the GP's 10 of it is paid to itself and nets out.
    expect(a.target).toBe(100)
    expect(Object.fromEntries(a.perLp)).toEqual({ lp: 90, gp: -90 })
    expect(sum(a.perLp)).toBe(0)
  })

  it('is a true-up: nothing on unchanged books, and carry paid is not accrued again', () => {
    const booked: CapitalPosting[] = [
      ...postings,
      { lpEntityId: 'lp', amount: 90, sourceType: 'carried_interest', entryDate: '2024-12-31' },
      { lpEntityId: 'gp', amount: -90, sourceType: 'carried_interest', entryDate: '2024-12-31' },
    ]
    expect(accrue(booked, european).perLp.size).toBe(0)
    const paid = [...booked, { lpEntityId: 'gp', amount: 60, sourceType: 'carry_distribution', entryDate: '2025-01-15' }]
    expect(accrue(paid, european, '2025-01-31').perLp.size).toBe(0)
  })

  it('charges one recipient carry the other receives', () => {
    const split: VehicleCarryTerms = { ...european, recipients: [{ lpEntityId: 'gp', pct: 50 }, { lpEntityId: 'gp2', pct: 50 }] }
    const a = accrue(postings, split)
    // The GP bears 10 and receives 50; the second recipient, with no capital, receives 50.
    expect(Object.fromEntries(a.perLp)).toEqual({ lp: 90, gp: -40, gp2: -50 })
    expect(sum(a.perLp)).toBe(0)
    const booked = [...postings,
      { lpEntityId: 'lp', amount: 90, sourceType: 'carried_interest', entryDate: '2024-12-31' },
      { lpEntityId: 'gp', amount: -40, sourceType: 'carried_interest', entryDate: '2024-12-31' },
      { lpEntityId: 'gp2', amount: -50, sourceType: 'carried_interest', entryDate: '2024-12-31' },
    ]
    expect(accrue(booked, split).perLp.size).toBe(0)
  })

  it('puts the GP commit in the hurdle, which a carry-free commit stays out of', () => {
    const pref = { ...european, prefRate: 0.08, catchupRate: 0 }
    const bears = accrue(postings, pref)
    const free = accrue(postings, { ...pref, gpCommitBearsCarry: false })
    // Without a catch-up the carry is 20% of profit over the pref: on 1,000 bearing it, 20% of
    // (500 − 80); on the LP's 900 alone, 20% of (450 − 72).
    expect(bears.target).toBe(84)
    expect(free.target).toBe(75.6)
  })
})
