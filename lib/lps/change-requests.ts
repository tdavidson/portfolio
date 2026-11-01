// LP change requests: an investor asks for a change to their record, or for portal access for
// someone acting for them, and someone at the fund approves or rejects it
// (20261101120000_lp_change_requests.sql).
//
// Who may ask: the investor's PRIMARY LP account (lp_account_links), on the web portal or the
// investor connector. An authorized user's access is read-only by design, so they can't. Requests
// are validated when made (the same parsers staff edits use), so a reviewer never sees one that
// would fail on approval for its shape.
//
// What an LP may ask to change: the facts on an entity's record a subscription document is filled
// from (entity type, formation jurisdiction, address, notice email, signatories) and the investor's
// contact details. Not the fund's own notes on them, and not whether they're on the onboarding
// checklist; those are the fund's.
//
// Who may approve: approving runs the function staff use to make the change directly, as the
// approver. A record change needs write on LP capital and the entity in their scope; portal access
// for an authorized user is admin-only, as it is when staff grant it directly.

import type { SupabaseClient } from '@supabase/supabase-js'
import { parseEntityProfile, parseInvestorContact, type EntityProfilePatch } from '@/lib/lp-profile'
import { PortalError, type LpPrincipal } from '@/lib/portal/service'
import { getOutboundConfig, sendOutboundEmail } from '@/lib/email'
import { logLpAccessEvent } from '@/lib/lp-access-log'
import { updateEntityProfile } from './records'
import { addAuthorizedUser } from './portal-access'
import { recordAudit } from '@/lib/audit/events'
import { done, fail, dbFail, type Outcome } from '@/lib/service-outcome'

export type ChangeKind = 'profile' | 'authorized_user'
export type ChangeStatus = 'pending' | 'approved' | 'rejected' | 'withdrawn'

/** The entity fields an LP may ask to change. The fund's notes and checklist exclusion are the fund's. */
export const LP_EDITABLE_ENTITY_FIELDS = [
  'entity_type', 'formation_jurisdiction', 'address_line1', 'address_line2', 'city', 'region', 'postal_code', 'country',
  'notice_email', 'signatories',
] as const

const ENTITY_SELECT = 'id, fund_id, investor_id, entity_name, entity_type, formation_jurisdiction, address_line1, address_line2, city, region, postal_code, country, notice_email, signatories'
const INVESTOR_SELECT = 'id, fund_id, name, contact_name, contact_email, contact_phone'

export interface ChangeRequestRow {
  id: string
  kind: ChangeKind
  status: ChangeStatus
  investorId: string
  investorName: string | null
  entityId: string | null
  entityName: string | null
  payload: Record<string, unknown>
  current: Record<string, unknown>
  note: string | null
  requestedByEmail: string | null
  createdAt: string
  decidedAt: string | null
  decisionNote: string | null
}

/**
 * Validate what an LP asked for and keep only what they may change. Returns the error to show, or
 * the payload to store. Fields equal to what is on file are dropped, so an empty change is refused.
 */
export function profileChangePayload(
  input: { entity?: unknown; contact?: unknown },
  current: { entity: Record<string, unknown> | null; investor: Record<string, unknown> | null },
): { error: string } | { payload: { entity?: Partial<EntityProfilePatch>; investor?: Record<string, unknown> } } {
  const ent = input.entity != null ? parseEntityProfile(input.entity) : { patch: {} }
  if ('error' in ent) return { error: ent.error }
  const inv = input.contact != null ? parseInvestorContact(input.contact) : { patch: {} }
  if ('error' in inv) return { error: inv.error }

  const entity: Record<string, unknown> = {}
  for (const k of LP_EDITABLE_ENTITY_FIELDS) {
    const v = (ent.patch as Record<string, unknown>)[k]
    if (v === undefined) continue
    if (JSON.stringify(v ?? null) === JSON.stringify(current.entity?.[k] ?? null)) continue
    entity[k] = v
  }
  const investor: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(inv.patch)) {
    if (v === undefined) continue
    if ((v ?? null) === (current.investor?.[k] ?? null)) continue
    investor[k] = v
  }
  if (Object.keys(entity).length === 0 && Object.keys(investor).length === 0) {
    return { error: 'Nothing to change: what you sent matches the record the fund has.' }
  }
  return {
    payload: {
      ...(Object.keys(entity).length ? { entity: entity as Partial<EntityProfilePatch> } : {}),
      ...(Object.keys(investor).length ? { investor } : {}),
    },
  }
}

const EMAIL = /^[^@\s]+@[^@\s]+\.[^@\s]+$/

/** Validate an authorized-user request: an email, and a name if given. */
export function authorizedUserPayload(input: { email?: unknown; name?: unknown }, ownEmail: string | null | undefined):
  { error: string } | { payload: { email: string; display_name: string | null } } {
  const email = typeof input.email === 'string' ? input.email.trim().toLowerCase() : ''
  if (!EMAIL.test(email)) return { error: 'Give the email address of the person who should get access.' }
  if (ownEmail && email === ownEmail.toLowerCase()) return { error: 'That is your own address; you already have access.' }
  const name = typeof input.name === 'string' && input.name.trim() ? input.name.trim().slice(0, 200) : null
  return { payload: { email, display_name: name } }
}

const cleanNote = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim().slice(0, 2000) : null)

// ---------------------------------------------------------------------------
// The LP side
// ---------------------------------------------------------------------------

/**
 * The investors this account is the primary LP for, in funds whose portal is on. Authorized users
 * act for an investor with read-only access, so they're not in this list.
 */
async function ownInvestorIds(admin: SupabaseClient, p: LpPrincipal): Promise<string[]> {
  if (p.investorIds.length === 0) return []
  const { data } = await (admin as any).from('lp_account_links')
    .select('lp_investor_id').eq('lp_account_id', p.lpAccountId).in('lp_investor_id', p.investorIds)
  return Array.from(new Set(((data ?? []) as any[]).map(r => r.lp_investor_id as string)))
}

const NOT_PRIMARY = new PortalError(403,
  'Only the investor’s own portal account can ask for changes. As an authorized user your access is read-only; ask the investor, or message the fund.')

async function portalOn(admin: SupabaseClient, fundId: string): Promise<boolean> {
  const { data } = await (admin as any).from('fund_settings').select('lp_portal_enabled').eq('fund_id', fundId).maybeSingle()
  return !!data?.lp_portal_enabled
}

async function requesterEmail(admin: SupabaseClient, p: LpPrincipal): Promise<string | null> {
  const { data } = await (admin as any).from('lp_accounts').select('email').eq('id', p.lpAccountId).maybeSingle()
  return (data?.email as string | undefined) ?? p.email ?? null
}

/** Ask for a change to one of the investor's entities, or their contact details. */
export async function requestProfileChange(
  admin: SupabaseClient, p: LpPrincipal,
  input: { entity_id?: unknown; entity?: unknown; contact?: unknown; note?: unknown },
): Promise<{ ok: true; id: string; status: 'pending'; next: string }> {
  const db = admin as any
  const entityId = typeof input.entity_id === 'string' ? input.entity_id : ''
  if (!entityId) throw new PortalError(400, 'entity_id is required (from your record).')
  const { data: entity } = await db.from('lp_entities').select(ENTITY_SELECT).eq('id', entityId).maybeSingle()
  if (!entity || !p.investorIds.includes(entity.investor_id)) throw new PortalError(404, 'Not found')
  if (!(await ownInvestorIds(admin, p)).includes(entity.investor_id)) throw NOT_PRIMARY
  if (!(await portalOn(admin, entity.fund_id))) throw new PortalError(404, 'Not found')
  const { data: investor } = await db.from('lp_investors').select(INVESTOR_SELECT).eq('id', entity.investor_id).maybeSingle()

  const parsed = profileChangePayload({ entity: input.entity, contact: input.contact }, { entity, investor })
  if ('error' in parsed) throw new PortalError(400, parsed.error)
  const current = {
    entity: Object.fromEntries(LP_EDITABLE_ENTITY_FIELDS.map(k => [k, entity[k] ?? null])),
    investor: investor ? { contact_name: investor.contact_name, contact_email: investor.contact_email, contact_phone: investor.contact_phone } : {},
  }
  return insertRequest(admin, p, {
    fundId: entity.fund_id, investorId: entity.investor_id, entityId, kind: 'profile',
    payload: parsed.payload, current, note: cleanNote(input.note),
    title: `Change request for ${entity.entity_name}`, investorName: investor?.name ?? null,
  })
}

/** Ask the fund to give someone portal access to act for one of the investor's investments. */
export async function requestAuthorizedUser(
  admin: SupabaseClient, p: LpPrincipal,
  input: { investor_id?: unknown; email?: unknown; name?: unknown; note?: unknown },
): Promise<{ ok: true; id: string; status: 'pending'; next: string }> {
  const db = admin as any
  const own = await ownInvestorIds(admin, p)
  if (own.length === 0) throw NOT_PRIMARY
  const investorId = typeof input.investor_id === 'string' && input.investor_id ? input.investor_id : own.length === 1 ? own[0] : ''
  if (!investorId) throw new PortalError(400, 'You invest through more than one investor record; say which (investor_id).')
  if (!own.includes(investorId)) throw p.investorIds.includes(investorId) ? NOT_PRIMARY : new PortalError(404, 'Not found')
  const { data: investor } = await db.from('lp_investors').select(INVESTOR_SELECT).eq('id', investorId).maybeSingle()
  if (!investor || !(await portalOn(admin, investor.fund_id))) throw new PortalError(404, 'Not found')

  const parsed = authorizedUserPayload(input, await requesterEmail(admin, p))
  if ('error' in parsed) throw new PortalError(400, parsed.error)
  return insertRequest(admin, p, {
    fundId: investor.fund_id, investorId, entityId: null, kind: 'authorized_user',
    payload: parsed.payload, current: {}, note: cleanNote(input.note),
    title: `Access request for ${parsed.payload.email}`, investorName: investor.name ?? null,
  })
}

async function insertRequest(
  admin: SupabaseClient, p: LpPrincipal,
  r: { fundId: string; investorId: string; entityId: string | null; kind: ChangeKind; payload: object; current: object; note: string | null; title: string; investorName: string | null },
): Promise<{ ok: true; id: string; status: 'pending'; next: string }> {
  const db = admin as any
  const email = await requesterEmail(admin, p)
  const { data, error } = await db.from('lp_change_requests').insert({
    fund_id: r.fundId, lp_investor_id: r.investorId, lp_entity_id: r.entityId, kind: r.kind,
    payload: r.payload, current: r.current, note: r.note,
    requested_by_account_id: p.lpAccountId, requested_by_email: email,
  }).select('id').single()
  if (error) {
    console.error('[lp-change-requests] insert failed', error.message)
    throw new PortalError(500, 'Your request could not be saved. Try again, or message the fund.')
  }
  await logLpAccessEvent(admin, {
    fundId: r.fundId, lpAccountId: p.lpAccountId, authUserId: p.userId, lpInvestorId: r.investorId,
    eventType: 'message', targetType: 'portal', targetTitle: r.title,
  })
  await notifyAdmins(admin, r.fundId, r.investorName, email, r.kind)
  return {
    ok: true, id: data.id, status: 'pending',
    next: 'Sent to the fund. Nothing changes until someone there approves it; you can see where it stands, or withdraw it, under your requests.',
  }
}

/** Email the fund's admins that a request is waiting. Best-effort: the request is already saved. */
async function notifyAdmins(admin: SupabaseClient, fundId: string, investorName: string | null, fromEmail: string | null, kind: ChangeKind) {
  try {
    const config = await getOutboundConfig(admin, fundId)
    if (!config) return
    const { data: members } = await (admin as any).from('fund_members').select('user_id').eq('fund_id', fundId).eq('role', 'admin')
    const what = kind === 'profile' ? 'a change to their record' : 'portal access for someone acting for them'
    const who = investorName ?? 'An investor'
    for (const m of (members ?? []) as { user_id: string }[]) {
      const { data } = await admin.auth.admin.getUserById(m.user_id)
      const to = data?.user?.email
      if (!to) continue
      await sendOutboundEmail(config, {
        to,
        subject: `LP change request from ${who}`,
        html: `<p>${escapeHtml(who)}${fromEmail ? ` (${escapeHtml(fromEmail)})` : ''} asked for ${what}. Review it under LPs → Change requests.</p>`,
      }).catch(err => console.error('[lp-change-requests] email failed:', err instanceof Error ? err.message : err))
    }
  } catch (err) {
    console.error('[lp-change-requests] notify failed:', err instanceof Error ? err.message : err)
  }
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!))
}

/** The investor's record as the portal shows it, for the request form: their entities and contact. */
export async function portalRecord(admin: SupabaseClient, p: LpPrincipal) {
  const db = admin as any
  const own = await ownInvestorIds(admin, p)
  if (own.length === 0) return { canRequest: false, investors: [] as any[] }
  const [{ data: investors }, { data: entities }] = await Promise.all([
    db.from('lp_investors').select(INVESTOR_SELECT).in('id', own),
    db.from('lp_entities').select(ENTITY_SELECT).in('investor_id', own).order('entity_name'),
  ])
  const on = new Set<string>()
  for (const fundId of new Set(((investors ?? []) as any[]).map(i => i.fund_id as string))) {
    if (await portalOn(admin, fundId)) on.add(fundId)
  }
  return {
    canRequest: true,
    investors: ((investors ?? []) as any[]).filter(i => on.has(i.fund_id)).map(i => ({
      id: i.id, name: i.name,
      contact: { contact_name: i.contact_name, contact_email: i.contact_email, contact_phone: i.contact_phone },
      entities: ((entities ?? []) as any[]).filter(e => e.investor_id === i.id).map(e => ({
        id: e.id, name: e.entity_name,
        ...Object.fromEntries(LP_EDITABLE_ENTITY_FIELDS.map(k => [k, e[k] ?? null])),
      })),
    })),
  }
}

/** This account's requests, newest first. */
export async function myChangeRequests(admin: SupabaseClient, p: LpPrincipal): Promise<ChangeRequestRow[]> {
  const { data } = await (admin as any).from('lp_change_requests')
    .select('*, lp_investors(name), lp_entities(entity_name)')
    .eq('requested_by_account_id', p.lpAccountId).in('lp_investor_id', p.investorIds.length ? p.investorIds : ['00000000-0000-0000-0000-000000000000'])
    .order('created_at', { ascending: false }).limit(100)
  return ((data ?? []) as any[]).map(toRow)
}

/** Withdraw one of this account's own requests while it is still pending. */
export async function withdrawChangeRequest(admin: SupabaseClient, p: LpPrincipal, id: unknown): Promise<{ ok: true }> {
  const { data } = await (admin as any).from('lp_change_requests')
    .update({ status: 'withdrawn', decided_at: new Date().toISOString() })
    .eq('id', String(id ?? '')).eq('requested_by_account_id', p.lpAccountId).eq('status', 'pending')
    .select('id')
  if (!data || (data as any[]).length === 0) throw new PortalError(404, 'No pending request of yours with that id.')
  return { ok: true }
}

function toRow(r: any): ChangeRequestRow {
  return {
    id: r.id, kind: r.kind, status: r.status,
    investorId: r.lp_investor_id, investorName: r.lp_investors?.name ?? null,
    entityId: r.lp_entity_id ?? null, entityName: r.lp_entities?.entity_name ?? null,
    payload: r.payload ?? {}, current: r.current ?? {}, note: r.note ?? null,
    requestedByEmail: r.requested_by_email ?? null, createdAt: r.created_at,
    decidedAt: r.decided_at ?? null, decisionNote: r.decision_note ?? null,
  }
}

// ---------------------------------------------------------------------------
// The fund side
// ---------------------------------------------------------------------------

export interface StaffActor {
  fundId: string
  userId: string
  role: string
  /** LP investors / entities in the caller's scope (lib/access/lp-scope.ts); null = all. */
  investorIds: string[] | null
  entityIds: string[] | null
  /** May change LP records (write on LP capital). */
  canWrite: boolean
}

/** Requests in this fund the caller may see: pending by default, or every one. */
export async function listChangeRequests(
  admin: SupabaseClient, actor: Pick<StaffActor, 'fundId' | 'investorIds'>, opts: { includeClosed?: boolean; limit?: number } = {},
): Promise<Outcome<ChangeRequestRow[]>> {
  if (actor.investorIds && actor.investorIds.length === 0) return done([])
  let q = (admin as any).from('lp_change_requests')
    .select('*, lp_investors(name), lp_entities(entity_name)')
    .eq('fund_id', actor.fundId)
    .order('created_at', { ascending: false })
    .limit(Math.min(Math.max(opts.limit ?? 100, 1), 500))
  if (!opts.includeClosed) q = q.eq('status', 'pending')
  if (actor.investorIds) q = q.in('lp_investor_id', actor.investorIds)
  const { data, error } = await q
  if (error?.code === '42P01' || error?.code === 'PGRST205') {
    return fail(409, 'LP change requests need the latest database migration (20261101120000_lp_change_requests.sql).')
  }
  if (error) return dbFail(error, 'lp-change-requests')
  return done(((data ?? []) as any[]).map(toRow))
}

/**
 * Approve or reject a pending request. Approving makes the change through the same function a
 * direct edit uses, as the approver; if that refuses, the request stays pending and says why.
 */
export async function decideChangeRequest(
  admin: SupabaseClient, actor: StaffActor,
  input: { id?: unknown; decision?: unknown; note?: unknown },
): Promise<Outcome<{ ok: true; status: 'approved' | 'rejected'; result?: unknown }>> {
  const db = admin as any
  const decision = input.decision
  if (decision !== 'approve' && decision !== 'reject') return fail(400, 'decision must be approve or reject')
  const { data: req, error } = await db.from('lp_change_requests').select('*')
    .eq('id', String(input.id ?? '')).eq('fund_id', actor.fundId).maybeSingle()
  if (error) return dbFail(error, 'lp-change-requests')
  if (!req || (actor.investorIds && !actor.investorIds.includes(req.lp_investor_id))) return fail(404, 'Change request not found')
  if (req.status !== 'pending') return fail(409, `This request was already ${req.status}.`)

  if (!actor.canWrite) return fail(403, 'Deciding LP change requests needs write access to LP capital.')
  if (req.kind === 'authorized_user' && actor.role !== 'admin') {
    return fail(403, 'Only an admin can give someone portal access. An admin can approve this request.')
  }

  let result: unknown
  if (decision === 'approve') {
    if (req.kind === 'profile') {
      const out = await updateEntityProfile(admin, { fundId: actor.fundId, userId: actor.userId, visibleEntityIds: actor.entityIds }, req.lp_entity_id, {
        entity: req.payload?.entity, investor: req.payload?.investor,
      })
      if (!out.ok) return out
      result = out.value
    } else {
      const out = await addAuthorizedUser(admin, { fundId: actor.fundId, userId: actor.userId }, {
        lpInvestorId: req.lp_investor_id, email: req.payload?.email ?? '', displayName: req.payload?.display_name ?? null,
      })
      if (!out.ok) return out
      result = out.value
    }
  }

  const status = decision === 'approve' ? 'approved' : 'rejected'
  const { error: upErr } = await db.from('lp_change_requests')
    .update({ status, decided_by: actor.userId, decided_at: new Date().toISOString(), decision_note: cleanNote(input.note) })
    .eq('id', req.id).eq('status', 'pending')
  if (upErr) return dbFail(upErr, 'lp-change-requests-decide')
  await recordAudit(admin, {
    fundId: actor.fundId, actorId: actor.userId,
    action: decision === 'approve' ? 'lp_change.approve' : 'lp_change.reject',
    subjectType: 'lp_change_request', subjectId: req.id, reason: cleanNote(input.note),
    details: { kind: req.kind, investorId: req.lp_investor_id, entityId: req.lp_entity_id, payload: req.payload },
  })
  return done({ ok: true, status, ...(result !== undefined ? { result } : {}) })
}
