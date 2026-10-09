import { describe, expect, it } from 'vitest'
import { foldPositions, heldPositions, positionsByHolding, type HoldingRow } from './holdings'

const row = (over: Partial<HoldingRow>): HoldingRow => ({
  companyId: 'a', companyName: 'Acme', status: 'active',
  totalInvested: 0, totalRealized: 0, unrealizedValue: 0, totalCostBasisExited: 0, ...over,
})

describe('positionsByHolding', () => {
  it('sums a holding owned through two vehicles into one position', () => {
    const [p, ...rest] = positionsByHolding([
      row({ totalInvested: 100, unrealizedValue: 250 }),
      row({ totalInvested: 50, unrealizedValue: 125 }),
    ])
    expect(rest).toEqual([])
    expect(p).toMatchObject({ companyId: 'a', name: 'Acme', invested: 150, cost: 150, fairValue: 375, totalValue: 375 })
  })

  it('takes exited cost out of cost but leaves it in invested', () => {
    const [p] = positionsByHolding([
      row({ totalInvested: 100, totalCostBasisExited: 40, totalRealized: 90, unrealizedValue: 120 }),
    ])
    expect(p.invested).toBe(100)
    expect(p.cost).toBe(60)
    expect(p.fairValue).toBe(120)
    expect(p.totalValue).toBe(210)
  })

  it('keeps holdings apart and in the order they first appear', () => {
    const out = positionsByHolding([
      row({ companyId: 'b', companyName: 'Beta', totalInvested: 1 }),
      row({ companyId: 'a', totalInvested: 2 }),
      row({ companyId: 'b', companyName: 'Beta', totalInvested: 3 }),
    ])
    expect(out.map(p => [p.companyId, p.invested])).toEqual([['b', 4], ['a', 2]])
  })

  it('treats a missing figure as zero rather than poisoning the sum', () => {
    const [p] = positionsByHolding([
      row({ totalInvested: 100, unrealizedValue: NaN }),
      row({ totalInvested: 100, unrealizedValue: 80 }),
    ])
    expect(p.fairValue).toBe(80)
    expect(p.totalValue).toBe(80)
  })
})

describe('heldPositions', () => {
  it('drops a fully exited holding and keeps one written down to nothing', () => {
    const positions = positionsByHolding([
      row({ companyId: 'exited', totalInvested: 100, totalCostBasisExited: 100, totalRealized: 300 }),
      row({ companyId: 'marked-down', totalInvested: 100, unrealizedValue: 0 }),
      row({ companyId: 'held', totalInvested: 100, unrealizedValue: 140 }),
    ])
    expect(heldPositions(positions).map(p => p.companyId)).toEqual(['marked-down', 'held'])
  })

  it('does not keep a row alive on float dust', () => {
    const positions = positionsByHolding([
      row({ totalInvested: 0.1 + 0.2, totalCostBasisExited: 0.3 }),
    ])
    expect(positions[0].cost).not.toBe(0)
    expect(heldPositions(positions)).toEqual([])
  })
})

describe('foldPositions', () => {
  it('sums the tail into one named position with no link target', () => {
    const rest = positionsByHolding([
      row({ companyId: 'a', totalInvested: 10, unrealizedValue: 30 }),
      row({ companyId: 'b', totalInvested: 20, totalCostBasisExited: 5, totalRealized: 9, unrealizedValue: 15 }),
    ])
    expect(foldPositions(rest, '2 others')).toEqual({
      companyId: '', name: '2 others', status: 'active', invested: 30, cost: 25, fairValue: 45, totalValue: 54,
    })
  })
})
