import { describe, it, expect } from 'vitest'
import { entityCap, writeAccess, writableVehicleIds } from './scope'

const member = (caps?: Record<string, 'read' | 'propose'>) =>
  ({ fundId: 'f', vehicles: { all: false, ids: ['v1', 'v2', 'v3'], ...(caps ? { caps } : {}) } }) as any

describe('writeAccess', () => {
  it('is the same context for a member with no caps, and for one who sees everything', () => {
    const plain = member()
    expect(writeAccess(plain)).toBe(plain)
    const all = { fundId: 'f', vehicles: { all: true, ids: [] } } as any
    expect(writeAccess(all)).toBe(all)
    expect(writableVehicleIds(all)).toBeNull()
  })

  it('drops the entities capped below write', () => {
    const a = member({ v2: 'read', v3: 'propose' })
    expect(writeAccess(a).vehicles.ids).toEqual(['v1'])
    expect(writableVehicleIds(a)).toEqual(['v1'])
  })

  it('keeps a propose-level entity for a proposal, still capped, and drops a read-level one', () => {
    const a = writeAccess(member({ v2: 'read', v3: 'propose' }), { proposals: true })
    expect(a.vehicles.ids).toEqual(['v1', 'v3'])
    expect(entityCap(a, 'v3')).toBe('propose')
    expect(entityCap(a, 'v2')).toBeNull()
  })
})
