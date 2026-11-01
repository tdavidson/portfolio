import { describe, it, expect } from 'vitest'

/**
 * PORTFOLIO RUNS THE FUND ACCESS VECTORS (spec/fund-access/08-conformance.md).
 *
 * Each vector is translated into Portfolio's own terms (an AccessContext and a credential) and
 * decided by Portfolio's own functions, the ones its doors call: hasAccess and entityAccess for the
 * web gate, authorizeToolCall for MCP and the API, adminOnlyRefusal and shouldStage for what a write
 * from a chat or a key does, canSeeVehicle for entity scope, and recordEntity for where a record
 * goes. Nothing here re-decides a rule: the adapter only chooses which of Portfolio's checks a call
 * passes through, in the order its doors run them.
 *
 * Conformance is on outcome. The spec's reasons are advisory, and Portfolio words its refusals
 * for people.
 */

import { loadVectors, type Vector } from '@/spec/fund-access/engine/vectors'
import type { Outcome } from '@/spec/fund-access/engine/decide'
import { entityAccess, hasAccess, type AccessContext, type AccessLevel } from '@/lib/access/effective'
import { canSeeVehicle } from '@/lib/access/scope'
import { DOMAIN_META, type Domain } from '@/lib/access/domains'
import { DEFAULT_FEATURE_VISIBILITY, type FeatureVisibilityMap } from '@/lib/types/features'
import { authorizeToolCall, getTool, type AgentTool } from '@/lib/accounting/agent-tools'
import type { ResolvedKey } from '@/lib/accounting/api-keys'
import { adminOnlyRefusal, shouldStage } from '@/lib/agent/dispatch'
import { recordEntity, RECORD_AREAS } from '@/lib/records'
import { AREAS, RECORD_AREAS as SPEC_RECORD_AREAS, STANDARD_AREAS } from '@/spec/fund-access/engine/areas'

const SWITCH = { everyone: 'everyone', admins: 'admin', off: 'off' } as const

function toAccess(v: Vector): AccessContext {
  const features = { ...DEFAULT_FEATURE_VISIBILITY, ...Object.fromEntries(Object.keys(DEFAULT_FEATURE_VISIBILITY).map(k => [k, 'everyone'])) } as FeatureVisibilityMap
  for (const [area, sw] of Object.entries(v.fund.switches ?? {})) {
    const key = DOMAIN_META[area as Domain].primaryFeature
    if (!key) throw new Error(`${v.id}: Portfolio has no single switch for ${area}`)
    features[key] = SWITCH[sw as keyof typeof SWITCH]
  }
  const role = v.party.role === 'observer' ? 'viewer' : v.party.role
  const list = Array.isArray(v.party.entities) ? v.party.entities : null
  const caps = Object.fromEntries((list ?? []).filter(e => e.cap).map(e => [e.id, e.cap!]))
  return {
    fundId: 'f1', userId: 'u1', role, features,
    grants: (v.party.grants ?? {}) as Partial<Record<Domain, AccessLevel>>,
    defaults: (v.fund.defaults ?? {}) as Partial<Record<Domain, AccessLevel>>,
    vehicles: role === 'admin' || !list
      ? { all: true, ids: [] }
      : { all: false, ids: list.map(e => e.id), ...(Object.keys(caps).length ? { caps } : {}) },
  }
}

function credential(v: Vector, access: AccessContext): ResolvedKey {
  const keyId = v.call.credential === 'assistant' ? 'oauth:conformance' : 'key_conformance'
  return { fundId: access.fundId, keyId, userId: access.userId, role: access.role, scopes: v.call.scopes ?? ['read', 'write'] }
}

/** A tool shaped like the call, for the checks that take one. An admin-only call borrows a real admin-only tool's name. */
function toolFor(v: Vector): AgentTool {
  return {
    name: v.call.adminOnly ? 'remove_member' : 'fund_access_probe',
    description: '', scope: v.call.action === 'read' ? 'read' : 'write', domain: 'portfolio',
    accessDomain: v.call.area as Domain,
    ...(v.call.proposable ? { proposable: true as const } : {}),
    ...(v.call.direct ? { runsDirectly: true as const } : {}),
    inputSchema: {}, handler: async () => null,
  } as AgentTool
}

function portfolioDecides(v: Vector): Outcome {
  const access = toAccess(v)
  const entity = v.call.entity ?? null
  const person = v.call.credential === 'person'
  const auth = credential(v, access)

  if (v.call.action === 'file_record') {
    // The web route and the tools both call fileRecord: recordAccessProblem (through
    // authorizeToolCall on a tool door), then recordEntity. A person on the web holds write.
    const tool = getTool('file_to_record')!
    if (authorizeToolCall(tool, person ? { ...auth, scopes: ['read', 'write'] } : auth, access, { area: v.call.area })) return 'refuse'
    const names = new Map(['fund-i', 'fund-ii', 'fund-iii'].map(id => [id, id]))
    return recordEntity(access, names, entity ?? '').ok ? 'allow' : 'refuse'
  }

  if (entity && !canSeeVehicle(access, entity)) return 'refuse'
  const area = v.call.area as Domain

  if (v.call.action === 'read') {
    if (!person && authorizeToolCall(toolFor(v), auth, access, {})) return 'refuse'
    return hasAccess(access, area, 'read') && entityAccess(access, area, entity) !== 'none' ? 'allow' : 'refuse'
  }

  // A write. The web gate (person) or authorizeToolCall (a credential), then the entity level as
  // resolveGroupOr400 / resolveVehicleForTool apply it.
  const tool = toolFor(v)
  if (!person && authorizeToolCall(tool, auth, access, {})) return 'refuse'
  if (access.role === 'viewer') return 'refuse'
  const level = entityAccess(access, area, entity)
  if (level === 'propose') return v.call.proposable ? 'propose' : 'refuse'
  if (level !== 'write') return 'refuse'
  if (v.call.adminOnly && access.role !== 'admin') {
    if (person || adminOnlyRefusal(tool, {}, auth)) return 'refuse'
    return 'stage_for_admin'
  }
  if (person) return 'allow'
  return shouldStage(tool, {}, auth, access) ? 'stage' : 'allow'
}

describe('Portfolio uses the standard areas', () => {
  it('has every standard area, related the same way', () => {
    expect(Object.keys(DOMAIN_META).sort()).toEqual([...AREAS].sort())
    for (const a of AREAS) {
      const m = DOMAIN_META[a as Domain] as { proposable?: boolean; requires?: string; impliedBy?: string; defaultFrom?: string; adminOnly?: boolean }
      const d = STANDARD_AREAS[a]
      expect({ p: !!m.proposable, r: m.requires, i: m.impliedBy, f: m.defaultFrom, o: !!m.adminOnly }, a)
        .toEqual({ p: !!d.proposable, r: d.requires, i: d.impliedBy, f: d.defaultFrom, o: !!d.adminOnly })
    }
    expect([...RECORD_AREAS]).toEqual([...SPEC_RECORD_AREAS])
  })
})

describe('Portfolio passes the Fund Access vectors', () => {
  for (const v of loadVectors()) {
    it(`${v.id}: ${v.title}`, () => {
      expect(portfolioDecides(v)).toBe(v.expect.outcome)
    })
  }
})
