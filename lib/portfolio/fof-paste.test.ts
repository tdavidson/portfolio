import { describe, it, expect } from 'vitest'
import { matchHoldings, type GridInputRow } from './fof-paste'

const HOLDINGS = [
  { id: 'f1', name: 'Acme Ventures III', aliases: ['Acme III'] },
  { id: 'f2', name: 'Beta Growth Fund II', aliases: null },
]

describe('matchHoldings', () => {
  const row = (fundName: string): GridInputRow => ({ fundName, navAsOf: '2025-09-30', reportedNav: 4_000_000, calls: 0, distributions: 0 })
  const rows = [row('Acme Ventures III'), row('acme  iii'), row('Gamma Partners')]

  it('matches on exact name, case- and whitespace-insensitively', () => {
    const m = matchHoldings([rows[0]], HOLDINGS)
    expect(m[0].companyId).toBe('f1')
  })

  it('matches on an alias', () => {
    const m = matchHoldings([rows[1]], HOLDINGS)
    expect(m[0].companyId).toBe('f1')
    expect(m[0].matchedName).toBe('Acme Ventures III')
  })

  it('leaves an unknown fund unmatched rather than guessing', () => {
    // 20+ managers with similar names — a wrong fuzzy match silently books a call against
    // the wrong position. Unmatched is a review item; mismatched is a restatement.
    const m = matchHoldings([rows[2]], HOLDINGS)
    expect(m[0].companyId).toBeNull()
    expect(m[0].matchedName).toBeNull()
  })

  it('returns one result per input row, in order', () => {
    const m = matchHoldings(rows, HOLDINGS)
    expect(m).toHaveLength(3)
    expect(m.map(r => r.companyId)).toEqual(['f1', 'f1', null])
  })
})
