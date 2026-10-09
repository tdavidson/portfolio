import { describe, expect, it } from 'vitest'
import {
  dpi, foldCapital, funded, known, rvpi, totalValue, tvpi, withCommitment, withMultiple, withValue, type CapitalPosition,
} from './capital'

const pos = (over: Partial<CapitalPosition>): CapitalPosition => ({
  key: 'k', name: 'Partner', committed: 0, called: 0, distributions: 0, nav: 0, ...over,
})

describe('capital ratios', () => {
  const p = pos({ committed: 1000, called: 600, distributions: 150, nav: 900 })

  it('measures every multiple against called capital', () => {
    expect(funded(p)).toBeCloseTo(0.6, 9)
    expect(dpi(p)).toBeCloseTo(0.25, 9)
    expect(rvpi(p)).toBeCloseTo(1.5, 9)
    expect(tvpi(p)).toBeCloseTo(1.75, 9)
    expect(totalValue(p)).toBe(1050)
  })

  it('makes DPI and RVPI the two parts of TVPI, so the stacked bar ends where TVPI says', () => {
    expect(dpi(p)! + rvpi(p)!).toBeCloseTo(tvpi(p)!, 9)
  })

  it('has no multiple before anything is called, and no funded share without a commitment', () => {
    const uncalled = pos({ committed: 1000 })
    expect([dpi(uncalled), rvpi(uncalled), tvpi(uncalled)]).toEqual([null, null, null])
    expect(funded(uncalled)).toBe(0)
    expect(funded(pos({ called: 50 }))).toBeNull()
  })

  it('draws an unknown figure as nothing', () => {
    expect([known(null), known(undefined), known(NaN), known(12.5)]).toEqual([0, 0, 0, 12.5])
  })
})

describe('foldCapital', () => {
  it('sums first, so the folded multiple is a ratio of sums and not an average of ratios', () => {
    const small = pos({ committed: 100, called: 100, distributions: 0, nav: 500 })     // 5.00x
    const large = pos({ committed: 10000, called: 10000, distributions: 0, nav: 10000 }) // 1.00x
    const folded = foldCapital([small, large], '2 others')
    expect(folded).toMatchObject({ key: '', name: '2 others', committed: 10100, called: 10100, nav: 10500 })
    expect(tvpi(folded)).toBeCloseTo(10500 / 10100, 9)
    expect(tvpi(folded)).not.toBeCloseTo(3, 1)
  })
})

describe('which positions each chart draws', () => {
  const committedOnly = pos({ key: 'committed', committed: 1000 })
  const called = pos({ key: 'called', committed: 1000, called: 400, nav: 380 })
  const calledNoCommitment = pos({ key: 'no-commitment', called: 400, nav: 380 })
  const empty = pos({ key: 'empty' })
  const all = [committedOnly, called, calledNoCommitment, empty]

  it('called against committed keeps anything committed or called', () => {
    expect(withCommitment(all).map(p => p.key)).toEqual(['committed', 'called', 'no-commitment'])
  })

  it('total value keeps anything called or worth something', () => {
    expect(withValue(all).map(p => p.key)).toEqual(['called', 'no-commitment'])
    expect(withValue([pos({ key: 'written-down', called: 400 })]).map(p => p.key)).toEqual(['written-down'])
  })

  it('the multiple view keeps only positions with called capital to divide by', () => {
    expect(withMultiple(all).map(p => p.key)).toEqual(['called', 'no-commitment'])
  })
})
