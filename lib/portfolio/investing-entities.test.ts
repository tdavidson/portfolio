import { describe, expect, it } from 'vitest'
import { investingEntities } from './investing-entities'

describe('investingEntities', () => {
  it('keeps active investing entities, dropping management companies, GP entities and inactive ones', () => {
    expect(investingEntities([
      { id: 'v1', name: 'Fund I', kind: 'fund', active: true },
      { id: 'v2', name: 'SPV A', kind: 'spv' },
      { id: 'm', name: 'Manco', kind: 'manco', active: true },
      { id: 'g', name: 'GP LLC', kind: 'associate', active: true },
      { id: 'x', name: 'Old Fund', kind: 'fund', active: false },
    ])).toEqual([{ id: 'v1', name: 'Fund I' }, { id: 'v2', name: 'SPV A' }])
  })

  it('reads anything else as no entities', () => {
    expect(investingEntities({ error: 'Unauthorized' })).toEqual([])
    expect(investingEntities([{ id: 1 }, null])).toEqual([])
  })
})
