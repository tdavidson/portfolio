import { describe, expect, it } from 'vitest'
import { matchQbLp } from './match-lp'
const targets = [
  { entityId: 'a', accountId: 'capital-a', name: 'Alex Rivera' },
  { entityId: 'b', accountId: 'capital-b', name: 'Morgan C. Rivera and Alex B. Rivera' },
  { entityId: 'c', accountId: 'capital-c', name: 'Quillon Capital, LLC' },
]
describe('QuickBooks LP attribution', () => {
  it('uses an exact counterparty despite a different sender in the memo', () => {
    expect(matchQbLp(['Quillon Capital LLC'], ['Sender Alex Rivera'], targets)?.entityId).toBe('c')
  })
  it('finds a full name in a bank memo when Name is absent', () => {
    expect(matchQbLp([], ['WIRE ACME BROKERAGE ALEX RIVERA'], targets)?.entityId).toBe('a')
  })
  it('holds unknown counterparties, multiple LPs, and partial names for review', () => {
    expect(matchQbLp(['Other investor'], ['Alex Rivera'], targets)).toBeNull()
    expect(matchQbLp([], ['Alex Rivera or Quillon Capital LLC'], targets)).toBeNull()
    expect(matchQbLp([], ['RIVERA'], targets)).toBeNull()
    expect(matchQbLp([], ['Alex Rivera'], [])).toBeNull()
  })
  it('refuses duplicate normalized registrations', () => {
    expect(matchQbLp(['Alex Rivera'], [], [...targets, { ...targets[0], entityId: 'duplicate' }])).toBeNull()
  })
})
