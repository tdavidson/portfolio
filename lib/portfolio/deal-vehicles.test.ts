import { describe, expect, it } from 'vitest'
import { vehiclesCarriedAtLpPositions } from './deal-vehicles'

const v = (name: string, kind = 'direct') => ({ name, kind, active: true })
const holding = (group: string, invested = 0, realized = 0, value = 0) => ({ portfolioGroup: [group], totalInvested: invested, totalRealized: realized, unrealizedValue: value })
const names = (xs: { name: string }[]) => xs.map(x => x.name)

describe('entities carried at their LP positions', () => {
  it('takes an entity with no holdings, or only empty ones', () => {
    expect(names(vehiclesCarriedAtLpPositions([v('Triple Lift'), v('3SE Holdings LP', 'fund')], [holding('3SE Holdings LP')]))).toEqual(['Triple Lift', '3SE Holdings LP'])
  })

  it('flips to the holdings the moment one of them carries a figure', () => {
    for (const filled of [holding('3SE Holdings LP', 250000), holding('3SE Holdings LP', 0, 80000), holding('3SE Holdings LP', 0, 0, 1)]) {
      expect(names(vehiclesCarriedAtLpPositions([v('3SE Holdings LP', 'fund')], [holding('3SE Holdings LP'), filled]))).toEqual([])
    }
  })

  it('matches names loosely, and never takes a management company, a GP entity or an inactive one', () => {
    expect(vehiclesCarriedAtLpPositions([v('Fund I', 'fund')], [holding(' fund i ', 100)])).toEqual([])
    expect(vehiclesCarriedAtLpPositions([v('Adviser', 'manco'), v('GP LLC', 'associate'), { ...v('Old'), active: false }], [])).toEqual([])
  })
})
