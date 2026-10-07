import { describe, it, expect } from 'vitest'
import { visibleLpEntityIds, visibleLpInvestorIds } from './lp-scope'

/** Answers `.from(t).select().eq().in()` from fixed rows, honouring eq/in filters. */
function admin(tables: Record<string, any[]>) {
  const from = (t: string) => {
    const preds: ((r: any) => boolean)[] = []
    const chain: any = {
      select: () => chain,
      eq: (k: string, v: any) => { preds.push(r => r[k] === v); return chain },
      in: (k: string, v: any[]) => { preds.push(r => v.includes(r[k])); return chain },
      not: () => chain,
      then: (res: any) => res({ data: (tables[t] ?? []).filter(r => preds.every(p => p(r))), error: null }),
    }
    return chain
  }
  return { from } as any
}

const world = () => admin({
  commitment_events: [{ fund_id: 'f1', vehicle_id: 'v1', lp_entity_id: 'L3' }, { fund_id: 'f1', vehicle_id: 'v2', lp_entity_id: 'L2' }],
  lp_positions: [], lp_capital_events: [], capital_call_lines: [], distribution_lines: [],
  lp_investments: [{ fund_id: 'f1', entity_id: 'L1', portfolio_group: 'Fund I' }, { fund_id: 'f1', entity_id: 'L2', portfolio_group: 'Fund II' }],
  lp_entities: [{ fund_id: 'f1', id: 'L1', investor_id: 'I1' }, { fund_id: 'f1', id: 'L2', investor_id: 'I2' }, { fund_id: 'f1', id: 'L3', investor_id: 'I3' }],
})
const scope = (ids: string[] | null, names: string[] | null) => ({
  access: { fundId: 'f1', vehicles: ids === null ? { all: true, ids: [] } : { all: false, ids } } as any,
  vehicleNames: names, companyIds: null,
})

describe('visibleLpEntityIds — the same rule as lp_entity_ids_readable()', () => {
  it('is null — no filter — for a caller who sees every entity', async () => {
    expect(await visibleLpEntityIds(world(), scope(null, null))).toBeNull()
  })

  it('finds LPs by a position keyed to the entity, or a legacy row tagged with its name', async () => {
    expect((await visibleLpEntityIds(world(), scope(['v1'], ['Fund I'])))!.sort()).toEqual(['L1', 'L3'])
  })

  it('is empty for a caller with no entities', async () => {
    expect(await visibleLpEntityIds(world(), scope([], []))).toEqual([])
  })
})

describe('visibleLpInvestorIds', () => {
  it('is the investors behind the visible LP entities', async () => {
    expect((await visibleLpInvestorIds(world(), scope(['v1'], ['Fund I'])))!.sort()).toEqual(['I1', 'I3'])
  })
})

import { scopeLiveReport } from './lp-scope'
describe('scopeLiveReport — the live LP report across the caller\'s entities only', () => {
  const live = {
    asOf: null,
    rows: [{ entity_id: 'L1', portfolio_group: 'Fund I' }, { entity_id: 'L2', portfolio_group: 'Fund II' }],
    vehicles: [{ group: 'Fund I', source: 'ledger', lps: 1 }, { group: 'Fund II', source: 'ledger', lps: 1 }],
    entityNames: new Map([['L1', 'Ann'], ['L2', 'Bob']]),
  } as any
  it('keeps everything for a caller who sees every entity', () => {
    expect(scopeLiveReport(live, null).rows).toHaveLength(2)
  })
  it('keeps only the caller\'s entities\' rows, vehicles and LP names', () => {
    const s = scopeLiveReport(live, ['Fund I'])
    expect(s.rows.map((r: any) => r.entity_id)).toEqual(['L1'])
    expect(s.vehicles.map((v: any) => v.group)).toEqual(['Fund I'])
    expect(Array.from(s.entityNames.keys())).toEqual(['L1'])
  })
})
