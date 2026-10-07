import { describe, it, expect } from 'vitest'
import { relatedEntities } from './assistant'

const veh = [
  { id: 'f1', name: 'Fund I', kind: 'fund' },
  { id: 'f2', name: 'Fund II', kind: 'fund' },
  { id: 'gp1', name: 'GP I LLC', kind: 'associate' },
  { id: 'gp2', name: 'GP II LLC', kind: 'associate' },
]
const links = [
  { gpVehicleId: 'gp1', servedVehicleId: 'f1' },
  { gpVehicleId: 'gp1', servedVehicleId: 'f2' },
]
const names = (r: any[]) => r.map(v => v.name).sort()
const member = (ids: string[]) => ({ vehicles: { all: false, ids } })
const everyone = { vehicles: { all: true, ids: [] } }

describe('relatedEntities — the books the Analyst may add beside the primary vehicle', () => {
  it('unchanged for an unscoped caller: a GP serving the fund; from a GP, every fund it serves', () => {
    expect(names(relatedEntities(veh, links, 'f1', everyone))).toEqual(['GP I LLC'])
    expect(names(relatedEntities(veh, links, 'gp1', everyone))).toEqual(['Fund I', 'Fund II'])
  })
  it('a scoped caller gets only related entities they were granted', () => {
    expect(names(relatedEntities(veh, links, 'f1', member(['f1'])))).toEqual([])
    expect(names(relatedEntities(veh, links, 'gp1', member(['gp1', 'f1'])))).toEqual(['Fund I'])
  })
  it('the no-links fallback (every associate) is filtered too', () => {
    expect(names(relatedEntities(veh, [], 'f1', member(['f1', 'gp2'])))).toEqual(['GP II LLC'])
  })
})
