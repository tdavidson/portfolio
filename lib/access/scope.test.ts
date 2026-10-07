import { describe, it, expect } from 'vitest'
import { vehicleScopeFromRow, canSeeVehicle, visibleVehicleIds } from './scope'
import type { AccessContext } from './effective'

const ctx = (role: AccessContext['role'], vehicles: AccessContext['vehicles']): AccessContext => ({
  fundId: 'f1', userId: 'u1', role, features: {} as any, grants: {}, defaults: {}, vehicles,
})

describe('vehicleScopeFromRow — what access_context said about entities', () => {
  it('gives an admin every entity, whatever the row lists', () => {
    expect(vehicleScopeFromRow('admin', ['v1'])).toEqual({ all: true, ids: ['v1'], enforced: true })
  })

  it('gives a member exactly the entities listed', () => {
    expect(vehicleScopeFromRow('member', ['v2', 'v1'])).toEqual({ all: false, ids: ['v2', 'v1'], enforced: true })
  })

  it('gives a member none when the list is empty — a new member sees nothing until granted', () => {
    expect(vehicleScopeFromRow('member', [])).toEqual({ all: false, ids: [], enforced: true })
  })

  it('treats a row with no vehicles key as everything — the RPC predates entity access', () => {
    // Code deployed before 20261007100000 is pushed must behave exactly as before.
    expect(vehicleScopeFromRow('member', undefined)).toEqual({ all: true, ids: [], enforced: false })
  })

  it('drops anything that is not a string id', () => {
    expect(vehicleScopeFromRow('viewer', ['v1', 3, null])).toEqual({ all: false, ids: ['v1'], enforced: true })
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

// ---- Reads across companies and transactions. ---------------------------------------------
import { scopeTransactions, visibleCompanyIds } from './scope'

describe('scopeTransactions — a shared company shows only your entities\' positions', () => {
  const rows = [
    { id: 'a', portfolio_group: 'Fund I' },
    { id: 'b', portfolio_group: 'Fund II' },
    { id: 'c', portfolio_group: null }, // a company-wide price signal
  ]

  it('keeps everything when the caller sees every entity', () => {
    expect(scopeTransactions(rows, null).map(r => r.id)).toEqual(['a', 'b', 'c'])
  })

  it('keeps the caller\'s entities and the company-wide price signals', () => {
    expect(scopeTransactions(rows, ['Fund I']).map(r => r.id)).toEqual(['a', 'c'])
  })

  it('keeps only price signals for a caller with no entities', () => {
    expect(scopeTransactions(rows, []).map(r => r.id)).toEqual(['c'])
  })
})

describe('visibleCompanyIds', () => {
  const admin = (links: { company_id: string; vehicle_id: string }[]) => {
    const chain: any = {
      select: () => chain,
      in: (_k: string, ids: string[]) => { chain.ids = ids; return chain },
      eq: () => chain,
      then: (res: any) => res({ data: links.filter(l => chain.ids.includes(l.vehicle_id)), error: null }),
    }
    return { from: () => chain } as any
  }

  it('is null — no filter — for a caller who sees every entity', async () => {
    expect(await visibleCompanyIds(admin([]), ctx('admin', { all: true, ids: [] }))).toBeNull()
  })

  it('lists the companies linked to the caller\'s entities, once each', async () => {
    const links = [{ company_id: 'c1', vehicle_id: 'v1' }, { company_id: 'c1', vehicle_id: 'v2' }, { company_id: 'c2', vehicle_id: 'v2' }]
    expect(await visibleCompanyIds(admin(links), ctx('member', { all: false, ids: ['v1', 'v2'] }))).toEqual(['c1', 'c2'])
    expect(await visibleCompanyIds(admin(links), ctx('member', { all: false, ids: ['v1'] }))).toEqual(['c1'])
  })

  it('is empty, without a query, for a caller with no entities', async () => {
    const none = { from: () => { throw new Error('should not query') } } as any
    expect(await visibleCompanyIds(none, ctx('member', { all: false, ids: [] }))).toEqual([])
  })
})

import { scopeGroups } from './scope'
describe('scopeGroups', () => {
  it('hides the other entities that hold a shared company', () => {
    expect(scopeGroups(['Fund I', 'Fund II'], ['Fund I'])).toEqual(['Fund I'])
    expect(scopeGroups(['Fund I', 'Fund II'], null)).toEqual(['Fund I', 'Fund II'])
    expect(scopeGroups(null, ['Fund I'])).toEqual([])
  })
})

import { groupWriteDenial } from './scope'
describe('groupWriteDenial — recording against an entity', () => {
  it('lets a caller who sees every entity write anything', () => {
    expect(groupWriteDenial(null, 'Fund II')).toBeNull()
    expect(groupWriteDenial(null, null)).toBeNull()
  })

  it('lets a member write to their own entity', () => {
    expect(groupWriteDenial(['Fund I'], 'Fund I')).toBeNull()
  })

  it('refuses a member an entity they cannot see — including one that does not exist yet', () => {
    expect(groupWriteDenial(['Fund I'], 'Fund II')).toMatch(/access to that entity/)
    expect(groupWriteDenial(['Fund I'], 'Brand New Fund')).toMatch(/access to that entity/)
  })

  it('refuses a member a company-wide row — it re-prices every entity\'s position, not just theirs', () => {
    expect(groupWriteDenial(['Fund I'], null)).toMatch(/every entity/)
    expect(groupWriteDenial(['Fund I'], '')).toMatch(/every entity/)
  })
})

import { mergeGroupsForWrite } from './scope'
describe('mergeGroupsForWrite — a member edits only their own entities on a company', () => {
  it('applies anything for a caller who sees every entity', () => {
    expect(mergeGroupsForWrite(['Fund I', 'Fund II'], ['Fund III'], null)).toEqual({ groups: ['Fund III'] })
  })

  it('keeps the entities the member cannot see, however they edit', () => {
    // They were shown ['Fund I'] and removed it; Fund II stays.
    expect(mergeGroupsForWrite(['Fund I', 'Fund II'], [], ['Fund I'])).toEqual({ groups: ['Fund II'] })
  })

  it('refuses adding an entity they cannot see', () => {
    expect(mergeGroupsForWrite(['Fund I'], ['Fund I', 'Fund II'], ['Fund I'])).toEqual({ error: "You don't have access to that entity." })
  })
})

import { scopeCompanyRows } from './scope'
describe('scopeCompanyRows', () => {
  const rows = [{ id: 'c1', company_id: 'c1' }, { id: 'c2', company_id: 'c2' }, { id: 'n0', company_id: null }]
  it('keeps everything with no filter', () => {
    expect(scopeCompanyRows(rows, null).map(r => r.id)).toEqual(['c1', 'c2', 'n0'])
  })
  it('keeps visible companies by id', () => {
    expect(scopeCompanyRows(rows, ['c2']).map(r => r.id)).toEqual(['c2'])
  })
  it('keys on another column, and keeps rows about no company when asked', () => {
    expect(scopeCompanyRows(rows, ['c1'], 'company_id', { keepUnlinked: true }).map(r => r.id)).toEqual(['c1', 'n0'])
  })
})

import { dealEntityProblem } from './scope'
describe('dealEntityProblem — assigning a deal to an entity', () => {
  const member = ctx('member', { all: false, ids: ['v1'] })
  const admin = ctx('admin', { all: true, ids: [] })
  it('lets a member assign to their own entity', () => {
    expect(dealEntityProblem(member, 'v1')).toBeNull()
  })
  it('refuses a member another entity, or leaving it unassigned (they would lose sight of it)', () => {
    expect(dealEntityProblem(member, 'v2')).toMatch(/access to that entity/)
    expect(dealEntityProblem(member, null)).toMatch(/Choose/)
  })
  it('lets an admin assign anywhere, or leave it unassigned', () => {
    expect(dealEntityProblem(admin, 'v9')).toBeNull()
    expect(dealEntityProblem(admin, null)).toBeNull()
  })
})

import { newCompanyGroupsProblem } from './scope'
describe('newCompanyGroupsProblem — creating a company', () => {
  it('lets a caller who sees every entity create it anywhere, or nowhere yet', () => {
    expect(newCompanyGroupsProblem(null, ['Fund II'])).toBeNull()
    expect(newCompanyGroupsProblem(null, [])).toBeNull()
  })
  it('requires a member to name at least one of their entities — else they lose the company they made', () => {
    expect(newCompanyGroupsProblem(['Fund I'], [])).toMatch(/Choose/)
    expect(newCompanyGroupsProblem(['Fund I'], undefined)).toMatch(/Choose/)
    expect(newCompanyGroupsProblem(['Fund I'], ['Fund I'])).toBeNull()
  })
  it('refuses a member an entity they cannot see, or one that does not exist yet', () => {
    expect(newCompanyGroupsProblem(['Fund I'], ['Fund I', 'Fund II'])).toMatch(/access to that entity/)
    expect(newCompanyGroupsProblem(['Fund I'], ['New Fund'])).toMatch(/access to that entity/)
  })
})

import { filterByCompany } from './scope'
describe('filterByCompany — scoping a query to visible companies', () => {
  const q = () => {
    const calls: any[] = []
    const chain: any = {
      in: (...a: any[]) => { calls.push(['in', ...a]); return chain },
      is: (...a: any[]) => { calls.push(['is', ...a]); return chain },
      or: (...a: any[]) => { calls.push(['or', ...a]); return chain },
      calls,
    }
    return chain
  }
  it('adds nothing for a caller who sees every entity', () => {
    expect(filterByCompany(q(), null).calls).toEqual([])
  })
  it('keeps only visible companies — rows about no company drop', () => {
    expect(filterByCompany(q(), ['c1', 'c2']).calls).toEqual([['in', 'company_id', ['c1', 'c2']]])
  })
  it('keeps rows about no company too, when asked', () => {
    expect(filterByCompany(q(), ['c1'], { keepUnlinked: true }).calls).toEqual([['or', 'company_id.is.null,company_id.in.(c1)']])
    expect(filterByCompany(q(), [], { keepUnlinked: true }).calls).toEqual([['is', 'company_id', null]])
  })
  it('matches nothing for a caller with no companies', () => {
    expect(filterByCompany(q(), []).calls).toEqual([['in', 'company_id', []]])
  })
})
