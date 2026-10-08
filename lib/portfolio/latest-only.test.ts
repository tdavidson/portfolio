import { describe, expect, it } from 'vitest'
import { latestOnly } from './latest-only'

describe('latestOnly', () => {
  it('lets only the most recently begun request apply its result', () => {
    const g = latestOnly()
    const first = g.begin()
    expect(first()).toBe(true)
    const second = g.begin()
    expect(first()).toBe(false)
    expect(second()).toBe(true)
  })
})
