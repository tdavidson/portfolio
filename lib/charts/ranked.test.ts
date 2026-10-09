import { describe, it, expect } from 'vitest'
import { barWidth, multipleBuckets, othersLabel, ratio, topWithOthers, wholePercent } from './ranked'

describe('topWithOthers', () => {
  const items = [5, 40, 10, 30, 20, 1, 2].map(v => ({ v, n: 1 }))
  const fold = (rest: { v: number; n: number }[]) => ({ v: rest.reduce((s, r) => s + r.v, 0), n: rest.length })

  it('ranks largest first and folds the tail into one item', () => {
    const out = topWithOthers(items, 3, i => i.v, fold)
    expect(out.map(i => i.v)).toEqual([40, 30, 20, 18])
    expect(out[3].n).toBe(4)
  })

  it('loses nothing: the rows still sum to the whole', () => {
    const total = items.reduce((s, i) => s + i.v, 0)
    for (const limit of [1, 2, 3, 5, 6, 7, 50]) {
      expect(topWithOthers(items, limit, i => i.v, fold).reduce((s, i) => s + i.v, 0), String(limit)).toBe(total)
    }
  })

  it('does not fold a tail of one: "1 other" would take the row the item itself could have', () => {
    expect(topWithOthers(items, 6, i => i.v, fold).map(i => i.v)).toEqual([40, 30, 20, 10, 5, 2, 1])
    expect(topWithOthers(items, 5, i => i.v, fold)).toHaveLength(6)
  })

  it('shows everything when there is no limit, and leaves the input alone', () => {
    const before = items.map(i => i.v)
    expect(topWithOthers(items, 0, i => i.v, fold)).toHaveLength(7)
    expect(items.map(i => i.v)).toEqual(before)
  })

  it('labels the fold', () => {
    expect(othersLabel(1)).toBe('1 other')
    expect(othersLabel(12)).toBe('12 others')
  })
})

describe('multipleBuckets', () => {
  it('puts each holding in the band for its gross multiple, edges going up', () => {
    const b = multipleBuckets([
      { invested: 100, totalValue: 0 },      // written off
      { invested: 100, totalValue: 99.99 },  // just under cost
      { invested: 100, totalValue: 100 },    // exactly cost is 1x, not below it
      { invested: 100, totalValue: 199 },
      { invested: 100, totalValue: 200 },    // exactly 2x opens the next band
      { invested: 100, totalValue: 999 },
      { invested: 100, totalValue: 1000 },
      { invested: 100, totalValue: 4200 },
    ])
    expect(b.map(x => x.count)).toEqual([2, 2, 1, 1, 2])
    expect(b.map(x => x.label)).toEqual(['Below 1x', '1x to 2x', '2x to 5x', '5x to 10x', '10x and up'])
  })

  it('sums what went in and what it is worth, per band', () => {
    const b = multipleBuckets([
      { invested: 500, totalValue: 100 },
      { invested: 300, totalValue: 0 },
      { invested: 200, totalValue: 2400 },
    ])
    expect(b[0]).toMatchObject({ count: 2, invested: 800, totalValue: 100 })
    expect(b[4]).toMatchObject({ count: 1, invested: 200, totalValue: 2400 })
  })

  it('accounts for every dollar invested, so the columns agree with the page total', () => {
    const holdings = [{ invested: 123.45, totalValue: 80 }, { invested: 900, totalValue: 2700 }, { invested: 50, totalValue: 700 }]
    const b = multipleBuckets(holdings)
    expect(b.reduce((s, x) => s + x.invested, 0)).toBeCloseTo(1073.45, 6)
    expect(b.reduce((s, x) => s + x.totalValue, 0)).toBeCloseTo(3480, 6)
  })

  it('splits each band into proceeds received and value still held', () => {
    const b = multipleBuckets([
      { invested: 100, totalValue: 300, fairValue: 120 },  // partly realized
      { invested: 100, totalValue: 250, fairValue: 0 },    // fully exited
      { invested: 100, totalValue: 400 },                  // no split given: all realized
    ])
    expect(b[2]).toMatchObject({ count: 3, totalValue: 950, held: 120, realized: 830 })
    for (const x of b) expect(x.realized + x.held).toBeCloseTo(x.totalValue, 6)
  })

  it('never lets the held part exceed the column', () => {
    const [below] = multipleBuckets([{ invested: 100, totalValue: 50, fairValue: 80 }])
    expect(below).toMatchObject({ totalValue: 50, held: 50, realized: 0 })
  })

  it('leaves out a holding with nothing invested: it has no multiple', () => {
    const b = multipleBuckets([{ invested: 0, totalValue: 500 }, { invested: -10, totalValue: 5 }, { invested: 100, totalValue: NaN }])
    expect(b.every(x => x.count === 0)).toBe(true)
  })

  it('always returns the same five bands, in order, even for an empty portfolio', () => {
    expect(multipleBuckets([]).map(x => x.key)).toEqual(['below-1', '1-2', '2-5', '5-10', '10-plus'])
  })
})

describe('ratio, wholePercent, barWidth', () => {
  it('never divides by nothing', () => {
    expect(ratio(725, 1000)).toBe(0.725)
    expect(ratio(10, 0)).toBeNull()
    expect(ratio(10, -5)).toBeNull()
    expect(ratio(null, 10)).toBeNull()
    expect(ratio(10, undefined)).toBeNull()
    expect(ratio(NaN, 10)).toBeNull()
  })

  it('writes a share as a whole percentage, and an unknown one as a dash', () => {
    expect(wholePercent(0.725)).toBe('73%')
    expect(wholePercent(1)).toBe('100%')
    expect(wholePercent(null)).toBe('—')
  })

  it('keeps every bar inside its lane', () => {
    expect(barWidth(50, 200)).toBe('25%')
    expect(barWidth(300, 200)).toBe('100%')
    expect(barWidth(-40, 200)).toBe('0%')
    expect(barWidth(null, 200)).toBe('0%')
    expect(barWidth(10, 0)).toBe('0%')
    expect(barWidth(NaN, 200)).toBe('0%')
  })
})
