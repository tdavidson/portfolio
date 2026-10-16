import { describe, expect, it } from 'vitest'
import { vehiclesCarriedAtLpPositions } from './deal-vehicles'

const v = (name: string, kind = 'direct') => ({ name, kind, active: true })
const holding = (group: string, invested = 0, realized = 0, value = 0) => ({ portfolioGroup: [group], totalInvested: invested, totalRealized: realized, unrealizedValue: value })
const names = (xs: { name: string }[]) => xs.map(x => x.name)

describe('entities carried at their LP positions', () => {
  it('takes an entity with no holdings, or only empty ones', () => {
    expect(names(vehiclesCarriedAtLpPositions([v('Copperline Direct'), v('Northwind Holdings LP', 'fund')], [holding('Northwind Holdings LP')]))).toEqual(['Copperline Direct', 'Northwind Holdings LP'])
  })

  it('flips to the holdings the moment one of them carries a figure', () => {
    for (const filled of [holding('Northwind Holdings LP', 250000), holding('Northwind Holdings LP', 0, 80000), holding('Northwind Holdings LP', 0, 0, 1)]) {
      expect(names(vehiclesCarriedAtLpPositions([v('Northwind Holdings LP', 'fund')], [holding('Northwind Holdings LP'), filled]))).toEqual([])
    }
  })

  it('matches names loosely, and never takes a management company, a GP entity or an inactive one', () => {
    expect(vehiclesCarriedAtLpPositions([v('Fund I', 'fund')], [holding(' fund i ', 100)])).toEqual([])
    expect(vehiclesCarriedAtLpPositions([v('Adviser', 'manco'), v('GP LLC', 'associate'), { ...v('Old'), active: false }], [])).toEqual([])
  })
})
