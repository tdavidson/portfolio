// Engagements: an outside firm the fund has brought in for a period (20261101100000).
//
// A fund administrator, a tax preparer, an auditor or a compliance vendor. The firm's people are
// ordinary members of the fund, with `fund_members.engagement_id` pointing here, so every gate
// that already applies to a member applies to them: area grants (usually from the matching
// preset), entity grants with a level per entity, and the access end date. The engagement adds:
//
//   - grouping: the fund sees which firm each outside person belongs to;
//   - one end date: assigning a member, or changing the engagement's end date, sets their
//     `access_expires_at` to the end of that day;
//   - ending it: every member's access ends at once, and the access-expiry cron removes them;
//   - a log: what the firm's people did, from the books' audit trail (always on) and the activity
//     log (when the fund keeps one), kept for everyone ever assigned (`member_history`).
//
// Admins are never part of an engagement, for the same reason they never expire.

import type { SupabaseClient } from '@supabase/supabase-js'
import type { PresetKey } from './presets'
import { normalizeExpiry } from './expiry'

export const ENGAGEMENT_KINDS = ['fund_admin', 'tax', 'audit', 'compliance', 'other'] as const
export type EngagementKind = (typeof ENGAGEMENT_KINDS)[number]

export const ENGAGEMENT_KIND_LABELS: Record<EngagementKind, string> = {
  fund_admin: 'Fund administrator',
  tax: 'Tax preparer',
  audit: 'Auditor',
  compliance: 'Compliance vendor',
  other: 'Other',
}

/** The preset an engagement's members usually start from. A suggestion; the grid can change any cell. */
export const ENGAGEMENT_PRESET: Record<EngagementKind, PresetKey | null> = {
  fund_admin: 'fund_admin',
  tax: 'tax',
  audit: 'auditor',
  compliance: 'compliance',
  other: null,
}

export interface EngagementInput {
  name?: unknown
  kind?: unknown
  startsOn?: unknown
  endsOn?: unknown
  notes?: unknown
}

export interface EngagementFields {
  name?: string
  kind?: EngagementKind
  starts_on?: string | null
  ends_on?: string | null
  notes?: string | null
}

const DATE = /^\d{4}-\d{2}-\d{2}$/

/**
 * Validate a create (`creating`: name and kind required) or an update (only what was sent), and
 * map it to columns. Returns the error a person should read, or the fields.
 */
export function engagementFields(input: EngagementInput, creating: boolean): { error: string } | { fields: EngagementFields } {
  const fields: EngagementFields = {}
  if (input.name !== undefined || creating) {
    const name = typeof input.name === 'string' ? input.name.trim() : ''
    if (!name) return { error: 'Give the engagement a name, such as the firm’s.' }
    fields.name = name.slice(0, 120)
  }
  if (input.kind !== undefined || creating) {
    if (!ENGAGEMENT_KINDS.includes(input.kind as EngagementKind)) {
      return { error: `Kind must be one of ${ENGAGEMENT_KINDS.join(', ')}.` }
    }
    fields.kind = input.kind as EngagementKind
  }
  for (const [key, col] of [['startsOn', 'starts_on'], ['endsOn', 'ends_on']] as const) {
    const v = input[key]
    if (v === undefined) continue
    if (v === null || v === '') { fields[col] = null; continue }
    if (typeof v !== 'string' || !DATE.test(v) || Number.isNaN(Date.parse(v))) {
      return { error: `${key === 'startsOn' ? 'Start' : 'End'} date must be a date (YYYY-MM-DD).` }
    }
    fields[col] = v
  }
  if (fields.starts_on && fields.ends_on && fields.ends_on < fields.starts_on) {
    return { error: 'The end date is before the start date.' }
  }
  if (input.notes !== undefined) {
    fields.notes = typeof input.notes === 'string' && input.notes.trim() ? input.notes.trim().slice(0, 2000) : null
  }
  return { fields }
}

/** The access end date an engagement gives its members: the end of its last day, or none. */
export function engagementExpiry(endsOn: string | null | undefined): string | null {
  return endsOn ? normalizeExpiry(endsOn) : null
}

/** Why this member cannot join this engagement, or null when they can. */
export function assignProblem(args: {
  engagement: { ended_at: string | null; ends_on: string | null } | null
  target: { role: string } | null
  now?: Date
}): { error: string; status: number } | null {
  if (!args.engagement) return { error: 'Engagement not found', status: 404 }
  if (!args.target) return { error: 'Not a member of this fund', status: 404 }
  if (args.target.role === 'admin') {
    return { error: 'Admins are never part of an engagement, because their access never ends. Make them a member first.', status: 400 }
  }
  if (args.target.role === 'viewer') return { error: 'The demo account cannot join an engagement.', status: 400 }
  if (args.engagement.ended_at) return { error: 'This engagement has ended. Start a new one to bring people back.', status: 400 }
  const expiry = engagementExpiry(args.engagement.ends_on)
  if (expiry && Date.parse(expiry) <= (args.now ?? new Date()).getTime()) {
    return { error: 'This engagement’s end date has passed. Move it out before adding anyone.', status: 400 }
  }
  return null
}

export interface EngagementActivity {
  at: string
  actorId: string | null
  actorEmail: string | null
  action: string
  /** Where it was recorded: the books' audit trail, or the activity log. */
  source: 'audit' | 'activity'
  subject: string | null
  door: string | null
}

/**
 * What an engagement's people did, newest first: the books' audit trail (which can't be switched
 * off) merged with the activity log (which a fund can switch off). Covers everyone ever assigned.
 */
export async function engagementActivity(
  admin: SupabaseClient,
  args: { fundId: string; memberIds: string[]; limit?: number },
): Promise<EngagementActivity[]> {
  if (args.memberIds.length === 0) return []
  const limit = Math.min(Math.max(args.limit ?? 200, 1), 500)
  const [{ data: audit }, { data: activity }] = await Promise.all([
    (admin as any).from('accounting_audit_events')
      .select('created_at, actor_id, action, subject_type, subject_id, source')
      .eq('fund_id', args.fundId).in('actor_id', args.memberIds)
      .order('created_at', { ascending: false }).limit(limit),
    (admin as any).from('user_activity_logs')
      .select('created_at, user_id, action, metadata')
      .eq('fund_id', args.fundId).in('user_id', args.memberIds)
      .order('created_at', { ascending: false }).limit(limit),
  ])

  const emails = new Map<string, string>()
  await Promise.all(args.memberIds.map(async id => {
    const { data } = await admin.auth.admin.getUserById(id)
    if (data?.user?.email) emails.set(id, data.user.email)
  }))

  const rows: EngagementActivity[] = [
    ...((audit ?? []) as any[]).map(r => ({
      at: r.created_at as string,
      actorId: (r.actor_id as string) ?? null,
      actorEmail: r.actor_id ? emails.get(r.actor_id) ?? null : null,
      action: r.action as string,
      source: 'audit' as const,
      subject: r.subject_id ? `${r.subject_type} ${r.subject_id}` : (r.subject_type as string),
      door: (r.source as string) ?? null,
    })),
    ...((activity ?? []) as any[]).map(r => ({
      at: r.created_at as string,
      actorId: (r.user_id as string) ?? null,
      actorEmail: r.user_id ? emails.get(r.user_id) ?? null : null,
      action: r.action as string,
      source: 'activity' as const,
      subject: null,
      door: (r.metadata?.changeSource as string) ?? null,
    })),
  ]
  return rows.sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0)).slice(0, limit)
}
