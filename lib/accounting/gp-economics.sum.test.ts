import { describe, expect, it } from 'vitest'
import { sumCapitalAccounts } from './gp-economics'
import { emptyAccount } from './capital-account'

describe('sumCapitalAccounts', () => {
  it('adds an associate position across the vehicles it serves, line by line', () => {
    const fund = { ...emptyAccount(), contributions: 100_000, unrealizedGains: 25_000.1, carriedInterest: 200_000, ending: 325_000.1 }
    const spv = { ...emptyAccount(), carriedInterest: 40_000.05, ending: 40_000.05 }
    const total = sumCapitalAccounts([fund, spv])
    expect(total.contributions).toBe(100_000)
    expect(total.unrealizedGains).toBe(25_000.1)
    expect(total.carriedInterest).toBe(240_000.05)
    expect(total.ending).toBe(365_000.15)
  })

  it('is an empty account when the associate serves nothing', () => {
    expect(sumCapitalAccounts([])).toEqual(emptyAccount())
  })
})
