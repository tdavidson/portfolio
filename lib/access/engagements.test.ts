import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * Step 2 of making Portfolio the firm's MCP: a level per entity, and engagements for outside firms.
 *
 * A fund administrator who keeps Fund I's books and only reads Fund II's holds write on the books
 * and a cap of read in Fund II. These pin the rule (the lower of the two, never higher), the doors
 * that enforce it, and the engagement helpers.
 */

import { effectiveAccess, entityAccess, type AccessContext } from './effective'
import { entityCap, entityCapsFromRow, vehicleScopeFromRow } from './scope'
import { DEFAULT_FEATURE_VISIBILITY, type FeatureVisibilityMap } from '@/lib/types/features'
import { getPreset } from './presets'
import { isProposer } from '@/lib/accounting/proposals'
import { assignProblem, engagementExpiry, engagementFields, ENGAGEMENT_PRESET } from './engagements'

const FUND_I = 'v-1'
const FUND_II = 'v-2'
const FUND_III = 'v-3'

const ctx = (grants: AccessContext['grants'], caps: Record<string, 'read' | 'propose'> = {}, over: Partial<AccessContext> = {}): AccessContext => ({
  fundId: 'f1',
  userId: 'u1',
  role: 'member',
  features: { ...DEFAULT_FEATURE_VISIBILITY, accounting: 'everyone', lps: 'everyone' } as FeatureVisibilityMap,
  grants,
  defaults: {},
  vehicles: { all: false, ids: [FUND_I, FUND_II, FUND_III], enforced: true, caps },
  ...over,
})

describe('a level per entity', () => {
  const admin = ctx({ accounting: 'write', lp_capital: 'write', portfolio: 'write' }, { [FUND_II]: 'read', [FUND_III]: 'propose' })

  it('is the lower of the area grant and the entity cap', () => {
    expect(entityAccess(admin, 'accounting', FUND_I)).toBe('write')
    expect(entityAccess(admin, 'accounting', FUND_II)).toBe('read')
    expect(entityAccess(admin, 'accounting', FUND_III)).toBe('propose')
  })

  it('never raises an area grant', () => {
    const reader = ctx({ accounting: 'read' }, { [FUND_III]: 'propose' })
    expect(entityAccess(reader, 'accounting', FUND_III)).toBe('read')
    expect(entityAccess(ctx({ accounting: 'none' }), 'accounting', FUND_I)).toBe('none')
  })

  it('reads a propose cap as read where the area has no proposals', () => {
    expect(entityAccess(admin, 'portfolio', FUND_III)).toBe('read')
    expect(entityAccess(admin, 'lp_capital', FUND_III)).toBe('read')
  })

  it('leaves the area level alone with no entity named', () => {
    expect(entityAccess(admin, 'accounting', null)).toBe(effectiveAccess(admin, 'accounting'))
  })

  it('does not apply to admins or "All entities" members', () => {
    expect(entityAccess(ctx({}, { [FUND_II]: 'read' }, { role: 'admin', vehicles: { all: true, ids: [], caps: { [FUND_II]: 'read' } } }), 'accounting', FUND_II)).toBe('write')
    expect(entityCap({ vehicles: { all: true, ids: [], caps: { [FUND_II]: 'read' } } }, FUND_II)).toBeNull()
  })

  it('makes a writer a proposer in a propose-capped entity only', () => {
    expect(isProposer(admin, FUND_III)).toBe(true)
    expect(isProposer(admin, FUND_I)).toBe(false)
    expect(isProposer(admin, FUND_II)).toBe(false)
    expect(isProposer(admin)).toBe(false)
  })

  it('reads vehicle_levels from access_context, keeping only levels that lower', () => {
    expect(entityCapsFromRow({ a: 'read', b: 'propose', c: 'write', d: 'nonsense' })).toEqual({ a: 'read', b: 'propose' })
    expect(entityCapsFromRow(null)).toEqual({})
    expect(vehicleScopeFromRow('member', [FUND_I], false, { [FUND_I]: 'read' }).caps).toEqual({ [FUND_I]: 'read' })
    expect(vehicleScopeFromRow('member', [FUND_I], true, { [FUND_I]: 'read' }).caps).toBeUndefined()
    // Before the migration: no key, no caps.
    expect(vehicleScopeFromRow('member', [FUND_I], false).caps).toBeUndefined()
  })
})

describe('the doors that enforce it', () => {
  const root = join(__dirname, '..', '..')
  const read = (p: string) => readFileSync(join(root, p), 'utf8')

  it('checks the cap on every web write that resolves an entity', () => {
    const src = read('lib/accounting/http-vehicle.ts')
    expect(src).toContain('const capped = await assertEntityLevel(admin, gate, group, opts)')
    expect(src).toContain('await assertEntityWrite(admin, access, name, need, opts)')
  })

  it('lets only the journal take a propose-capped write, and makes it a proposal there', () => {
    const route = read('app/api/accounting/journal/route.ts')
    expect(route.match(/\{ proposals: true \}/g)?.length).toBe(3)
    expect(route.match(/isProposer\(await loadGateAccess\(admin, gate\), vehicleId\)/g)?.length).toBe(3)
  })

  it('checks the cap on MCP and API tool calls, proposable tools only past a propose cap', () => {
    const src = read('lib/accounting/agent-tools.ts')
    expect(src).toContain('const opts = { proposals: tool.proposable === true }')
    expect(src).toContain('await assertEntityWrite(admin, access, name, tool.scope, opts)')
    expect(src).toContain('isProposer(access, vehicleId)')
  })

  it('returns the caps from access_context, and none for unscoped callers', () => {
    const sql = read('supabase/migrations/20261101100000_engagements_and_entity_levels.sql')
    expect(sql).toContain("'vehicle_levels', case")
    expect(sql).toContain("check (level in ('read', 'propose', 'write'))")
    expect(sql).toContain("add column if not exists level text not null default 'write'")
    // Engagements are read by the admin API with the service role only.
    expect(sql).toContain('revoke all on public.engagements from anon, authenticated;')
    expect(sql).toContain('grant select, insert, update, delete on public.engagements to service_role;')
  })
})

describe('engagements', () => {
  it('needs a name and a kind to create, and checks dates', () => {
    expect(engagementFields({}, true)).toHaveProperty('error')
    expect(engagementFields({ name: 'Example Fund Services', kind: 'nope' }, true)).toHaveProperty('error')
    expect(engagementFields({ name: 'Example Fund Services', kind: 'fund_admin', endsOn: '2026-13-40' }, true)).toHaveProperty('error')
    expect(engagementFields({ name: 'X', kind: 'audit', startsOn: '2027-02-01', endsOn: '2027-01-01' }, true)).toHaveProperty('error')
    expect(engagementFields({ name: ' Example Audit LLP ', kind: 'audit', endsOn: '2027-03-31' }, true))
      .toEqual({ fields: { name: 'Example Audit LLP', kind: 'audit', ends_on: '2027-03-31' } })
  })

  it('updates only what was sent, and clears a date with null', () => {
    expect(engagementFields({ endsOn: null }, false)).toEqual({ fields: { ends_on: null } })
    expect(engagementFields({ notes: '' }, false)).toEqual({ fields: { notes: null } })
  })

  it('ends access at the end of the last day', () => {
    expect(engagementExpiry('2027-03-31')).toBe('2027-03-31T23:59:59.999Z')
    expect(engagementExpiry(null)).toBeNull()
  })

  it('never takes an admin, the demo account, or anyone once it is over', () => {
    const open = { ended_at: null, ends_on: '2099-01-01' }
    const now = new Date('2027-01-01T00:00:00Z')
    expect(assignProblem({ engagement: open, target: { role: 'member' }, now })).toBeNull()
    expect(assignProblem({ engagement: open, target: { role: 'admin' }, now })?.status).toBe(400)
    expect(assignProblem({ engagement: open, target: { role: 'viewer' }, now })?.status).toBe(400)
    expect(assignProblem({ engagement: { ended_at: '2026-12-01T00:00:00Z', ends_on: null }, target: { role: 'member' }, now })?.status).toBe(400)
    expect(assignProblem({ engagement: { ended_at: null, ends_on: '2026-12-31' }, target: { role: 'member' }, now })?.status).toBe(400)
    expect(assignProblem({ engagement: null, target: { role: 'member' }, now })?.status).toBe(404)
  })

  it('suggests a preset per kind, including the compliance vendor', () => {
    for (const key of Object.values(ENGAGEMENT_PRESET)) if (key) expect(getPreset(key)).toBeDefined()
    const compliance = getPreset('compliance')!
    expect(compliance.grants.compliance).toBe('write')
    expect(compliance.grants.accounting).toBe('read')
    expect(compliance.grants.gp_economics).toBe('none')
  })
})
