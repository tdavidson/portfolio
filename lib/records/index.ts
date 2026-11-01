// Fund records: what a person or their assistant files from a working session, kept by the fund
// (20261101140000_fund_records.sql). The web route (/api/records) and the file_to_record,
// list_records and read_record tools all come through here, so a record filed from Claude is
// checked, stored and shown exactly as one typed in the app.
//
// Rules (lib/records/areas.ts): filing and reading need read on the record's area, and the entity
// in the caller's scope. Records are append-only.

import type { SupabaseClient } from '@supabase/supabase-js'
import type { AccessContext } from '@/lib/access/effective'
import { canSeeVehicle, visibleVehicleIds } from '@/lib/access/scope'
import { currentChangeSource } from '@/lib/audit/source'
import { logActivity } from '@/lib/activity'
import { done, fail, dbFail, type Outcome } from '@/lib/service-outcome'
import {
  RECORD_KINDS, RECORD_SUBJECTS, isRecordArea, readableAreas, recordAccessProblem,
  type RecordArea, type RecordKind, type RecordSubject,
} from './areas'

export * from './areas'

export interface RecordActor {
  access: AccessContext
  userId: string | null
  email?: string | null
}

export interface FundRecord {
  id: string
  area: RecordArea
  kind: RecordKind
  title: string
  body?: string
  entityId: string | null
  entityName: string | null
  subjectType: RecordSubject | null
  subjectId: string | null
  source: 'web' | 'api' | 'mcp'
  filedByEmail: string | null
  engagementId: string | null
  createdAt: string
}

const TITLE_MAX = 200
const BODY_MAX = 100_000
const SELECT = 'id, area, kind, title, body, vehicle_id, subject_type, subject_id, source, filed_by_email, engagement_id, created_at'
const SUBJECT_TABLE: Record<RecordSubject, string> = {
  company: 'companies', lp_investor: 'lp_investors', journal_entry: 'journal_entries', deal: 'diligence_deals',
}
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

const str = (v: unknown) => (typeof v === 'string' ? v.trim() : '')

/** The fund's entities, id → name. */
async function entityNames(admin: SupabaseClient, fundId: string): Promise<Map<string, string>> {
  const { data } = await (admin as any).from('fund_vehicles').select('id, name').eq('fund_id', fundId)
  return new Map(((data ?? []) as { id: string; name: string }[]).map(v => [v.id, v.name]))
}

/** An entity named by id or name (case-insensitive), within this fund. */
export function matchEntity(names: Map<string, string>, raw: string): string | null | 'ambiguous' {
  if (names.has(raw)) return raw
  const hits = [...names].filter(([, n]) => n.toLowerCase() === raw.toLowerCase()).map(([id]) => id)
  if (hits.length > 1) return 'ambiguous'
  return hits[0] ?? null
}

/** Validate a filing's shape. Pure, so it is pinned by tests without a database. */
export function parseFiling(input: any): { error: string } | {
  area: RecordArea; kind: RecordKind; title: string; body: string; entity: string; subjectType: RecordSubject | null; subjectId: string | null
} {
  if (!isRecordArea(input?.area)) return { error: 'Name the area to file in.' }
  const kind = input?.kind == null || input.kind === '' ? 'summary' : input.kind
  if (!(RECORD_KINDS as readonly string[]).includes(kind)) return { error: `kind must be one of ${RECORD_KINDS.join(', ')}.` }
  const title = str(input?.title)
  if (!title) return { error: 'A record needs a title.' }
  if (title.length > TITLE_MAX) return { error: `Keep the title under ${TITLE_MAX} characters.` }
  const body = str(input?.body)
  if (!body) return { error: 'A record needs a body: what was concluded, decided or said.' }
  if (body.length > BODY_MAX) return { error: `A record holds up to ${BODY_MAX.toLocaleString('en-US')} characters. Split it, or file a summary.` }
  const subjectType = input?.subject_type == null || input.subject_type === '' ? null : input.subject_type
  const subjectId = str(input?.subject_id) || null
  if (subjectType !== null && !(RECORD_SUBJECTS as readonly string[]).includes(subjectType)) {
    return { error: `subject_type must be one of ${RECORD_SUBJECTS.join(', ')}.` }
  }
  if ((subjectType === null) !== (subjectId === null)) return { error: 'Give subject_type and subject_id together, or neither.' }
  if (subjectId !== null && !UUID.test(subjectId)) return { error: 'subject_id must be the id of the company, LP investor, journal entry or deal.' }
  return { area: input.area, kind, title, body, entity: str(input?.entity), subjectType, subjectId }
}

/** File a record. Needs read on its area and the entity in scope; changes nothing else. */
export async function fileRecord(admin: SupabaseClient, actor: RecordActor, input: unknown): Promise<Outcome<FundRecord>> {
  const { access } = actor
  const denied = recordAccessProblem(access, { area: (input as any)?.area, filing: true })
  if (denied) return fail(403, denied)
  const f = parseFiling(input)
  if ('error' in f) return fail(400, f.error)

  const names = await entityNames(admin, access.fundId)
  let vehicleId: string | null = null
  if (f.entity) {
    const hit = matchEntity(names, f.entity)
    if (hit === 'ambiguous') return fail(400, `More than one entity is called "${f.entity}". Use its id.`)
    if (!hit || !canSeeVehicle(access, hit)) return fail(404, `No entity "${f.entity}" in your scope.`)
    vehicleId = hit
  } else if (!access.vehicles.all) {
    const mine = access.vehicles.ids.filter(id => names.has(id))
    if (mine.length !== 1) return fail(400, 'Name the entity the record is about. You work in more than one, and a fund-wide record needs access to every entity.')
    vehicleId = mine[0]
  }

  if (f.subjectType && f.subjectId) {
    const { data, error } = await (admin as any).from(SUBJECT_TABLE[f.subjectType]).select('id').eq('fund_id', access.fundId).eq('id', f.subjectId).maybeSingle()
    if (error) return dbFail(error, 'records.subject')
    if (!data) return fail(404, `No ${f.subjectType.replace('_', ' ')} with that id in this fund.`)
  }

  let engagementId: string | null = null
  if (actor.userId) {
    const { data: m } = await (admin as any).from('fund_members').select('engagement_id').eq('fund_id', access.fundId).eq('user_id', actor.userId).maybeSingle()
    engagementId = m?.engagement_id ?? null
  }

  const { data, error } = await (admin as any).from('fund_records').insert({
    fund_id: access.fundId,
    vehicle_id: vehicleId,
    area: f.area,
    kind: f.kind,
    title: f.title,
    body: f.body,
    subject_type: f.subjectType,
    subject_id: f.subjectId,
    source: currentChangeSource(),
    filed_by: actor.userId,
    filed_by_email: actor.email ?? null,
    engagement_id: engagementId,
  }).select(SELECT).single()
  if (error || !data) return dbFail(error, 'records.file')

  if (actor.userId) void logActivity(admin as any, access.fundId, actor.userId, 'record.file', { recordId: data.id, area: f.area, kind: f.kind })
  return done(toRecord(data, names, true))
}

/** Records this person may read, newest first, without bodies. */
export async function listRecords(
  admin: SupabaseClient,
  actor: RecordActor,
  opts: { area?: unknown; entity?: unknown; subjectType?: unknown; subjectId?: unknown; query?: unknown; limit?: unknown } = {},
): Promise<Outcome<FundRecord[]>> {
  const { access } = actor
  const denied = recordAccessProblem(access, { area: opts.area, filing: false })
  if (denied) return fail(403, denied)
  const areas = isRecordArea(opts.area) ? [opts.area] : readableAreas(access)
  const limit = Math.min(Math.max(Number(opts.limit) || 50, 1), 200)
  const names = await entityNames(admin, access.fundId)

  let q = (admin as any).from('fund_records').select(SELECT).eq('fund_id', access.fundId).in('area', areas)
  const entity = str(opts.entity)
  if (entity) {
    const hit = matchEntity(names, entity)
    if (hit === 'ambiguous') return fail(400, `More than one entity is called "${entity}". Use its id.`)
    if (!hit || !canSeeVehicle(access, hit)) return fail(404, `No entity "${entity}" in your scope.`)
    q = q.eq('vehicle_id', hit)
  } else {
    const ids = visibleVehicleIds(access)
    if (ids) {
      if (ids.length === 0) return done([])
      q = q.in('vehicle_id', ids)
    }
  }
  if (typeof opts.subjectType === 'string' && opts.subjectType) q = q.eq('subject_type', opts.subjectType)
  if (typeof opts.subjectId === 'string' && UUID.test(opts.subjectId)) q = q.eq('subject_id', opts.subjectId)
  const text = str(opts.query).replace(/[%_,()]/g, ' ').trim()
  if (text) q = q.or(`title.ilike.%${text}%,body.ilike.%${text}%`)

  const { data, error } = await q.order('created_at', { ascending: false }).limit(limit)
  if (error) return dbFail(error, 'records.list')
  return done(((data ?? []) as any[]).filter(r => visible(access, r)).map(r => toRecord(r, names, false)))
}

/** One record, with its body, if this person may read it. */
export async function readRecord(admin: SupabaseClient, actor: RecordActor, id: unknown): Promise<Outcome<FundRecord>> {
  const { access } = actor
  const denied = recordAccessProblem(access, { filing: false })
  if (denied) return fail(403, denied)
  if (typeof id !== 'string' || !UUID.test(id)) return fail(400, 'Give the record\'s id.')
  const { data, error } = await (admin as any).from('fund_records').select(SELECT).eq('fund_id', access.fundId).eq('id', id).maybeSingle()
  if (error) return dbFail(error, 'records.read')
  // Not found and not yours read the same, so an id says nothing about records you can't see.
  if (!data || !visible(access, data)) return fail(404, 'No record with that id that you can see.')
  return done(toRecord(data, await entityNames(admin, access.fundId), true))
}

/** Read on the record's area, and its entity in scope (a fund-wide record needs every entity). */
export function visible(access: AccessContext, row: { area: string; vehicle_id: string | null }): boolean {
  return recordAccessProblem(access, { area: row.area, filing: false }) === null && canSeeVehicle(access, row.vehicle_id)
}

function toRecord(r: any, names: Map<string, string>, withBody: boolean): FundRecord {
  return {
    id: r.id,
    area: r.area,
    kind: r.kind,
    title: r.title,
    ...(withBody ? { body: r.body } : {}),
    entityId: r.vehicle_id ?? null,
    entityName: r.vehicle_id ? names.get(r.vehicle_id) ?? null : null,
    subjectType: r.subject_type ?? null,
    subjectId: r.subject_id ?? null,
    source: r.source,
    filedByEmail: r.filed_by_email ?? null,
    engagementId: r.engagement_id ?? null,
    createdAt: r.created_at,
  }
}
