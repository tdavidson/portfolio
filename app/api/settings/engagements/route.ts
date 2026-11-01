import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { assertAdminAccess } from '@/lib/api-helpers'
import { dbError } from '@/lib/api-error'
import { expireTag } from '@/lib/cache/tags'
import { logActivity } from '@/lib/activity'
import {
  ENGAGEMENT_KINDS, ENGAGEMENT_KIND_LABELS, ENGAGEMENT_PRESET,
  assignProblem, engagementExpiry, engagementFields,
} from '@/lib/access/engagements'

// Engagements: outside firms (fund administrator, tax, audit, compliance) and the members who work
// for them. See lib/access/engagements.ts.
//
// GET   → { kinds, engagements: [{ ..., members: [{ userId, email, accessExpiresAt }] }], candidates }
// POST  → { name, kind, startsOn?, endsOn?, notes? }       create one
// PATCH → { id, name?, kind?, startsOn?, endsOn?, notes? } edit; a new end date moves every member's
//       | { id, assign: userId }                            add a member (sets their end date)
//       | { id, unassign: userId }                          take a member out (end date kept)
//       | { id, end: true }                                 end it: every member's access ends now
//
// Admin-only, like the access grid it sits beside.

export const dynamic = 'force-dynamic'

const MISSING = 'Engagements need the latest database migration (20261101100000_engagements_and_entity_levels.sql). Apply it, then try again.'
const isMissing = (e: { code?: string } | null | undefined) => e?.code === '42P01' || e?.code === '42703' || e?.code === 'PGRST205'

async function gateAdmin() {
  const supabase = await createClient()
  const admin = createAdminClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return { error: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }) }
  const gate = await assertAdminAccess(admin, user.id)
  if (gate instanceof NextResponse) return { error: gate }
  return { admin, user, gate }
}

export async function GET() {
  const g = await gateAdmin()
  if ('error' in g) return g.error
  const { admin, gate } = g

  const [{ data: engagements, error }, { data: members }] = await Promise.all([
    (admin as any).from('engagements').select('*').eq('fund_id', gate.fundId).order('created_at', { ascending: false }),
    admin.from('fund_members').select('*').eq('fund_id', gate.fundId),
  ])
  if (isMissing(error)) return NextResponse.json({ error: MISSING, needsMigration: true }, { status: 409 })
  if (error) return dbError(error, 'settings-engagements')

  const rows = (members ?? []) as any[]
  const emails = new Map<string, string>()
  await Promise.all(rows.map(async m => {
    const { data } = await admin.auth.admin.getUserById(m.user_id)
    if (data?.user?.email) emails.set(m.user_id, data.user.email)
  }))
  const person = (m: any) => ({ userId: m.user_id, email: emails.get(m.user_id) ?? '(unknown)', accessExpiresAt: m.access_expires_at ?? null })

  return NextResponse.json({
    kinds: ENGAGEMENT_KINDS.map(k => ({ key: k, label: ENGAGEMENT_KIND_LABELS[k], preset: ENGAGEMENT_PRESET[k] })),
    engagements: ((engagements ?? []) as any[]).map(e => ({
      id: e.id,
      name: e.name,
      kind: e.kind,
      startsOn: e.starts_on,
      endsOn: e.ends_on,
      endedAt: e.ended_at,
      notes: e.notes,
      createdAt: e.created_at,
      members: rows.filter(m => m.engagement_id === e.id).map(person),
    })),
    // Members who could be added: not admins, not the demo account, not already in one.
    candidates: rows.filter(m => m.role === 'member' && !m.engagement_id).map(person),
  })
}

export async function POST(req: NextRequest) {
  const g = await gateAdmin()
  if ('error' in g) return g.error
  const { admin, user, gate } = g

  const body = await req.json().catch(() => ({}))
  const parsed = engagementFields(body ?? {}, true)
  if ('error' in parsed) return NextResponse.json({ error: parsed.error }, { status: 400 })

  const { data, error } = await (admin as any).from('engagements')
    .insert({ ...parsed.fields, fund_id: gate.fundId, created_by: user.id })
    .select('id').single()
  if (isMissing(error)) return NextResponse.json({ error: MISSING, needsMigration: true }, { status: 409 })
  if (error) return dbError(error, 'settings-engagements-create')
  logActivity(admin, gate.fundId, user.id, 'engagement.created', { engagementId: data.id, kind: parsed.fields.kind })
  return NextResponse.json({ ok: true, id: data.id })
}

export async function PATCH(req: NextRequest) {
  const g = await gateAdmin()
  if ('error' in g) return g.error
  const { admin, user, gate } = g

  const body = await req.json().catch(() => ({}))
  const id = String(body?.id ?? '')
  const { data: engagement, error: readErr } = await (admin as any).from('engagements')
    .select('id, fund_id, ends_on, ended_at, member_history').eq('id', id).eq('fund_id', gate.fundId).maybeSingle()
  if (isMissing(readErr)) return NextResponse.json({ error: MISSING, needsMigration: true }, { status: 409 })
  if (!engagement) return NextResponse.json({ error: 'Engagement not found' }, { status: 404 })

  // --- Add a member ---
  if (body?.assign !== undefined) {
    const targetId = String(body.assign)
    const { data: target } = await admin.from('fund_members').select('user_id, role')
      .eq('fund_id', gate.fundId).eq('user_id', targetId).maybeSingle()
    const problem = assignProblem({ engagement, target: target as any })
    if (problem) return NextResponse.json({ error: problem.error }, { status: problem.status })
    const expiry = engagementExpiry(engagement.ends_on)
    const { error } = await admin.from('fund_members')
      .update({ engagement_id: id, ...(expiry ? { access_expires_at: expiry } : {}) } as any)
      .eq('fund_id', gate.fundId).eq('user_id', targetId).neq('role', 'admin')
    if (error) return dbError(error, 'settings-engagements-assign')
    const history: string[] = engagement.member_history ?? []
    if (!history.includes(targetId)) {
      await (admin as any).from('engagements').update({ member_history: [...history, targetId] }).eq('id', id)
    }
    logActivity(admin, gate.fundId, user.id, 'engagement.member_added', { engagementId: id, member: targetId })
    expireTag('membership')
    return NextResponse.json({ ok: true, accessExpiresAt: expiry })
  }

  // --- Take a member out. Their end date stays; clear it in the access grid if they stay on. ---
  if (body?.unassign !== undefined) {
    const targetId = String(body.unassign)
    const { error } = await admin.from('fund_members').update({ engagement_id: null } as any)
      .eq('fund_id', gate.fundId).eq('user_id', targetId).eq('engagement_id', id)
    if (error) return dbError(error, 'settings-engagements-unassign')
    logActivity(admin, gate.fundId, user.id, 'engagement.member_removed', { engagementId: id, member: targetId })
    return NextResponse.json({ ok: true })
  }

  // --- End it: every member's access ends now; the access-expiry cron removes them. ---
  if (body?.end === true) {
    if (engagement.ended_at) return NextResponse.json({ error: 'This engagement has already ended.' }, { status: 400 })
    const now = new Date().toISOString()
    const { error } = await (admin as any).from('engagements').update({ ended_at: now }).eq('id', id)
    if (error) return dbError(error, 'settings-engagements-end')
    const { error: memErr } = await admin.from('fund_members').update({ access_expires_at: now } as any)
      .eq('fund_id', gate.fundId).eq('engagement_id', id).neq('role', 'admin')
    if (memErr) return dbError(memErr, 'settings-engagements-end-members')
    logActivity(admin, gate.fundId, user.id, 'engagement.ended', { engagementId: id })
    expireTag('membership')
    return NextResponse.json({ ok: true, endedAt: now })
  }

  // --- Edit ---
  const parsed = engagementFields(body ?? {}, false)
  if ('error' in parsed) return NextResponse.json({ error: parsed.error }, { status: 400 })
  if (Object.keys(parsed.fields).length === 0) return NextResponse.json({ error: 'Nothing to change' }, { status: 400 })
  const { error } = await (admin as any).from('engagements').update(parsed.fields).eq('id', id)
  if (error) return dbError(error, 'settings-engagements-edit')

  // A new end date moves every current member's, unless the engagement is already over.
  if (parsed.fields.ends_on !== undefined && !engagement.ended_at) {
    const { error: memErr } = await admin.from('fund_members')
      .update({ access_expires_at: engagementExpiry(parsed.fields.ends_on) } as any)
      .eq('fund_id', gate.fundId).eq('engagement_id', id).neq('role', 'admin')
    if (memErr) return dbError(memErr, 'settings-engagements-edit-members')
    expireTag('membership')
  }
  logActivity(admin, gate.fundId, user.id, 'engagement.edited', { engagementId: id, fields: Object.keys(parsed.fields) })
  return NextResponse.json({ ok: true })
}
