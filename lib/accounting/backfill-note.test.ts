import { describe, it, expect } from 'vitest'
import { bookAllNote } from './backfill-note'

describe('bookAllNote', () => {
  it('says nothing when everything was booked', () => {
    expect(bookAllNote([{ result: { refused: [], conflicted: [] } }, {}])).toBeNull()
  })
  it('counts refusals and companies carried by both, across entities', () => {
    expect(bookAllNote([{ result: { refused: ['a'], conflicted: ['x'] } }, { result: { refused: ['b'], conflicted: ['y', 'z'] } }]))
      .toBe('2 could not be booked, 3 are carried by both the tracker and the journal — see each entity’s status page.')
  })
  it('a conflict alone is still reported', () => {
    expect(bookAllNote([{ result: { refused: [], conflicted: ['x'] } }]))
      .toBe('1 is carried by both the tracker and the journal — see each entity’s status page.')
  })
})
