import { describe, it, expect } from 'vitest'
import { lookThroughAccount, associateMembers, type AssociateMember } from './look-through'
import { emptyAccount, type CapitalAccount } from './capital-account'

const acct = (over: Partial<CapitalAccount>): CapitalAccount => {
  const a = { ...emptyAccount(), ...over }
  // ending is the raw sum of the deltas, as it is everywhere else in the module.
  a.ending = Math.round(
    (a.beginning + a.contributions + a.distributions + a.managementFees + a.expenses +
      a.operatingIncome + a.realizedGains + a.unrealizedGains + a.fxTranslation +
      a.transfers + a.carriedInterest + a.unclassified) * 100
  ) / 100
  return a
}

const sumEnding = (m: Map<string, CapitalAccount>) =>
  Math.round(Array.from(m.values()).reduce((s, a) => s + a.ending, 0) * 100) / 100

describe('lookThroughAccount', () => {
  it('splits capital by ownership and carry by carry points, separately', () => {
    // The GP vehicle holds 1m of its own capital in the fund, and has accrued 500k of carry.
    const associate = acct({ contributions: 1_000_000, unrealizedGains: 200_000, carriedInterest: 500_000 })

    // Two members: equal capital, but a 70/30 carry split.
    const members: AssociateMember[] = [
      { lpEntityId: 'a', ownershipWeight: 50, carryWeight: 70 },
      { lpEntityId: 'b', ownershipWeight: 50, carryWeight: 30 },
    ]

    const out = lookThroughAccount(associate, members)

    // Capital follows capital…
    expect(out.get('a')!.contributions).toBe(500_000)
    expect(out.get('b')!.contributions).toBe(500_000)
    expect(out.get('a')!.unrealizedGains).toBe(100_000)

    // …and carry follows POINTS, which is the whole reason these are two allocations.
    expect(out.get('a')!.carriedInterest).toBe(350_000)
    expect(out.get('b')!.carriedInterest).toBe(150_000)

    // Nothing created, nothing lost.
    expect(sumEnding(out)).toBe(associate.ending)
  })

  it('gives carry to a participant who committed NO capital', () => {
    // An advisor with 10 points and no money in. Under the old model they'd be invisible.
    const associate = acct({ contributions: 1_000_000, carriedInterest: 100_000 })
    const members: AssociateMember[] = [
      { lpEntityId: 'partner', ownershipWeight: 100, carryWeight: 90 },
      { lpEntityId: 'advisor', ownershipWeight: 0, carryWeight: 10 },
    ]

    const out = lookThroughAccount(associate, members)

    // The advisor holds none of the capital…
    expect(out.get('advisor')!.contributions).toBe(0)
    // …but does hold their points.
    expect(out.get('advisor')!.carriedInterest).toBe(10_000)
    expect(out.get('advisor')!.ending).toBe(10_000)

    expect(out.get('partner')!.contributions).toBe(1_000_000)
    expect(out.get('partner')!.carriedInterest).toBe(90_000)
    expect(sumEnding(out)).toBe(associate.ending)
  })

  it('handles an associate with capital but no carry accrued yet', () => {
    const associate = acct({ contributions: 800_000, unrealizedGains: 100_000 })
    const out = lookThroughAccount(associate, [
      { lpEntityId: 'a', ownershipWeight: 75, carryWeight: 50 },
      { lpEntityId: 'b', ownershipWeight: 25, carryWeight: 50 },
    ])
    expect(out.get('a')!.contributions).toBe(600_000)
    expect(out.get('a')!.carriedInterest).toBe(0)
    expect(sumEnding(out)).toBe(associate.ending)
  })

  it('carries a reversed accrual through as a negative', () => {
    // NAV fell, so the accrual reversed. The members' carry goes negative with it.
    const associate = acct({ contributions: 1_000_000, carriedInterest: -200_000 })
    const out = lookThroughAccount(associate, [
      { lpEntityId: 'a', ownershipWeight: 50, carryWeight: 80 },
      { lpEntityId: 'b', ownershipWeight: 50, carryWeight: 20 },
    ])
    expect(out.get('a')!.carriedInterest).toBe(-160_000)
    expect(out.get('b')!.carriedInterest).toBe(-40_000)
    expect(sumEnding(out)).toBe(associate.ending)
  })

  it('ties to the cent on an awkward three-way split', () => {
    const associate = acct({ contributions: 1_000_000.01, carriedInterest: 333.33 })
    const out = lookThroughAccount(associate, [
      { lpEntityId: 'a', ownershipWeight: 1, carryWeight: 1 },
      { lpEntityId: 'b', ownershipWeight: 1, carryWeight: 1 },
      { lpEntityId: 'c', ownershipWeight: 1, carryWeight: 1 },
    ])
    // The members must sum EXACTLY to the associate — a capital account that doesn't tie is
    // one nobody can trust.
    expect(sumEnding(out)).toBe(associate.ending)
  })

  it('returns nothing when the associate has no members', () => {
    expect(lookThroughAccount(acct({ contributions: 100 }), []).size).toBe(0)
  })

  it('does not divide by zero when every weight is zero', () => {
    const out = lookThroughAccount(acct({ contributions: 100, carriedInterest: 50 }), [
      { lpEntityId: 'a', ownershipWeight: 0, carryWeight: 0 },
    ])
    expect(out.get('a')!.contributions).toBe(0)
    expect(Number.isFinite(out.get('a')!.ending)).toBe(true)
  })
})

describe('associateMembers', () => {
  it('includes a carry participant with no commitment', () => {
    const members = associateMembers(
      new Map([['partner', 1_000_000]]),
      new Map([['partner', 90], ['advisor', 10]])
    )
    const advisor = members.find(m => m.lpEntityId === 'advisor')!
    expect(advisor.ownershipWeight).toBe(0)
    expect(advisor.carryWeight).toBe(10)
  })

  it('defaults carry to follow ownership when no carry allocation is set', () => {
    // The common case: carry splits the same way capital does. Don't make people type it twice.
    const members = associateMembers(new Map([['a', 700_000], ['b', 300_000]]), new Map())
    expect(members.find(m => m.lpEntityId === 'a')!.carryWeight).toBe(700_000)
    expect(members.find(m => m.lpEntityId === 'b')!.carryWeight).toBe(300_000)
  })

  it('lets carry diverge from ownership when it is set', () => {
    const members = associateMembers(
      new Map([['a', 500_000], ['b', 500_000]]),
      new Map([['a', 75], ['b', 25]])
    )
    expect(members.find(m => m.lpEntityId === 'a')!.ownershipWeight).toBe(500_000)
    expect(members.find(m => m.lpEntityId === 'a')!.carryWeight).toBe(75)
  })

  it('gives a blank member 0 carry when others have explicit points (no dollar/points mixing)', () => {
    // 'robin' has a large commitment but no carry points; the others hold points that sum to 100.
    // Robin must not absorb the carry by having that commitment's dollars normalized against points.
    const members = associateMembers(
      new Map([['robin', 140_000], ['jordan', 140_000], ['gina', 28_000], ['kai', 14_000]]),
      new Map([['jordan', 40.5], ['gina', 14.5], ['kai', 5]])
    )
    expect(members.find(m => m.lpEntityId === 'robin')!.carryWeight).toBe(0)
    expect(members.find(m => m.lpEntityId === 'jordan')!.carryWeight).toBe(40.5)
    // Ownership is untouched — only carry defaults change.
    expect(members.find(m => m.lpEntityId === 'robin')!.ownershipWeight).toBe(140_000)
  })
})
