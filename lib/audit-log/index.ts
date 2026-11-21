// Audit: an automatic log of what outside firms do in the fund.
//
// An outside firm (fund administrator, auditor, tax preparer, compliance vendor) is an engagement
// (lib/access/engagements.ts); its people are members with `fund_members.engagement_id` set, and
// `engagements.member_history` keeps everyone ever assigned, so the fund keeps their log after the
// engagement ends and they are removed.
//
// Nothing here is filed by hand. The log is read from what the app already writes:
//
//   - accounting_audit_events: every change to the books, LP capital and the close from any door,
//     and an `agent.write` row for every write made over MCP or the API (lib/agent/dispatch.ts);
//   - user_activity_logs: the app's activity log, including the daily `connect` entry for an MCP or
//     API session, and the `web.change` row below;
//   - fund_records: notes a person or their assistant chose to file (file_to_record), which still
//     show, inside their firm's log.
//
// The one thing written for Audit alone is `web.change`: a change an outside person makes in the
// web app that no other log catches (most web routes outside the books keep no trail). The proxy
// writes it (proxy.ts → logWebChange), only while Audit is on, only for a member on an engagement,
// and only for requests that change something, so the extra writes are a handful per working day.
//
// Who sees it: the `audit` fund switch (everyone / admin / off) and the `records` grant, through
// effectiveAccess like every other area. Someone on an engagement sees only their own firm.

import type { SupabaseClient } from '@supabase/supabase-js'
import type { AccessContext } from '@/lib/access/effective'
import { hasAccess } from '@/lib/access/effective'
import { DEFAULT_FEATURE_VISIBILITY, type FeatureVisibility, type FeatureVisibilityMap } from '@/lib/types/features'
import { ENGAGEMENT_KIND_LABELS, type EngagementKind } from '@/lib/access/engagements'
import { recordAccessProblem } from '@/lib/records/areas'
import { canSeeVehicle } from '@/lib/access/scope'
import { done, fail, dbFail, type Outcome } from '@/lib/service-outcome'

export type AuditVisibility = 'members' | 'admins' | 'off'

/** The fund switch, in the words the settings use. Legacy `hidden` reads as off. */
export function auditVisibility(features: Partial<FeatureVisibilityMap> | null | undefined): AuditVisibility {
  const level: FeatureVisibility = features?.audit ?? DEFAULT_FEATURE_VISIBILITY.audit
  return level === 'everyone' ? 'members' : level === 'admin' ? 'admins' : 'off'
}

export function auditOn(features: Partial<FeatureVisibilityMap> | null | undefined): boolean {
  return auditVisibility(features) !== 'off'
}

export const VISIBILITY_TO_FEATURE: Record<AuditVisibility, FeatureVisibility> = {
  members: 'everyone', admins: 'admin', off: 'off',
}

// ---------------------------------------------------------------------------
// Writing: the web change no other log catches
// ---------------------------------------------------------------------------

export const WEB_CHANGE = 'web.change'
const CHANGE_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE'])

/** Does this request change something? Reads are not logged, on any door. */
export function isChangeRequest(method: string): boolean {
  return CHANGE_METHODS.has(method.toUpperCase())
}

type Db = { from: (table: string) => any }

/**
 * Log a web change by a member on an engagement, while Audit is on. Called by the proxy after the
 * request has cleared its gate. Never throws: a lost log line is no reason to refuse the change.
 * Admins are never on an engagement, so the proxy skips them before calling.
 */
export async function logWebChange(
  db: Db,
  args: { fundId: string; userId: string; method: string; route: string; path: string },
): Promise<void> {
  try {
    const { data: member } = await db.from('fund_members')
      .select('engagement_id').eq('fund_id', args.fundId).eq('user_id', args.userId).maybeSingle()
    if (!member?.engagement_id) return
    await db.from('user_activity_logs').insert({
      fund_id: args.fundId,
      user_id: args.userId,
      action: WEB_CHANGE,
      metadata: { method: args.method.toUpperCase(), route: args.route, path: args.path.slice(0, 300), engagementId: member.engagement_id, changeSource: 'web' },
    })
  } catch (err) {
    console.error('[audit] Failed to log a web change:', err)
  }
}

/**
 * Should the activity log keep this entry even though the fund switched user tracking off? Yes for
 * a member on an engagement while Audit is on: Audit is the fund's record of outside firms, and an
 * admin who turned it on has asked for exactly that. One extra lookup, only on funds with tracking
 * off and Audit on.
 */
export async function auditKeepsActivity(db: Db, fundId: string, userId: string, features: unknown): Promise<boolean> {
  if (!auditOn(features as Partial<FeatureVisibilityMap> | null)) return false
  const { data } = await db.from('fund_members').select('engagement_id').eq('fund_id', fundId).eq('user_id', userId).maybeSingle()
  return !!data?.engagement_id
}

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

export type AuditDoor = 'web' | 'mcp' | 'api'

export interface AuditEntry {
  at: string
  personId: string | null
  person: string | null
  door: AuditDoor | null
  /** change: something was changed; session: an MCP or API connection that day; note: filed by hand. */
  type: 'change' | 'session' | 'note'
  action: string
  /** One line a person can read. */
  summary: string
  /** What it touched, where the log knows. */
  subject: string | null
  /** For a note: read it with read_record or ?id= on /api/records. */
  recordId?: string
}

export interface AuditFirm {
  /** Null for notes the fund's own team filed. */
  id: string | null
  name: string
  kind: EngagementKind | null
  kindLabel: string | null
  startsOn: string | null
  endsOn: string | null
  endedAt: string | null
  people: { id: string; email: string | null; current: boolean }[]
  entries: AuditEntry[]
  /** True when there were more entries in the window than `limit`. */
  truncated: boolean
}

export interface AuditLog {
  visibility: AuditVisibility
  since: string
  firms: AuditFirm[]
}

const VERB: Record<string, string> = { POST: 'Created or ran', PUT: 'Changed', PATCH: 'Changed', DELETE: 'Deleted' }
const DATE = /^\d{4}-\d{2}-\d{2}$/
const DEDUPE_MS = 15_000

/** "api/companies/[id]/notes" → "companies › notes". */
export function routeLabel(route: string): string {
  return route.replace(/^api\//, '').split('/').filter(p => p && !p.startsWith('[')).join(' › ') || route
}

function door(v: unknown): AuditDoor | null {
  return v === 'web' || v === 'mcp' || v === 'api' ? v : null
}

const humanize = (action: string) => action.replace(/[._]/g, ' ')

/** One audit-trail row as a line. Pure. */
export function auditTrailEntry(r: any, email: (id: string | null) => string | null): AuditEntry {
  const tool = (r.tool as string | null) ?? null
  const isTool = r.action === 'agent.write' && tool
  return {
    at: r.created_at,
    personId: r.actor_id ?? null,
    person: email(r.actor_id ?? null),
    door: door(r.source),
    type: 'change',
    action: r.action,
    summary: isTool ? `Ran ${tool}` : humanize(r.action),
    subject: isTool ? null : (r.subject_id ? `${r.subject_type} ${r.subject_id}` : (r.subject_type ?? null)),
  }
}

/** One activity-log row as a line. Pure. */
export function activityEntry(r: any, email: (id: string | null) => string | null): AuditEntry {
  const m = r.metadata ?? {}
  const d = door(m.changeSource)
  if (r.action === 'connect') {
    return {
      at: r.created_at, personId: r.user_id ?? null, person: email(r.user_id ?? null), door: d, type: 'session', action: r.action,
      summary: d === 'mcp' ? 'Connected an assistant (MCP)' : d === 'api' ? 'Used an API key' : 'Connected', subject: null,
    }
  }
  if (r.action === WEB_CHANGE) {
    return {
      at: r.created_at, personId: r.user_id ?? null, person: email(r.user_id ?? null), door: 'web', type: 'change', action: r.action,
      summary: `${VERB[m.method] ?? 'Changed'} ${routeLabel(String(m.route ?? ''))}`, subject: typeof m.path === 'string' ? m.path : null,
    }
  }
  return {
    at: r.created_at, personId: r.user_id ?? null, person: email(r.user_id ?? null), door: d, type: 'change', action: r.action,
    summary: humanize(r.action), subject: null,
  }
}

/**
 * Newest first, with each `web.change` dropped when the same person has a more specific entry from
 * the web within a few seconds of it (the books' trail or the route's own activity line said what
 * the change was). Pure, so it is pinned by tests.
 */
export function mergeEntries(entries: AuditEntry[]): AuditEntry[] {
  const sorted = [...entries].sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0))
  const specific = sorted.filter(e => e.door === 'web' && e.type === 'change' && e.action !== WEB_CHANGE)
  return sorted.filter(e => {
    if (e.action !== WEB_CHANGE) return true
    const t = Date.parse(e.at)
    return !specific.some(s => s.personId === e.personId && Math.abs(Date.parse(s.at) - t) <= DEDUPE_MS)
  })
}

/** A filed note is shown to someone who reads its area and sees its entity (as lib/records does). */
function noteVisible(access: AccessContext, row: { area: string; vehicle_id: string | null }): boolean {
  return recordAccessProblem(access, { area: row.area, filing: false }) === null && canSeeVehicle(access, row.vehicle_id)
}

/** The engagement the caller belongs to, if any. Admins never belong to one. */
async function callerEngagement(admin: SupabaseClient, access: AccessContext): Promise<string | null> {
  if (access.role === 'admin') return null
  const { data } = await (admin as any).from('fund_members').select('engagement_id').eq('fund_id', access.fundId).eq('user_id', access.userId).maybeSingle()
  return data?.engagement_id ?? null
}

/** May this person see the Audit log at all? Null when yes; otherwise the refusal. */
export function auditAccessProblem(access: AccessContext): string | null {
  if (auditVisibility(access.features) === 'off') return 'Audit is off for this fund. An admin turns it on in Settings.'
  if (!hasAccess(access, 'records', 'read')) {
    return auditVisibility(access.features) === 'admins' ? 'Audit is shown to admins only.' : 'You do not have access to Audit.'
  }
  return null
}

/**
 * The log, grouped by firm, newest first within each. `firm` narrows to one engagement (its id or
 * name); `since`/`until` are dates (default: the last 90 days); `limit` caps each firm (default
 * 200, up to 1000). Someone on an engagement gets only their own firm.
 */
export async function readAuditLog(
  admin: SupabaseClient,
  access: AccessContext,
  opts: { firm?: unknown; since?: unknown; until?: unknown; limit?: unknown; now?: Date } = {},
): Promise<Outcome<AuditLog>> {
  const denied = auditAccessProblem(access)
  if (denied) return fail(403, denied)

  const now = opts.now ?? new Date()
  const since = typeof opts.since === 'string' && DATE.test(opts.since)
    ? opts.since
    : new Date(now.getTime() - 90 * 86_400_000).toISOString().slice(0, 10)
  const until = typeof opts.until === 'string' && DATE.test(opts.until) ? opts.until : null
  const limit = Math.min(Math.max(Number(opts.limit) || 200, 1), 1000)

  const own = await callerEngagement(admin, access)
  let q = (admin as any).from('engagements')
    .select('id, name, kind, starts_on, ends_on, ended_at, member_history')
    .eq('fund_id', access.fundId).order('created_at', { ascending: false })
  if (own) q = q.eq('id', own)
  const { data: engagementRows, error } = await q
  if (error) return dbFail(error, 'audit.engagements')
  let engagements = (engagementRows ?? []) as any[]

  const firmArg = typeof opts.firm === 'string' ? opts.firm.trim() : ''
  if (firmArg) {
    engagements = engagements.filter(e => e.id === firmArg || String(e.name).toLowerCase() === firmArg.toLowerCase())
    if (engagements.length === 0) return fail(404, `No outside firm "${firmArg}" that you can see.`)
  }

  const { data: current } = await (admin as any).from('fund_members')
    .select('user_id, engagement_id').eq('fund_id', access.fundId).not('engagement_id', 'is', null)
  const currentBy = new Map<string, string>(((current ?? []) as any[]).map(m => [m.user_id, m.engagement_id]))

  const peopleOf = new Map<string, string[]>()
  for (const e of engagements) {
    const ids = new Set<string>(e.member_history ?? [])
    for (const [uid, eid] of currentBy) if (eid === e.id) ids.add(uid)
    peopleOf.set(e.id, [...ids])
  }
  const everyone = [...new Set([...peopleOf.values()].flat())]

  const withinWindow = (query: any, col: string) => {
    let qq = query.gte(col, `${since}T00:00:00.000Z`)
    if (until) qq = qq.lte(col, `${until}T23:59:59.999Z`)
    return qq
  }

  // Notes: the firms' own, and (for someone not on an engagement) the fund team's.
  const engagementIds = engagements.map(e => e.id)
  const includeFundNotes = !own && !firmArg
  const notesQuery = async () => {
    if (!hasAccess(access, 'records', 'read')) return [] as any[]
    let nq = (admin as any).from('fund_records')
      .select('id, area, kind, title, vehicle_id, source, filed_by, filed_by_email, engagement_id, created_at')
      .eq('fund_id', access.fundId)
    if (includeFundNotes) {
      nq = engagementIds.length ? nq.or(`engagement_id.is.null,engagement_id.in.(${engagementIds.join(',')})`) : nq.is('engagement_id', null)
    } else {
      if (engagementIds.length === 0) return []
      nq = nq.in('engagement_id', engagementIds)
    }
    const { data } = await withinWindow(nq, 'created_at').order('created_at', { ascending: false }).limit(limit)
    return ((data ?? []) as any[]).filter(r => noteVisible(access, r))
  }

  const [trail, activity, notes] = await Promise.all([
    everyone.length
      ? withinWindow((admin as any).from('accounting_audit_events')
          .select('created_at, actor_id, action, subject_type, subject_id, source, tool:details->>tool')
          .eq('fund_id', access.fundId).in('actor_id', everyone), 'created_at')
          .order('created_at', { ascending: false }).limit(limit * Math.max(engagements.length, 1))
      : Promise.resolve({ data: [] }),
    everyone.length
      ? withinWindow((admin as any).from('user_activity_logs')
          .select('created_at, user_id, action, metadata')
          .eq('fund_id', access.fundId).in('user_id', everyone), 'created_at')
          .order('created_at', { ascending: false }).limit(limit * Math.max(engagements.length, 1))
      : Promise.resolve({ data: [] }),
    notesQuery(),
  ])

  const emails = new Map<string, string>()
  const ids = new Set<string>(everyone)
  for (const n of notes) if (n.filed_by) ids.add(n.filed_by)
  await Promise.all([...ids].map(async id => {
    const { data } = await admin.auth.admin.getUserById(id)
    if (data?.user?.email) emails.set(id, data.user.email)
  }))
  const email = (id: string | null) => (id ? emails.get(id) ?? null : null)

  const trailEntries = ((trail.data ?? []) as any[]).map(r => auditTrailEntry(r, email))
  const activityEntries = ((activity.data ?? []) as any[]).map(r => activityEntry(r, email))
  const noteEntry = (n: any): AuditEntry => ({
    at: n.created_at, personId: n.filed_by ?? null, person: n.filed_by_email ?? email(n.filed_by ?? null), door: door(n.source),
    type: 'note', action: `note.${n.kind}`, summary: `Filed a ${n.kind}: ${n.title}`, subject: n.area, recordId: n.id,
  })

  const firms: AuditFirm[] = engagements.map(e => {
    const people = peopleOf.get(e.id) ?? []
    const mine = new Set(people)
    const all = mergeEntries([
      ...trailEntries.filter(x => x.personId && mine.has(x.personId)),
      ...activityEntries.filter(x => x.personId && mine.has(x.personId)),
      ...notes.filter(n => n.engagement_id === e.id).map(noteEntry),
    ])
    return {
      id: e.id,
      name: e.name,
      kind: e.kind ?? null,
      kindLabel: e.kind ? ENGAGEMENT_KIND_LABELS[e.kind as EngagementKind] ?? null : null,
      startsOn: e.starts_on ?? null,
      endsOn: e.ends_on ?? null,
      endedAt: e.ended_at ?? null,
      people: people.map(id => ({ id, email: email(id), current: currentBy.get(id) === e.id })),
      entries: all.slice(0, limit),
      truncated: all.length > limit,
    }
  })

  const fundNotes = includeFundNotes ? notes.filter(n => !n.engagement_id).map(noteEntry) : []
  if (fundNotes.length) {
    firms.push({
      id: null, name: 'Filed by the fund', kind: null, kindLabel: null, startsOn: null, endsOn: null, endedAt: null,
      people: [], entries: fundNotes.slice(0, limit), truncated: fundNotes.length > limit,
    })
  }

  return done({ visibility: auditVisibility(access.features), since, firms })
}

/**
 * Turn Audit on for members, on for admins only, or off. Admins only (the route and the tool are
 * gated on `admin`); writes the same `feature_visibility` key the Settings page does.
 */
export async function setAuditVisibility(
  admin: SupabaseClient,
  access: AccessContext,
  visibility: unknown,
): Promise<Outcome<{ visibility: AuditVisibility }>> {
  if (access.role !== 'admin') return fail(403, 'Only an admin can turn Audit on or off.')
  if (visibility !== 'members' && visibility !== 'admins' && visibility !== 'off') {
    return fail(400, 'visibility must be members, admins or off.')
  }
  const { data, error } = await (admin as any).from('fund_settings').select('feature_visibility').eq('fund_id', access.fundId).maybeSingle()
  if (error) return dbFail(error, 'audit.settings.read')
  const merged = { ...((data?.feature_visibility as Record<string, string> | null) ?? {}), audit: VISIBILITY_TO_FEATURE[visibility] }
  const { error: upErr } = await (admin as any).from('fund_settings').update({ feature_visibility: merged }).eq('fund_id', access.fundId)
  if (upErr) return dbFail(upErr, 'audit.settings.write')
  return done({ visibility })
}
