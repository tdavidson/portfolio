import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { AccessContext, AccessLevel } from '@/lib/access/effective'
import type { Domain } from '@/lib/access/domains'
import { DEFAULT_FEATURE_VISIBILITY, type FeatureVisibilityMap } from '@/lib/types/features'
import { memoryAdmin } from './helpers/memory-admin'

/**
 * The LP register from chat and the API: investors, entities, profiles and commitments. Each tool
 * resolves names within the caller's LPs and runs the web route's own function.
 */

vi.mock('@/lib/access/entity-scope', () => ({
  entityScopeFor: async (_: unknown, a: AccessContext) => ({ access: a, vehicleNames: a.vehicles.all ? null : ['Fund I'], companyIds: null }),
}))
vi.mock('@/lib/access/lp-scope', () => ({
  visibleLpEntityIds: async (_: unknown, scope: { vehicleNames: string[] | null }) => (scope.vehicleNames === null ? null : ['ent-1']),
  scopeLiveReport: (r: unknown) => r,
}))

import { LP_RECORD_HANDLERS as H } from '@/lib/agent/lp-record-tools'
import { getTool } from '@/lib/accounting/agent-tools'
import { shouldStage } from '@/lib/agent/dispatch'
import { adminOnlyToolLabel } from '@/lib/access/admin-only'

const member = (grants: Partial<Record<Domain, AccessLevel>>, all = true): AccessContext => ({
  fundId: 'f1', userId: 'u1', vehicles: { all, ids: all ? [] : ['v1'] }, role: 'member',
  features: Object.fromEntries(Object.keys(DEFAULT_FEATURE_VISIBILITY).map(k => [k, 'everyone'])) as FeatureVisibilityMap,
  grants, defaults: {},
})

let store: ReturnType<typeof memoryAdmin>
const ctx = (access = member({ lp_capital: 'write' })) => ({ admin: store.admin, fundId: 'f1', portfolioGroup: '', userId: 'u1', access }) as any

beforeEach(() => {
  store = memoryAdmin({
    fund_vehicles: [
      { id: 'v1', fund_id: 'f1', name: 'Fund I', active: true, kind: 'fund', aliases: null },
      { id: 'v2', fund_id: 'f1', name: 'Fund II', active: true, kind: 'fund', aliases: null },
    ],
    lp_investors: [
      { id: 'inv-1', fund_id: 'f1', name: 'Acme' },
      { id: 'inv-2', fund_id: 'f1', name: 'Birch Family' },
      { id: 'inv-x', fund_id: 'other', name: 'Elsewhere' },
    ],
    lp_entities: [
      { id: 'ent-1', fund_id: 'f1', entity_name: 'Acme LP', investor_id: 'inv-1', lp_investors: { id: 'inv-1', name: 'Acme' } },
      { id: 'ent-2', fund_id: 'f1', entity_name: 'Birch Trust', investor_id: 'inv-2', lp_investors: { id: 'inv-2', name: 'Birch Family' } },
    ],
    commitment_events: [
      { id: 'ce-1', fund_id: 'f1', vehicle_id: 'v1', lp_entity_id: 'ent-1', effective_date: '2025-01-01', amount: 1000000, kind: 'initial', transfer_id: null, memo: null },
      { id: 'ce-2', fund_id: 'f1', vehicle_id: 'v1', lp_entity_id: 'ent-2', effective_date: '2025-01-01', amount: 500000, kind: 'initial', transfer_id: null, memo: null },
    ],
  })
})

describe('LP record tools', () => {
  it('are staged from a chat; investors, entities and new commitments need an admin to approve', () => {
    for (const name of ['lp_create_investor', 'lp_update_investor', 'lp_create_entity', 'lp_update_entity', 'lp_update_profile', 'lp_record_commitment', 'lp_correct_commitment']) {
      const tool = getTool(name)!
      expect(tool, name).toMatchObject({ scope: 'write', domain: 'lp' })
      expect(shouldStage(tool, {}, { keyId: 'oauth:x' }), name).toBe(true)
    }
    expect(adminOnlyToolLabel('lp_create_investor', {})).toBe('add an LP investor')
    expect(adminOnlyToolLabel('lp_record_commitment', {})).toBe('add a commitment')
    expect(adminOnlyToolLabel('lp_update_profile', {})).toBeUndefined()
    expect(adminOnlyToolLabel('lp_correct_commitment', {})).toBeUndefined()
  })

  it('adds an investor and an entity under it, refusing a duplicate investor name', async () => {
    const inv = await H.lp_create_investor(ctx(), { name: '  Cedar Partners ' }) as any
    expect(inv.investor.name).toBe('Cedar Partners')
    const ent = await H.lp_create_entity(ctx(), { investor: 'cedar', entity_name: 'Cedar Fund LP' }) as any
    expect(ent).toMatchObject({ investor: 'Cedar Partners', entity: { name: 'Cedar Fund LP' } })
    await expect(H.lp_create_entity(ctx(), { investor: 'Elsewhere', entity_name: 'X' })).rejects.toThrow('No investor matching')
  })

  it('sets a parent only from this fund, and never the investor itself', async () => {
    await H.lp_update_investor(ctx(), { investor: 'Acme', parent: 'Birch Family' })
    expect(store.tables.lp_investors.find((i: any) => i.id === 'inv-1')!.parent_id).toBe('inv-2')
    await expect(H.lp_update_investor(ctx(), { investor: 'Acme', parent: 'Acme' })).rejects.toThrow('own parent')
    await H.lp_update_investor(ctx(), { investor: 'Acme', parent: '' })
    expect(store.tables.lp_investors.find((i: any) => i.id === 'inv-1')!.parent_id).toBeNull()
  })

  it('sets and clears an alternate name, and finds the investor by it', async () => {
    const out = await H.lp_update_investor(ctx(), { investor: 'Acme', alternate_name: '  Jane Doe ' }) as any
    expect(out.investor.alternate_name).toBe('Jane Doe')
    // Another tool can now name the investor by the person behind it.
    const ent = await H.lp_create_entity(ctx(), { investor: 'jane doe', entity_name: 'Doe Family Trust' }) as any
    expect(ent.investor).toBe('Acme')
    await H.lp_update_investor(ctx(), { investor: 'Acme', alternate_name: '' })
    expect(store.tables.lp_investors.find((i: any) => i.id === 'inv-1')!.alternate_name).toBeNull()
    const created = await H.lp_create_investor(ctx(), { name: 'Cedar Holdings LLC', alternate_name: 'John Roe' }) as any
    expect(created.investor).toMatchObject({ name: 'Cedar Holdings LLC', alternate_name: 'John Roe' })
  })

  it('renames an entity and its investor with it', async () => {
    await H.lp_update_entity(ctx(), { lp: 'Acme LP', name: 'Acme Holdings LP' })
    expect(store.tables.lp_entities.find((e: any) => e.id === 'ent-1')!.entity_name).toBe('Acme Holdings LP')
    expect(store.tables.lp_investors.find((i: any) => i.id === 'inv-1')!.name).toBe('Acme Holdings LP')
  })

  it("updates a profile and contact, only for the caller's LPs", async () => {
    const out = await H.lp_update_profile(ctx(), { lp: 'Acme LP', entity: { city: 'Boston' }, contact: { contact_email: 'ops@acme.test' } }) as any
    expect(out.entity.city).toBe('Boston')
    expect(out.investor.contact_email).toBe('ops@acme.test')
    await expect(H.lp_update_profile(ctx(member({ lp_capital: 'write' }, false)), { lp: 'Birch Trust', entity: { city: 'X' } })).rejects.toThrow('No LP matching')
  })

  it('lists commitments with ids, records a change with an audit row, and corrects one only with a reason', async () => {
    const before = await H.lp_commitments(ctx(), { vehicle: 'Fund I' }) as any
    expect(before.commitments.find((c: any) => c.lp === 'Acme LP').commitment).toBe(1000000)
    await H.lp_record_commitment(ctx(), { vehicle: 'Fund I', lp: 'Acme LP', effective_date: '2026-03-01', amount: 250000, memo: 'Upsized' })
    const after = await H.lp_commitments(ctx(), { vehicle: 'Fund I', lp: 'Acme LP' }) as any
    expect(after.commitments).toEqual([{ lp: 'Acme LP', lp_entity_id: 'ent-1', commitment: 1250000 }])
    expect(store.tables.accounting_audit_events.at(-1)).toMatchObject({ action: 'commitment.create', subject_id: 'ent-1' })

    await expect(H.lp_correct_commitment(ctx(), { vehicle: 'Fund I', event_id: 'ce-1', amount: 900000 })).rejects.toThrow('reason is required')
    await H.lp_correct_commitment(ctx(), { vehicle: 'Fund I', event_id: 'ce-1', amount: 900000, reason: 'Side letter' })
    expect(store.tables.commitment_events.find((e: any) => e.id === 'ce-1')).toMatchObject({ amount: 900000, kind: 'initial' })
  })

  it("will not touch a commitment on someone else's LP", async () => {
    const scoped = ctx(member({ lp_capital: 'write' }, false))
    const list = await H.lp_commitments(scoped, { vehicle: 'Fund I' }) as any
    expect(list.events.map((e: any) => e.lp)).toEqual(['Acme LP'])
    await expect(H.lp_correct_commitment(scoped, { vehicle: 'Fund I', event_id: 'ce-2', memo: 'x', reason: 'y' })).rejects.toThrow('Not found')
  })
})
