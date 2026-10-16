import { describe, it, expect } from 'vitest'
import { groupBySection, isGrouped, EMPTY_VEHICLE_GROUPS, type VehicleGroupsPayload } from './vehicle-groups'

const payload: VehicleGroupsPayload = {
  groups: [
    { id: 'g-spv', name: 'SPVs', position: 1 },
    { id: 'g-flag', name: 'Flagship', position: 0 },
    { id: 'g-empty', name: 'Empty', position: 2 },
  ],
  assignments: [
    { vehicleId: 'v1', name: 'Ashgrove Capital Group III, LP', aliases: [], groupId: 'g-flag' },
    { vehicleId: 'v2', name: 'Tern SPV LP', aliases: ['Tern SPV'], groupId: 'g-spv' },
    { vehicleId: 'v3', name: 'Ashgrove Capital Group II, LP', aliases: [], groupId: 'g-flag' },
  ],
}

type Row = { id: string | null; name: string }
const rows: Row[] = [
  { id: 'v2', name: 'Tern SPV LP' },
  { id: 'v9', name: 'Alice' },
  { id: 'v3', name: 'Ashgrove Capital Group II, LP' },
  { id: null, name: 'tern spv' }, // legacy name-only row on an alias
  { id: 'v1', name: 'Ashgrove Capital Group III, LP' },
]
const key = (r: Row) => ({ id: r.id, name: r.name })

describe('groupBySection', () => {
  it('sections by group position, keeps the incoming order within, and puts the rest in Other', () => {
    const s = groupBySection(rows, payload, key)
    expect(s.map(x => x.label)).toEqual(['Flagship', 'SPVs', 'Other'])
    expect(s[0].items.map(r => r.id)).toEqual(['v3', 'v1'])
    expect(s[1].items.map(r => r.name)).toEqual(['Tern SPV LP', 'tern spv'])
    expect(s[2].items.map(r => r.name)).toEqual(['Alice'])
    expect(isGrouped(s, payload)).toBe(true)
  })

  it('stays one flat section when nothing is grouped', () => {
    const s = groupBySection(rows, EMPTY_VEHICLE_GROUPS, key)
    expect(s).toHaveLength(1)
    expect(s[0].group).toBeNull()
    expect(s[0].items).toBe(rows)
    expect(isGrouped(s, EMPTY_VEHICLE_GROUPS)).toBe(false)
  })

  it('keeps the Other heading when a filter leaves only ungrouped rows', () => {
    const s = groupBySection([{ id: 'v9', name: 'Alice' }], payload, key)
    expect(s.map(x => x.label)).toEqual(['Other'])
    expect(isGrouped(s, payload)).toBe(true)
  })

  it('ignores an assignment to a group it was not sent', () => {
    const s = groupBySection(rows, { ...payload, groups: payload.groups.filter(g => g.id !== 'g-spv') }, key)
    expect(s.map(x => x.label)).toEqual(['Flagship', 'Other'])
  })
})
