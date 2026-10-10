import { describe, it, expect } from 'vitest'
import { labelIndexes, lineDomain, linear, niceTicks } from './scale'

describe('niceTicks', () => {
  it('covers the data on a 1 / 2 / 5 step', () => {
    expect(niceTicks(0, 9_400_000)).toEqual([0, 5_000_000, 10_000_000])
    expect(niceTicks(0, 84)).toEqual([0, 50, 100])
    expect(niceTicks(41, 61)).toEqual([40, 45, 50, 55, 60, 65])
  })

  it('always reaches the largest value, so a line never leaves the plot', () => {
    for (const [min, max] of [[0, 1], [3, 97], [-12, 40], [0.02, 0.9], [1200, 1560]]) {
      const ticks = niceTicks(min, max)
      expect(ticks[0]).toBeLessThanOrEqual(min)
      expect(ticks[ticks.length - 1]).toBeGreaterThanOrEqual(max)
    }
  })

  it('gives a flat series a band, not a zero-height domain', () => {
    const ticks = niceTicks(24, 24)
    expect(ticks[0]).toBeLessThan(24)
    expect(ticks[ticks.length - 1]).toBeGreaterThan(24)
    expect(niceTicks(0, 0).length).toBeGreaterThan(1)
  })

  it('does not drift on fractional steps', () => {
    expect(niceTicks(0, 0.5, 5)).toEqual([0, 0.1, 0.2, 0.3, 0.4, 0.5])
  })

  it('tolerates a reversed or non-finite range', () => {
    expect(niceTicks(10, 0)).toEqual(niceTicks(0, 10))
    expect(niceTicks(NaN, 5)).toEqual([0, 1])
  })
})

describe('lineDomain', () => {
  it('starts at zero when the data is near it', () => {
    expect(lineDomain([1_200_000, 9_400_000]).min).toBe(0)
  })

  it('frames the data when zero is far away', () => {
    // Gross margin moving 41 to 61 should not be flattened against a 0 to 100 axis.
    expect(lineDomain([41, 61]).min).toBe(40)
  })

  it('goes below zero for negative values', () => {
    expect(lineDomain([-5, 20]).min).toBeLessThan(0)
  })

  it('has a domain for no data', () => {
    expect(lineDomain([])).toEqual({ ticks: [0, 1], min: 0, max: 1 })
  })
})

describe('linear', () => {
  it('maps a domain onto a range, inverted for a y-axis', () => {
    const y = linear(0, 100, 150, 10)
    expect(y(0)).toBe(150)
    expect(y(100)).toBe(10)
    expect(y(50)).toBe(80)
  })

  it('centres everything on a zero-width domain instead of dividing by zero', () => {
    expect(linear(5, 5, 0, 100)(5)).toBe(50)
  })
})

describe('labelIndexes', () => {
  it('always labels the first and last reading', () => {
    expect(labelIndexes(11, 3)).toEqual([0, 5, 10])
    expect(labelIndexes(11, 2)).toEqual([0, 10])
    expect(labelIndexes(11, 0.4)).toEqual([0, 10])
  })

  it('labels every reading when there is room', () => {
    expect(labelIndexes(3, 10)).toEqual([0, 1, 2])
  })

  it('handles one reading and none', () => {
    expect(labelIndexes(1, 5)).toEqual([0])
    expect(labelIndexes(0, 5)).toEqual([])
  })
})
