// The waterfall run per LP (`waterfallScope: 'per_lp'`, docs/spec/waterfall-terms.md §4.3, §6).
//
// Every figure here is invented. The checks:
//   - equivalence: with every LP contributing pro rata on the same dates and receiving pro rata,
//     per LP and whole fund agree to within a cent per LP per tier, for the close's accrual and for a
//     distribution, across steps, a partial catch-up, both hurdle bases and a GP commit that bears
//     carry;
//   - divergence: LPs that contributed on different dates are charged, and paid, different carry;
//   - the replay reads what each LP actually received, not a re-division of the fund's totals;
//   - order independence: one distribution, or the same cash in two, gives each LP the same carry;
//   - the close's true-up: a second close on unchanged books posts nothing, and a falling NAV
//     reverses each LP's own charge;
//   - addStates keeps the profit and split totals of grouped states.

import { describe, it, expect } from 'vitest'
import {
  carryAccrual,
  carryAccrualInputs,
  carryTarget,
  carryTargetByLp,
  carryTermsFromRow,
  distributionSplitInputs,
  groupLpsByTerms,
  groupedFundEndEntitlement,
  inheritTransferredHistory,
  runsPerLp,
  splitAcrossGroups,
  splitDistribution,
  type CapitalPosting,
  type CarryStep,
  type DistributionSplit,
  type LpDatedContribution,
  type VehicleCarryTerms,
} from '../src/index.ts'
import { roundCents } from '../src/ledger.ts'
import { parseVehicleTerms } from '../src/terms-file.ts'

const GP = 'gp'

function terms(over: Partial<VehicleCarryTerms> = {}): VehicleCarryTerms {
  return {
    kind: 'european',
    carryRate: 0.2,
    prefRate: 0.08,
    catchupRate: 1,
    catchupSize: 1,
    prefCompounds: true,
    prefBase: 'contributed',
    gpEntityId: GP,
    recipients: [{ lpEntityId: GP, pct: 100 }],
    ...over,
  }
}
const perLp = (t: VehicleCarryTerms): VehicleCarryTerms => ({ ...t, waterfallScope: 'per_lp' })

// ─── A small set of books ───────────────────────────────────────────────────────────────────────

/** Books built the way the app posts them: calls, marks, and distributions split by the waterfall. */
class Books {
  postings: CapitalPosting[] = []
  constructor(readonly t: VehicleCarryTerms) {}

  call(date: string, byLp: Record<string, number>) {
    for (const [id, amount] of Object.entries(byLp)) this.postings.push({ lpEntityId: id, amount: -amount, sourceType: 'capital_call', entryDate: date })
  }
  /** A gain (or a loss) shared by each partner's contributions to date. */
  mark(date: string, total: number) {
    const contributed = new Map<string, number>()
    for (const p of this.postings) if (p.sourceType === 'capital_call') contributed.set(p.lpEntityId, (contributed.get(p.lpEntityId) ?? 0) - p.amount)
    const all = [...contributed.values()].reduce((s, v) => s + v, 0)
    let left = total
    const ids = [...contributed.keys()]
    ids.forEach((id, i) => {
      const amount = i === ids.length - 1 ? roundCents(left) : roundCents((total * contributed.get(id)!) / all)
      left = roundCents(left - amount)
      this.postings.push({ lpEntityId: id, amount: -amount, sourceType: 'unrealized_gain', entryDate: date })
    })
  }
  split(date: string, total: number): DistributionSplit {
    const inputs = distributionSplitInputs(this.postings, this.t.recipients, date, this.t.gpCommitBearsCarry, { perLp: runsPerLp(this.t) })
    return splitDistribution({ total, terms: this.t, partners: inputs.partners, contributions: inputs.contributions, priors: inputs.priors, asOf: date, ...(inputs.lpContributions ? { lpContributions: inputs.lpContributions } : {}) })
  }
  /** Declare it as the app books it: LP lines as distributions, carry lines as carry paid. */
  distribute(date: string, total: number): DistributionSplit {
    const s = this.split(date, total)
    for (const l of s.lines) this.postings.push({ lpEntityId: l.lpEntityId, amount: l.amount, sourceType: 'distribution', entryDate: date })
    for (const l of s.carryLines) this.postings.push({ lpEntityId: l.lpEntityId, amount: l.amount, sourceType: 'carry_distribution', entryDate: date })
    return s
  }
  accrual(asOf: string) {
    const inputs = carryAccrualInputs(this.postings, this.t.recipients, asOf, this.t.gpCommitBearsCarry, { perLp: runsPerLp(this.t) })
    return carryAccrual({ ...inputs, asOf }, this.t, inputs.alreadyAccrued, inputs.bearing)
  }
  /** Post an accrual the way the close does: each partner's line to its carried-interest bucket. */
  post(asOf: string, a: ReturnType<Books['accrual']>, bearing: boolean) {
    for (const [id, amount] of a.perLp) this.postings.push({ lpEntityId: id, amount, sourceType: 'carried_interest', entryDate: asOf })
    if (!bearing && a.delta !== 0) this.postings.push({ lpEntityId: GP, amount: -a.delta, sourceType: 'carried_interest', entryDate: asOf })
  }
}

// ─── Equivalence ────────────────────────────────────────────────────────────────────────────────

const STEPS: CarryStep[] = [{ lpMultiple: 1.6, carryRate: 0.25, catchUpRate: 1 }]
const VARIANTS: { name: string; t: VehicleCarryTerms }[] = [
  { name: 'full catch-up', t: terms() },
  { name: 'partial catch-up (half size, 50% rate)', t: terms({ catchupRate: 0.5, catchupSize: 0.5 }) },
  { name: 'hurdle on unreturned capital', t: terms({ prefBase: 'unreturned' }) },
  { name: 'a carry step at 1.6x with a catch-up', t: terms({ carrySteps: STEPS }) },
  { name: 'GP commit bears carry', t: terms({ gpCommitBearsCarry: true }) },
  { name: 'straight', t: terms({ kind: 'straight', prefRate: 0 }) },
]

/** Three LPs (and a GP commit) contributing 1 : 2 : 3 (: 0.5) on the same dates. */
function proRataBooks(t: VehicleCarryTerms): Books {
  const b = new Books(t)
  const call = (date: string, unit: number) => b.call(date, { 'lp-a': unit, 'lp-b': 2 * unit, 'lp-c': 3 * unit, [GP]: unit / 2 })
  call('2020-01-15', 1_000)
  call('2021-03-31', 600)
  b.mark('2022-06-30', 9_000)
  b.distribute('2022-07-01', 4_000)
  call('2023-02-01', 400)
  b.mark('2024-12-31', 7_500)
  return b
}

// Each LP's waterfall rounds its own tiers where the pooled one rounds once, so the two can differ by
// rounding. The spec allows a cent per LP per tier; in practice it is a cent per LP, which is what
// these hold them to.
const tolerance = (_t: VehicleCarryTerms, lps: number) => 0.01 * lps + 1e-9

describe('per LP equals whole fund when every LP is pro rata', () => {
  for (const { name, t } of VARIANTS) {
    it(`the close's accrual: ${name}`, () => {
      const fund = proRataBooks(t).accrual('2024-12-31')
      const each = proRataBooks(perLp(t)).accrual('2024-12-31')
      const lps = fund.perLp.size
      expect(fund.target).toBeGreaterThan(0)
      expect(Math.abs(each.target - fund.target), `${each.target} vs ${fund.target}`).toBeLessThanOrEqual(tolerance(t, lps))
      for (const [id, amount] of fund.perLp) {
        expect(Math.abs((each.perLp.get(id) ?? 0) - amount), `${id}: ${each.perLp.get(id)} vs ${amount}`).toBeLessThanOrEqual(tolerance(t, 1))
      }
      // The lines tie out to the cent.
      const sum = roundCents([...each.perLp.values()].reduce((s, v) => s + v, 0))
      expect(sum).toBe(t.gpCommitBearsCarry ? 0 : each.delta)
    })

    it(`a distribution: ${name}`, () => {
      const fund = proRataBooks(t).split('2025-03-31', 24_000)
      const each = proRataBooks(perLp(t)).split('2025-03-31', 24_000)
      expect(each.method).toBe('waterfall')
      expect(each.warnings).toEqual([])
      expect(fund.tiers.toGP).toBeGreaterThan(0)
      expect(Math.abs(each.tiers.toGP - fund.tiers.toGP), `${each.tiers.toGP} vs ${fund.tiers.toGP}`).toBeLessThanOrEqual(tolerance(t, 4))
      for (const l of fund.lines) {
        const got = each.lines.find(x => x.lpEntityId === l.lpEntityId)?.amount ?? 0
        expect(Math.abs(got - l.amount), `${l.lpEntityId}: ${got} vs ${l.amount}`).toBeLessThanOrEqual(tolerance(t, 1))
      }
      const total = roundCents([...each.lines, ...each.carryLines].reduce((s, l) => s + l.amount, 0))
      expect(total).toBe(24_000)
    })
  }
})

// ─── Different timing: per LP and whole fund diverge ───────────────────────────────────────────

describe('LPs that contributed on different dates', () => {
  // The spec's worked example: LP A puts in 1,000 on 2020-01-01, LP B 1,000 on 2023-01-01.
  const lpContributions: LpDatedContribution[] = [
    { lpEntityId: 'lp-a', date: '2020-01-01', amount: 1_000 },
    { lpEntityId: 'lp-b', date: '2023-01-01', amount: 1_000 },
  ]
  const contributions = lpContributions.map(({ lpEntityId: _l, ...c }) => c)
  const lps = [
    { lpEntityId: 'lp-a', contributed: 1_000, distributed: 0, nav: 1_500 },
    { lpEntityId: 'lp-b', contributed: 1_000, distributed: 0, nav: 1_500 },
  ]
  const input = { lps, contributions, lpContributions, asOf: '2025-01-01' }

  it('are charged their own carry: the early LP is past its hurdle by less', () => {
    expect(carryTarget(input, terms())).toBe(200)
    const each = carryTargetByLp(input, perLp(terms()))!
    expect(Object.fromEntries(each.byLp)).toEqual({ 'lp-a': 30.05, 'lp-b': 100 })
    expect(each.total).toBe(130.05)
    expect(carryTarget(input, perLp(terms()))).toBe(130.05)
    const a = carryAccrual({ ...input, lps: lps.map(l => ({ ...l, charged: 0 })) }, perLp(terms()), 0)
    expect(Object.fromEntries(a.perLp)).toEqual({ 'lp-a': 30.05, 'lp-b': 100 })
    expect(a.targetByLp && Object.fromEntries(a.targetByLp)).toEqual({ 'lp-a': 30.05, 'lp-b': 100 })
  })

  it('without per-LP contributions, per LP falls back to the whole fund', () => {
    expect(carryTargetByLp({ lps, contributions, asOf: '2025-01-01' }, perLp(terms()))).toBeUndefined()
    expect(carryTarget({ lps, contributions, asOf: '2025-01-01' }, perLp(terms()))).toBe(200)
  })

  it('American terms run whole fund whatever the scope says', () => {
    expect(runsPerLp(perLp(terms({ kind: 'american' })))).toBe(false)
    expect(carryTargetByLp(input, perLp(terms({ kind: 'american' })))).toBeUndefined()
  })

  it('a distribution is divided by contributions, then each LP runs its own tiers', () => {
    const partners = [
      { lpEntityId: 'lp-a', contributed: 1_000, distributed: 0, ending: 1_500 },
      { lpEntityId: 'lp-b', contributed: 1_000, distributed: 0, ending: 1_500 },
    ]
    const s = splitDistribution({ total: 3_000, terms: perLp(terms()), partners, contributions, lpContributions, priors: [], asOf: '2025-01-01' })
    expect(s.groups?.map(g => [g.lpEntityIds[0], g.amount, g.tiers.toGP])).toEqual([['lp-a', 1_500, 30.05], ['lp-b', 1_500, 100]])
    expect(s.lines).toEqual([{ lpEntityId: 'lp-a', amount: 1_469.95 }, { lpEntityId: 'lp-b', amount: 1_400 }])
    expect(s.carryLines).toEqual([{ lpEntityId: GP, amount: 130.05 }])
    // Whole fund, the same cash gives the GP 200.
    expect(splitDistribution({ total: 3_000, terms: terms(), partners, contributions, priors: [], asOf: '2025-01-01' }).tiers.toGP).toBe(200)
  })

  it('without per-LP contributions, a distribution warns and splits whole fund', () => {
    const partners = [{ lpEntityId: 'lp-a', contributed: 1_000, distributed: 0, ending: 1_500 }]
    const s = splitDistribution({ total: 100, terms: perLp(terms()), partners, contributions, priors: [], asOf: '2025-01-01' })
    expect(s.warnings.join(' ')).toMatch(/contributions were not given per LP/)
    expect(s.groups).toBeUndefined()
  })
})

// ─── The replay reads what each LP received ─────────────────────────────────────────────────────

describe('the per-LP replay', () => {
  const lpContributions: LpDatedContribution[] = [
    { lpEntityId: 'lp-a', date: '2020-01-01', amount: 1_000 },
    { lpEntityId: 'lp-b', date: '2020-01-01', amount: 1_000 },
  ]
  const contributions = lpContributions.map(({ lpEntityId: _l, ...c }) => c)
  const partners = [
    { lpEntityId: 'lp-a', contributed: 1_000, distributed: 900, ending: 600 },
    { lpEntityId: 'lp-b', contributed: 1_000, distributed: 100, ending: 1_400 },
  ]
  const t = perLp(terms({ prefRate: 0 }))

  it('reads the booked lines, not a re-division of the fund total', () => {
    // 1,000 went out in 2022, but not by the division: LP A took 900 and LP B 100.
    const priors = [{ date: '2022-01-01', amount: 1_000, paidToLp: { 'lp-a': 900, 'lp-b': 100 } }]
    const s = splitDistribution({ total: 2_000, terms: t, partners, contributions, lpContributions, priors, asOf: '2025-01-01' })
    // Each takes 1,000 of the new cash. LP A has 100 of capital left, LP B 900.
    const byLp = Object.fromEntries(s.groups!.map(g => [g.lpEntityIds[0], g.tiers]))
    expect(byLp['lp-a'].returnOfCapital).toBe(100)
    expect(byLp['lp-b'].returnOfCapital).toBe(900)
    expect(byLp['lp-a'].toGP).toBe(180) // 20% of the 900 above LP A's capital
    expect(byLp['lp-b'].toGP).toBe(20)
    expect(s.warnings).toEqual([])
    // Re-dividing the prior by contributions instead would have returned 500 to each.
    const divided = splitDistribution({ total: 2_000, terms: t, partners, contributions, lpContributions, priors: [{ date: '2022-01-01', amount: 1_000 }], asOf: '2025-01-01' })
    expect(divided.groups!.map(g => g.tiers.returnOfCapital)).toEqual([500, 500])
    expect(divided.warnings.join(' ')).toMatch(/divided by contributions/)
  })

  it('places the carry paid on a prior inside the LPs whose tiers can account for it', () => {
    // A full catch-up leaves a span where the LP's net doesn't move: the booked carry decides it.
    const t8 = perLp(terms())
    const lp = (ids: string[]) => ids.map(id => ({ lpEntityId: id, contributed: 1_000, distributed: 0, ending: 1_000 }))
    const first = splitDistribution({ total: 2_400, terms: t8, partners: lp(['lp-a', 'lp-b']), contributions, lpContributions, priors: [], asOf: '2022-01-01' })
    const paidToLp = Object.fromEntries(first.lines.map(l => [l.lpEntityId, l.amount]))
    const prior = { date: '2022-01-01', amount: 2_400, paidToLp }
    const groups = groupLpsByTerms({ fundTerms: t8, lpEntityIds: ['lp-a', 'lp-b'], contributions: lpContributions, perLp: true })
    const next = splitAcrossGroups(0, [prior], groups, '2022-01-01', { division: 'contributions' })
    // The replay lands each LP exactly where the split left it.
    expect(next.map(g => g.stateBefore.gpCarryPaid)).toEqual(first.groups!.map(g => g.tiers.toGP))
  })
})

// ─── Order independence ─────────────────────────────────────────────────────────────────────────

describe('one distribution or the same cash in two', () => {
  for (const { name, t } of VARIANTS.filter(v => v.t.kind === 'european')) {
    it(`gives each LP the same carry: ${name}`, () => {
      const book = () => {
        const b = new Books(perLp(t))
        b.call('2020-01-01', { 'lp-a': 1_000, [GP]: 50 })
        b.call('2022-07-01', { 'lp-b': 2_000, [GP]: 100 })
        b.mark('2024-12-31', 4_000)
        return b
      }
      const once = book()
      const whole = once.distribute('2025-01-31', 5_000)
      const twice = book()
      const a = twice.distribute('2025-01-31', 1_700)
      const b = twice.distribute('2025-01-31', 3_300)
      const gpOf = (s: DistributionSplit, id: string) => s.groups!.find(g => g.lpEntityIds[0] === id)?.tiers.toGP ?? 0
      for (const id of ['lp-a', 'lp-b']) {
        expect(Math.abs(roundCents(gpOf(a, id) + gpOf(b, id)) - gpOf(whole, id)), id).toBeLessThanOrEqual(0.02)
      }
      expect(Math.abs(roundCents(a.tiers.toGP + b.tiers.toGP) - whole.tiers.toGP)).toBeLessThanOrEqual(0.02)
    })
  }
})

// ─── The close ──────────────────────────────────────────────────────────────────────────────────

describe('the close per LP', () => {
  const t = perLp(terms())
  const build = () => {
    const b = new Books(t)
    b.call('2020-01-01', { 'lp-a': 1_000 })
    b.call('2023-01-01', { 'lp-b': 1_000 })
    b.mark('2025-01-01', 1_000)
    return b
  }

  it('charges each LP its own carry, and a second close on the same books posts nothing', () => {
    const b = build()
    const first = b.accrual('2025-01-01')
    expect(first.target).toBe(130.05)
    expect(Object.fromEntries(first.perLp)).toEqual({ 'lp-a': 30.05, 'lp-b': 100 })
    b.post('2025-01-01', first, false)
    const second = b.accrual('2025-01-01')
    expect(second.perLp.size).toBe(0)
    expect(second.delta).toBe(0)
  })

  it('reverses each LP\'s own charge when NAV falls', () => {
    const b = build()
    b.post('2025-01-01', b.accrual('2025-01-01'), false)
    b.mark('2025-06-30', -800)
    const after = b.accrual('2025-06-30')
    // At 2,200 of NAV, each LP's 1,100 is below its capital and pref: all carry comes back.
    expect(after.target).toBe(0)
    expect(Object.fromEntries(after.perLp)).toEqual({ 'lp-a': -30.05, 'lp-b': -100 })
  })

  it('counts carry already paid in cash, and reads each LP\'s receipts for its own replay', () => {
    const b = build()
    b.post('2025-01-01', b.accrual('2025-01-01'), false)
    const s = b.distribute('2025-02-01', 1_000)
    expect(s.warnings).toEqual([])
    const inputs = carryAccrualInputs(b.postings, t.recipients, '2025-02-01', false, { perLp: true })
    expect(inputs.distributions).toEqual([{ date: '2025-02-01', amount: 1_000, paidToLp: Object.fromEntries(s.lines.map(l => [l.lpEntityId, l.amount])) }])
    expect(inputs.lpContributions).toEqual([
      { lpEntityId: 'lp-a', date: '2020-01-01', amount: 1_000, purpose: 'investments' },
      { lpEntityId: 'lp-b', date: '2023-01-01', amount: 1_000, purpose: 'investments' },
    ])
    // The cash moved, the value didn't: no new charge beyond the hurdle's month of growth.
    const a = b.accrual('2025-02-01')
    for (const [, v] of a.perLp) expect(Math.abs(v)).toBeLessThan(15)
  })
})

// ─── The terms and the grouped totals ───────────────────────────────────────────────────────────

// ─── An LP by transfer ──────────────────────────────────────────────────────────────────────────

describe('an LP who holds its interest by transfer', () => {
  // LP A puts in 1,000 in 2020 and LP B 1,000 in 2023. In 2024 LP A moves half its interest to LP C,
  // who never contributed. Per LP, LP C stands in LP A's shoes: its tiers run on LP A's 2020 capital.
  const transferred = (sourceType: string, share = 0.5) => {
    const b = new Books(perLp(terms()))
    b.call('2020-01-01', { 'lp-a': 1_000 })
    b.call('2023-01-01', { 'lp-b': 1_000 })
    b.mark('2023-12-31', 600)
    // LP A's balance is 1,000 + its share of the gain; move `share` of it, one entry, both legs.
    const balance = -b.postings.filter(p => p.lpEntityId === 'lp-a').reduce((s, p) => s + p.amount, 0)
    const amount = roundCents(balance * share)
    b.postings.push({ entryId: 'xfer-1', lpEntityId: 'lp-a', amount, sourceType, entryDate: '2024-06-30' })
    b.postings.push({ entryId: 'xfer-1', lpEntityId: 'lp-c', amount: -amount, sourceType, entryDate: '2024-06-30' })
    b.mark('2024-12-31', 1_400)
    return b
  }
  // The same economics with LP C as an original 2020 contributor of half of LP A's capital.
  const original = () => {
    const b = new Books(perLp(terms()))
    b.call('2020-01-01', { 'lp-a': 500, 'lp-c': 500 })
    b.call('2023-01-01', { 'lp-b': 1_000 })
    b.mark('2023-12-31', 600)
    b.mark('2024-12-31', 1_400)
    return b
  }

  for (const sourceType of ['transfer', 'secondary_transfer']) {
    it(`uses the original LP's contributions (${sourceType})`, () => {
      const got = transferred(sourceType).accrual('2024-12-31')
      const want = original().accrual('2024-12-31')
      expect(got.perLp.get('lp-c')).toBeGreaterThan(0)
      for (const id of ['lp-a', 'lp-b', 'lp-c']) {
        expect(Math.abs((got.perLp.get(id) ?? 0) - (want.perLp.get(id) ?? 0)), id).toBeLessThanOrEqual(0.01)
      }
      const split = transferred(sourceType).split('2025-01-31', 3_000)
      const direct = original().split('2025-01-31', 3_000)
      for (const id of ['lp-a', 'lp-b', 'lp-c']) {
        const at = (x: DistributionSplit) => x.lines.find(l => l.lpEntityId === id)?.amount ?? 0
        expect(Math.abs(at(split) - at(direct)), id).toBeLessThanOrEqual(0.01)
      }
    })
  }

  it('keeps every balance and carries the history through a second transfer', () => {
    const b = transferred('transfer', 1)
    // LP C passes the whole interest on to LP D.
    const balance = -b.postings.filter(p => p.lpEntityId === 'lp-c' && p.entryDate! <= '2024-12-31').reduce((s, p) => s + p.amount, 0)
    b.postings.push({ entryId: 'xfer-2', lpEntityId: 'lp-c', amount: balance, sourceType: 'transfer', entryDate: '2025-01-15' })
    b.postings.push({ entryId: 'xfer-2', lpEntityId: 'lp-d', amount: -balance, sourceType: 'transfer', entryDate: '2025-01-15' })
    const resolved = inheritTransferredHistory(b.postings)
    const ending = (ps: CapitalPosting[], id: string) => roundCents(ps.filter(p => p.lpEntityId === id).reduce((s, p) => s + p.amount, 0))
    for (const id of ['lp-a', 'lp-b', 'lp-c', 'lp-d']) expect(ending(resolved, id), id).toBe(ending(b.postings, id))
    const calls = resolved.filter(p => p.sourceType === 'capital_call' && p.lpEntityId === 'lp-d')
    expect(calls.map(p => [p.entryDate, roundCents(-p.amount)])).toEqual([['2020-01-01', 1_000]])
    // The whole-fund waterfall doesn't resolve transfers, so a vehicle on 'fund' is unchanged.
    expect(carryAccrualInputs(b.postings, [{ lpEntityId: GP, pct: 100 }], '2025-01-31').contributions)
      .toEqual(carryAccrualInputs(b.postings, [{ lpEntityId: GP, pct: 100 }], '2025-01-31', false, {}).contributions)
  })
})

describe('the term', () => {
  it('reads from a terms file, and refuses per LP with American terms', () => {
    const file = (carry: Record<string, unknown>) => parseVehicleTerms({ carry: { kind: 'european', carryRate: 0.2, recipients: [{ partner: GP, pct: 100 }], ...carry } }).carry
    expect(file({}).waterfallScope).toBeUndefined()
    expect(file({ waterfallScope: 'per_lp' }).waterfallScope).toBe('per_lp')
    expect(() => file({ kind: 'american', waterfallScope: 'per_lp' })).toThrow(/not supported with american/)
    expect(() => file({ waterfallScope: 'each' })).toThrow(/fund or per_lp/)
  })

  it('reads from the row, defaulting to the whole fund', () => {
    expect(carryTermsFromRow({ kind: 'european', carry_rate: 0.2 }).waterfallScope).toBeUndefined()
    expect(carryTermsFromRow({ kind: 'european', carry_rate: 0.2, waterfall_scope: 'fund' }).waterfallScope).toBeUndefined()
    expect(carryTermsFromRow({ kind: 'european', carry_rate: 0.2, waterfall_scope: 'per_lp' }).waterfallScope).toBe('per_lp')
  })
})

describe('grouped states', () => {
  it('sum the profit and split totals, so a grouped step is right', () => {
    const t = terms({ carrySteps: STEPS, waterfallScope: 'per_lp' })
    const lpContributions: LpDatedContribution[] = [
      { lpEntityId: 'lp-a', date: '2020-01-01', amount: 1_000 },
      { lpEntityId: 'lp-b', date: '2020-01-01', amount: 1_000 },
    ]
    const partners = ['lp-a', 'lp-b'].map(id => ({ lpEntityId: id, contributed: 1_000, distributed: 0, ending: 2_000 }))
    const s = splitDistribution({ total: 4_000, terms: t, partners, contributions: lpContributions.map(({ lpEntityId: _l, ...c }) => c), lpContributions, priors: [], asOf: '2024-01-01' })
    expect(s.stateAfter.lpProfitPaid).toBe(roundCents(s.tiers.toLP - s.tiers.returnOfCapital))
    expect(s.stateAfter.splitPaid).toBeGreaterThan(0)
  })

  it('the fund-end view divides each prior as the actual replay did', () => {
    const t = perLp(terms())
    const lpContributions: LpDatedContribution[] = [
      { lpEntityId: 'lp-a', date: '2020-01-01', amount: 1_000 },
      { lpEntityId: 'lp-b', date: '2022-01-01', amount: 1_000 },
    ]
    const groups = groupLpsByTerms({ fundTerms: t, lpEntityIds: ['lp-a', 'lp-b'], contributions: lpContributions, perLp: true })
    const priors = [{ date: '2021-06-30', amount: 1_500, paidToLp: { 'lp-a': 1_400 } }]
    const ent = groupedFundEndEntitlement(priors, groups, '2024-01-01', { division: 'contributions' })
    expect(ent.byGroup.length).toBe(2)
    expect(ent.byGroup[1]).toBe(0) // LP B received nothing
    expect(ent.total).toBe(ent.byGroup[0])
  })
})
