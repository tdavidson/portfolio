import { describe, it, expect } from 'vitest'
import { vehicleScopeFromRow, canSeeVehicle, visibleVehicleIds } from './scope'
import type { AccessContext } from './effective'

const ctx = (role: AccessContext['role'], vehicles: AccessContext['vehicles']): AccessContext => ({
  fundId: 'f1', userId: 'u1', role, features: {} as any, grants: {}, defaults: {}, vehicles,
})

describe('vehicleScopeFromRow — what access_context said about entities', () => {
  it('gives an admin every entity, whatever the row lists', () => {
    expect(vehicleScopeFromRow('admin', ['v1'])).toEqual({ all: true, ids: ['v1'] })
  })

  it('gives a member exactly the entities listed', () => {
    expect(vehicleScopeFromRow('member', ['v2', 'v1'])).toEqual({ all: false, ids: ['v2', 'v1'] })
  })

  it('gives a member none when the list is empty — a new member sees nothing until granted', () => {
    expect(vehicleScopeFromRow('member', [])).toEqual({ all: false, ids: [] })
  })

  it('treats a row with no vehicles key as everything — the RPC predates entity access', () => {
    // Code deployed before 20261007100000 is pushed must behave exactly as before.
    expect(vehicleScopeFromRow('member', undefined)).toEqual({ all: true, ids: [] })
  })

  it('drops anything that is not a string id', () => {
    expect(vehicleScopeFromRow('viewer', ['v1', 3, null])).toEqual({ all: false, ids: ['v1'] })
  })
})

describe('canSeeVehicle', () => {
  it('lets an admin see any entity, and a legacy one with no registry row', () => {
    const admin = ctx('admin', { all: true, ids: [] })
    expect(canSeeVehicle(admin, 'v9')).toBe(true)
    expect(canSeeVehicle(admin, null)).toBe(true)
  })

  it('lets a member see only granted entities', () => {
    const member = ctx('member', { all: false, ids: ['v1'] })
    expect(canSeeVehicle(member, 'v1')).toBe(true)
    expect(canSeeVehicle(member, 'v2')).toBe(false)
  })

  it('refuses a member a legacy entity with no registry row — it cannot be granted', () => {
    expect(canSeeVehicle(ctx('member', { all: false, ids: ['v1'] }), null)).toBe(false)
  })
})

describe('visibleVehicleIds', () => {
  it('is null — no filter — for a caller who sees everything', () => {
    expect(visibleVehicleIds(ctx('admin', { all: true, ids: ['v1'] }))).toBeNull()
  })

  it('is the granted list otherwise, possibly empty', () => {
    expect(visibleVehicleIds(ctx('member', { all: false, ids: ['v1'] }))).toEqual(['v1'])
    expect(visibleVehicleIds(ctx('member', { all: false, ids: [] }))).toEqual([])
  })
})
