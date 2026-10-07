import { describe, it, expect } from 'vitest'
import { visibleLpEntityIds, visibleLpInvestorIds } from './lp-scope'

/**
 * The database answers through two RPCs (20261007100300): lp_entity_ids_for(vehicle ids, names) and
 * lp_investor_ids_for(entity ids). This fake applies the same rule to fixed rows, and records calls.
 */
function admin(tables: Record<string, any[]>) {
  const calls: any[] = []
  const rpc = async (fn: string, args: any) => {
    calls.push([fn, args])
    if (fn === 'lp_entity_ids_for') {
      const ids = new Set<string>()
      for (const r of tables.commitment_events ?? []) if (args.p_vehicle_ids.includes(r.vehicle_id)) ids.add(r.lp_entity_id)
      for (const r of tables.lp_investments ?? []) if (args.p_names.includes(r.portfolio_group)) ids.add(r.entity_id)
      return { data: Array.from(ids), error: null }
    }
    if (fn === 'lp_investor_ids_for') {
      return { data: Array.from(new Set((tables.lp_entities ?? []).filter(e => args.p_entity_ids.includes(e.id)).map(e => e.investor_id))), error: null }
    }
    return { data: null, error: { message: 'unknown rpc' } }
  }
  return { rpc, calls } as any
}

const world = () => admin({
  commitment_events: [{ fund_id: 'f1', vehicle_id: 'v1', lp_entity_id: 'L3' }, { fund_id: 'f1', vehicle_id: 'v2', lp_entity_id: 'L2' }],
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

  it('asks the database in one call, so no row cap can silently drop an LP', async () => {
    const a = world()
    await visibleLpEntityIds(a, scope(['v1'], ['Fund I']))
    expect(a.calls).toEqual([['lp_entity_ids_for', { p_vehicle_ids: ['v1'], p_names: ['Fund I'] }]])
  })

  it('fails closed — no LPs — when the lookup errors', async () => {
    const broken = { rpc: async () => ({ data: null, error: { message: 'boom' } }) } as any
    expect(await visibleLpEntityIds(broken, scope(['v1'], ['Fund I']))).toEqual([])
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

import { lpDocumentVisible } from './lp-scope'
describe('lpDocumentVisible — the lp_documents rule, in code', () => {
  const adminWith = (doc: any, shares: any[]) => {
    const from = (t: string) => {
      const chain: any = { select: () => chain, eq: () => chain, in: () => chain,
        maybeSingle: async () => ({ data: t === 'lp_documents' ? doc : null, error: null }),
        then: (res: any) => res({ data: t === 'lp_document_shares' ? shares : [], error: null }) }
      return chain
    }
    return { from } as any
  }
  const lp = (investorIds: string[] | null) => ({ scope: {} as any, entityIds: null, investorIds })

  it('shows a fund-wide document to every member', async () => {
    expect(await lpDocumentVisible(adminWith({ id: 'd', scope: 'fund' }, []), 'f1', 'd', lp(['I1']))).toBe(true)
  })
  it('shows an investor document only when shared with a visible investor', async () => {
    expect(await lpDocumentVisible(adminWith({ id: 'd', scope: 'investor' }, [{ lp_investor_id: 'I1' }]), 'f1', 'd', lp(['I1']))).toBe(true)
    expect(await lpDocumentVisible(adminWith({ id: 'd', scope: 'investor' }, [{ lp_investor_id: 'I2' }]), 'f1', 'd', lp(['I1']))).toBe(false)
  })
  it('shows everything to a caller who sees every entity', async () => {
    expect(await lpDocumentVisible(adminWith({ id: 'd', scope: 'investor' }, []), 'f1', 'd', lp(null))).toBe(true)
  })
})

describe('lpDocumentVisible — a document tagged to another entity', () => {
  const adminWith = (doc: any, shares: any[]) => {
    const from = (t: string) => {
      const chain: any = { select: () => chain, eq: () => chain, in: () => chain,
        maybeSingle: async () => ({ data: t === 'lp_documents' ? doc : null, error: null }),
        then: (res: any) => res({ data: t === 'lp_document_shares' ? shares : [], error: null }) }
      return chain
    }
    return { from } as any
  }
  it('stays hidden even when shared with a visible LP', async () => {
    const lp = { scope: { vehicleNames: ['Fund I'] } as any, entityIds: [], investorIds: ['I1'] }
    expect(await lpDocumentVisible(adminWith({ id: 'd', scope: 'investor', vehicle: 'Fund II' }, [{ lp_investor_id: 'I1' }]), 'f1', 'd', lp)).toBe(false)
    expect(await lpDocumentVisible(adminWith({ id: 'd', scope: 'investor', vehicle: 'Fund I' }, [{ lp_investor_id: 'I1' }]), 'f1', 'd', lp)).toBe(true)
  })
})
