import { describe, it, expect } from 'vitest'
import { noteVisible, noteEntityCandidates, resolveNoteEntity } from './entity'

const member = { access: { fundId: 'f1', vehicles: { all: false, ids: ['v1', 'v3'] } }, vehicleNames: ['Fund I', 'Fund III'], companyIds: ['c1'] } as any
const everyone = { access: { fundId: 'f1', vehicles: { all: true, ids: [] } }, vehicleNames: null, companyIds: null } as any

describe('noteVisible — every note belongs to an entity', () => {
  it('a member sees notes for their entities, about no company or about a company of theirs', () => {
    expect(noteVisible({ vehicle_id: 'v1', company_id: null }, member)).toBe(true)
    expect(noteVisible({ vehicle_id: 'v1', company_id: 'c1' }, member)).toBe(true)
  })
  it('not another entity\'s note, even about a company they share', () => {
    expect(noteVisible({ vehicle_id: 'v2', company_id: 'c1' }, member)).toBe(false)
  })
  it('not a note of theirs about a company they cannot see', () => {
    expect(noteVisible({ vehicle_id: 'v1', company_id: 'c9' }, member)).toBe(false)
  })
  it('a note with no entity is for unscoped callers only', () => {
    expect(noteVisible({ vehicle_id: null, company_id: null }, member)).toBe(false)
    expect(noteVisible({ vehicle_id: null, company_id: null }, everyone)).toBe(true)
  })
})

const vehicles = [
  { id: 'v1', name: 'Fund I', kind: 'fund', active: true },
  { id: 'v2', name: 'Fund II', kind: 'fund', active: true },
  { id: 'v3', name: 'Fund III', kind: 'fund', active: true },
  { id: 'v4', name: 'Old SPV', kind: 'spv', active: false },
  { id: 'm1', name: 'Manco', kind: 'manco', active: true },
]
const links = [{ company_id: 'c1', vehicle_id: 'v1' }, { company_id: 'c1', vehicle_id: 'v2' }]
const admin = {
  from: (t: string) => {
    const f: Array<(r: any) => boolean> = []
    const chain: any = {
      select: () => chain, order: () => chain,
      eq: (k: string, v: any) => { if (k !== 'fund_id') f.push(r => r[k] === v); return chain },
      then: (res: any) => res({ data: (t === 'fund_vehicles' ? vehicles : t === 'company_vehicles' ? links : []).filter(r => f.every(x => x(r))), error: null }),
    }
    return chain
  },
} as any

describe('noteEntityCandidates — which entities a new note may be for', () => {
  it('a general note: the writer\'s active entities (not the management company)', async () => {
    expect((await noteEntityCandidates(admin, member, null)).map(v => v.name)).toEqual(['Fund I', 'Fund III'])
  })
  it('a company note: the company\'s entities that are also the writer\'s', async () => {
    expect((await noteEntityCandidates(admin, member, 'c1')).map(v => v.name)).toEqual(['Fund I'])
    expect((await noteEntityCandidates(admin, everyone, 'c1')).map(v => v.name)).toEqual(['Fund I', 'Fund II'])
  })
})

describe('resolveNoteEntity', () => {
  it('takes the only candidate when none is named', async () => {
    expect(await resolveNoteEntity(admin, member, 'c1', null)).toEqual({ vehicleId: 'v1' })
  })
  it('asks for a choice when there are several', async () => {
    expect(await resolveNoteEntity(admin, member, null, null)).toMatchObject({ status: 400, error: expect.stringMatching(/Choose/) })
  })
  it('refuses an entity that is not a candidate, as unknown', async () => {
    expect(await resolveNoteEntity(admin, member, null, 'v2')).toMatchObject({ status: 400, error: expect.stringMatching(/entity/) })
    expect(await resolveNoteEntity(admin, member, null, 'v3')).toEqual({ vehicleId: 'v3' })
  })
})
