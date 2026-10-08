import { describe, it, expect } from 'vitest'
import { membersWhoCanSeeCompany, membersWhoCanSeeNote } from './company-audience'

function admin(tables: Record<string, any[] | { error: string }>) {
  return {
    from(t: string) {
      const filters: Array<(r: any) => boolean> = []
      const chain: any = {
        select: () => chain,
        eq: (k: string, v: any) => { filters.push(r => !(k in r) || r[k] === v); return chain },
        then: (res: any) => {
          const src = tables[t]
          if (!src) return res({ data: [], error: null })
          if (!Array.isArray(src)) return res({ data: null, error: { message: src.error } })
          return res({ data: src.filter(r => filters.every(f => f(r))), error: null })
        },
      }
      return chain
    },
  } as any
}

const base = {
  fund_members: [
    { user_id: 'admin', role: 'admin' },
    { user_id: 'mine', role: 'member' },
    { user_id: 'other', role: 'member' },
    { user_id: 'all', role: 'member', all_entities: true },
  ],
  fund_vehicles: [{ id: 'v1' }, { id: 'v2' }],
  fund_member_vehicles: [
    { user_id: 'mine', vehicle_id: 'v1' },
    { user_id: 'other', vehicle_id: 'v2' },
  ],
  company_vehicles: [{ company_id: 'c1', vehicle_id: 'v1' }],
}

describe('membersWhoCanSeeCompany — who a company\'s notifications may go to', () => {
  it('admins, members granted every entity, and members granted an entity holding the company', async () => {
    const who = await membersWhoCanSeeCompany(admin(base), 'f1', 'c1')
    expect(Array.from(who!).sort()).toEqual(['admin', 'all', 'mine'])
  })
  it('a company linked to no entity: unscoped members only', async () => {
    const who = await membersWhoCanSeeCompany(admin(base), 'f1', 'c9')
    expect(Array.from(who!).sort()).toEqual(['admin', 'all'])
  })
  it('before the entity migration (no grants table): null — everyone, as before', async () => {
    expect(await membersWhoCanSeeCompany(admin({ ...base, fund_member_vehicles: { error: 'relation does not exist' } }), 'f1', 'c1')).toBeNull()
  })
  it('fails closed when the members cannot be read: nobody, rather than everybody', async () => {
    expect(await membersWhoCanSeeCompany(admin({ ...base, fund_members: { error: 'timeout' } }), 'f1', 'c1')).toEqual(new Set())
  })
  it('holding every entity one by one is not "All entities"', async () => {
    const t = { ...base, fund_member_vehicles: [...(base.fund_member_vehicles as any[]), { user_id: 'mine', vehicle_id: 'v2' }] }
    expect(Array.from((await membersWhoCanSeeCompany(admin(t), 'f1', 'c9'))!).sort()).toEqual(['admin', 'all'])
  })
})

describe('membersWhoCanSeeNote — who a note may be emailed to', () => {
  it('a note for Fund II: unscoped members and those granted Fund II', async () => {
    expect(Array.from((await membersWhoCanSeeNote(admin(base), 'f1', { vehicleId: 'v2', companyId: null }))!).sort()).toEqual(['admin', 'all', 'other'])
  })
  it('a Fund I note about a company: granted Fund I AND able to see the company', async () => {
    const t = { ...base, company_vehicles: [{ company_id: 'c1', vehicle_id: 'v2' }] }
    // 'mine' holds Fund I but c1 is Fund II's only — they see neither the company nor its note.
    expect(Array.from((await membersWhoCanSeeNote(admin(t), 'f1', { vehicleId: 'v1', companyId: 'c1' }))!).sort()).toEqual(['admin', 'all'])
  })
  it('a note with no entity: unscoped members only', async () => {
    expect(Array.from((await membersWhoCanSeeNote(admin(base), 'f1', { vehicleId: null, companyId: null }))!).sort()).toEqual(['admin', 'all'])
  })
})
