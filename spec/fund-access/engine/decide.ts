// The reference decision function for Fund Access (spec/fund-access/03-decisions.md). It exists to
// show the vectors agree with each other and with the prose, not to be the only way to run them.
// No dependencies, no I/O.

import { LEVEL_RANK, STANDARD_AREAS, type Area, type AreaDef, type Level } from './areas'

export type Switch = 'everyone' | 'admins' | 'off'
export type Role = 'admin' | 'member' | 'observer'
export type Credential = 'person' | 'assistant' | 'script'
export type Outcome = 'allow' | 'propose' | 'stage' | 'stage_for_admin' | 'refuse'
export type Reason =
  | 'credential_read_only' | 'entity_not_visible' | 'no_access' | 'observer'
  | 'fund_wide_record' | 'not_proposable' | 'admin_only'

export interface Fund {
  /** The fund's switch for an area. Absent is `everyone`. */
  switches?: Partial<Record<Area, Switch>>
  /** The level a member has in an area when they hold no grant of their own. */
  defaults?: Partial<Record<Area, Level>>
}

export interface EntityGrant { id: string; cap?: 'read' | 'propose' }

export interface Party {
  role: Role
  grants?: Partial<Record<Area, Level>>
  /** `all` (every entity, including ones created later) or the entities granted. Admins always see all. */
  entities?: 'all' | EntityGrant[]
}

export interface Call {
  action: 'read' | 'write' | 'file_record'
  area: Area
  /** The entity the call acts on. Absent or null: not about one entity (fund-level). */
  entity?: string | null
  credential: Credential
  /** What the credential was granted. Absent is both. A person signed in always has both. */
  scopes?: ('read' | 'write')[]
  /** A write that becomes a proposal for someone at `propose`. */
  proposable?: boolean
  /** A write only an admin may make. */
  adminOnly?: boolean
  /** A write that changes nothing anyone relies on (an upload URL, a preview), so it never stages. */
  direct?: boolean
}

export interface Decision { outcome: Outcome; reason?: Reason; level: Level }

const def = (area: Area): AreaDef => STANDARD_AREAS[area]
const atLeast = (l: Level, need: Level) => LEVEL_RANK[l] >= LEVEL_RANK[need]
const lower = (a: Level, b: Level): Level => (LEVEL_RANK[a] <= LEVEL_RANK[b] ? a : b)
const higher = (a: Level, b: Level): Level => (LEVEL_RANK[a] >= LEVEL_RANK[b] ? a : b)

/** What this party may do in this area across the fund, before any entity. 03-decisions.md §1. */
export function areaLevel(fund: Fund, party: Party, area: Area): Level {
  const d = def(area)
  const sw = fund.switches?.[area] ?? 'everyone'
  if (sw === 'off') return 'none'
  if (d.adminOnly) return party.role === 'admin' ? 'write' : 'none'
  if (party.role === 'admin') return 'write'
  if (party.role === 'observer') return 'read'
  if (d.requires && !atLeast(areaLevel(fund, party, d.requires), 'read')) return 'none'
  const fallback = d.defaultFrom ? (party.grants?.[d.defaultFrom] ?? fund.defaults?.[d.defaultFrom]) : undefined
  const stored: Level = sw === 'admins' ? 'none' : (party.grants?.[area] ?? fund.defaults?.[area] ?? fallback ?? 'none')
  const own: Level = stored === 'propose' && !d.proposable ? 'read' : stored
  if (!d.impliedBy) return own
  const raw = areaLevel(fund, party, d.impliedBy)
  return higher(own, raw === 'propose' && !d.proposable ? 'read' : raw)
}

export function seesEveryEntity(party: Party): boolean {
  return party.role === 'admin' || party.entities === 'all'
}

export function seesEntity(party: Party, entity: string): boolean {
  if (seesEveryEntity(party)) return true
  return Array.isArray(party.entities) && party.entities.some(e => e.id === entity)
}

/** The area level, lowered to the entity's cap. A cap never raises it. 03-decisions.md §2. */
export function entityLevel(fund: Fund, party: Party, area: Area, entity: string | null | undefined): Level {
  const own = areaLevel(fund, party, area)
  if (!entity || seesEveryEntity(party) || !Array.isArray(party.entities)) return own
  const cap = party.entities.find(e => e.id === entity)?.cap
  if (!cap) return own
  const capped = lower(own, cap)
  return capped === 'propose' && !def(area).proposable ? 'read' : capped
}

/** The decision for one call. 03-decisions.md §3, in order. */
export function decide(fund: Fund, party: Party, call: Call): Decision {
  const scopes = call.credential === 'person' ? ['read', 'write'] : (call.scopes ?? ['read', 'write'])
  const changes = call.action !== 'read'
  const level = entityLevel(fund, party, call.area, call.entity)
  const refuse = (reason: Reason): Decision => ({ outcome: 'refuse', reason, level })

  if (changes && !scopes.includes('write')) return refuse('credential_read_only')
  if (call.entity && !seesEntity(party, call.entity)) return refuse('entity_not_visible')

  if (call.action === 'read') return atLeast(level, 'read') ? { outcome: 'allow', level } : refuse('no_access')

  if (call.action === 'file_record') {
    if (party.role === 'observer') return refuse('observer')
    if (!call.entity && !seesEveryEntity(party)) return refuse('fund_wide_record')
    return atLeast(level, 'read') ? { outcome: 'allow', level } : refuse('no_access')
  }

  if (party.role === 'observer') return refuse('observer')
  if (level === 'propose') return call.proposable ? { outcome: 'propose', level } : refuse('not_proposable')
  if (!atLeast(level, 'write')) return refuse('no_access')
  if (call.adminOnly && party.role !== 'admin') {
    return call.credential === 'assistant' ? { outcome: 'stage_for_admin', level } : refuse('admin_only')
  }
  if (call.credential === 'assistant' && !call.direct) return { outcome: 'stage', level }
  return { outcome: 'allow', level }
}
