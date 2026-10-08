import { describe, it, expect } from 'vitest'
import { tieOutState } from './tie-out-state'

describe('tieOutState', () => {
  it('booked when the schedule ties, otherwise the books disagree — nothing waits on a bank match', () => {
    expect(tieOutState({ tied: true })).toBe('booked')
    expect(tieOutState({ tied: false })).toBe('disagrees')
  })
})
