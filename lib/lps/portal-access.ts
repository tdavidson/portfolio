// Who can sign in to the LP portal, and the invites that get them there. Shared by the LP Portal
// page's routes (app/api/lps/invites, /invites/resend, /invites/bulk, /authorized-users, and the
// two portal switches on /api/settings) and the `lp_portal_*` / `lp_authorized_user*` agent tools
// (lib/agent/lp-portal-tools.ts), so a rule added here reaches both doors.
//
// The caller authorizes: every one of these is admin-only (the routes check the role, the tools
// are in ADMIN_ONLY_TOOLS and check it again in the handler). Writes go through the service-role
// client with manual fund scoping; an investor or account is verified to belong to the fund before
// anything is linked, switched or emailed.

import type { SupabaseClient } from '@supabase/supabase-js'
import { buildInviteEmail, bindAuthUser, ensureEntityForInvestor, ensureLpAccount, sendLpInvite } from '@/lib/lp-invites'
import { done, dbFail, fail, type Outcome } from '@/lib/service-outcome'
import { expireTag } from '@/lib/cache/tags'
import { logActivity } from '@/lib/activity'
import { runPool } from '@/lib/async-pool'

/** The admin acting, in their fund. */
export interface PortalActor {
  fundId: string
  userId: string
}

const fundNameOf = async (admin: SupabaseClient, fundId: string): Promise<string | null> => {
  const { data } = await (admin as any).from('funds').select('name').eq('id', fundId).maybeSingle()
  return (data?.name as string | undefined) ?? null
}

// ── Accounts ────────────────────────────────────────────────────────────────────────────────

export interface PortalAccountRow {
  id: string
  lp_investor_id: string
  created_at: string
  lp_accounts: { id: string; email: string; display_name: string | null; status: string; kind: string } | null
  lp_investors: { name: string } | null
  last_login_at: string | null
  last_invite_at: string | null
  last_invite_status: string | null
  last_invite_error: string | null
}

/**
 * Every LP account linked to an investor in this fund: who is invited, active or disabled, when
 * they last signed in, and when they were last emailed an invite.
 */
export async function listPortalAccounts(admin: SupabaseClient, fundId: string): Promise<Outcome<PortalAccountRow[]>> {
  const a = admin as any
  const { data, error } = await a
    .from('lp_account_links')
    .select('id, lp_investor_id, created_at, lp_accounts(id, email, display_name, status, kind, auth_user_id), lp_investors(name)')
    .eq('fund_id', fundId)
    .order('created_at', { ascending: false })
  if (error) return dbFail(error, 'lps-invites')

  const links = (data ?? []) as any[]
  const accountIds = Array.from(new Set(links.map(l => l.lp_accounts?.id).filter(Boolean))) as string[]

  // Last sign-in and last invite per account, from the two logs that record them.
  const lastLogin = new Map<string, string>()
  const lastInvite = new Map<string, { at: string; status: string; error: string | null }>()
  if (accountIds.length > 0) {
    const [{ data: logins }, { data: invites }] = await Promise.all([
      a.from('lp_access_events').select('lp_account_id, created_at').eq('fund_id', fundId).eq('event_type', 'login').in('lp_account_id', accountIds).order('created_at', { ascending: false }),
      a.from('lp_deliveries').select('item_id, sent_at, status, error').eq('fund_id', fundId).eq('kind', 'invite').in('item_id', accountIds).order('sent_at', { ascending: false }),
    ])
    for (const r of (logins ?? []) as any[]) if (!lastLogin.has(r.lp_account_id)) lastLogin.set(r.lp_account_id, r.created_at)
    for (const r of (invites ?? []) as any[]) if (!lastInvite.has(r.item_id)) lastInvite.set(r.item_id, { at: r.sent_at, status: r.status, error: r.error ?? null })
  }

  return done(links.map(l => {
    const acct = l.lp_accounts ?? null
    const inv = acct ? lastInvite.get(acct.id) : undefined
    return {
      id: l.id,
      lp_investor_id: l.lp_investor_id,
      created_at: l.created_at,
      lp_accounts: acct ? { id: acct.id, email: acct.email, display_name: acct.display_name, status: acct.status, kind: acct.kind } : null,
      lp_investors: l.lp_investors ?? null,
      last_login_at: acct ? (lastLogin.get(acct.id) ?? null) : null,
      last_invite_at: inv?.at ?? null,
      last_invite_status: inv?.status ?? null,
      last_invite_error: inv?.error ?? null,
    }
  }))
}

export interface InviteInput {
  lpInvestorId: string
  email: string
  displayName?: string | null
}

export type InviteResultBody =
  | { ok: true; lp_account_id: string; emailed: false; already_active: true }
  | { ok: true; lp_account_id: string; emailed: boolean; method: 'supabase' | 'outbound' | null; warning: string | null }

/** Normalize an invite request as the route reads it: a trimmed, lower-cased email. */
export function inviteInputFrom(body: any): InviteInput {
  return {
    email: typeof body?.email === 'string' ? body.email.trim().toLowerCase() : '',
    lpInvestorId: typeof body?.lp_investor_id === 'string' ? body.lp_investor_id : '',
    displayName: typeof body?.display_name === 'string' ? body.display_name.trim() : '',
  }
}

/**
 * Create (or reuse) an lp_account for the email, link it to the investor, and email the invite.
 * The result says whether an email actually went out (`emailed`) and why not when it didn't.
 */
export async function inviteLp(admin: SupabaseClient, actor: PortalActor, input: InviteInput): Promise<Outcome<InviteResultBody>> {
  const a = admin as any
  const { fundId } = actor
  const { email, lpInvestorId } = input
  if (!email || !email.includes('@')) return fail(400, 'A valid email is required')
  if (!lpInvestorId) return fail(400, 'lp_investor_id is required')

  // The investor must belong to the admin's fund — never trust the body's scope.
  const { data: investor } = await a.from('lp_investors').select('id, name').eq('id', lpInvestorId).eq('fund_id', fundId).maybeSingle()
  if (!investor) return fail(404, 'Investor not found in your fund')
  await ensureEntityForInvestor(admin, fundId, investor.id, investor.name)

  // lp_accounts is the LP-access whitelist the before-user-created auth hook checks, so the
  // account must exist BEFORE we invite.
  const account = await ensureLpAccount(admin, email, 'lp', input.displayName || null)
  if (!account) return fail(500, 'Could not create the LP account')

  // Link the account to the investor for this fund (idempotent) before emailing, so a send
  // failure leaves a row the admin can resend from.
  const { error: linkErr } = await a
    .from('lp_account_links')
    .insert({ lp_account_id: account.id, fund_id: fundId, lp_investor_id: lpInvestorId, created_by: actor.userId })
  if (linkErr && linkErr.code !== '23505') return dbFail(linkErr, 'lps-invites')

  // An account that is already active needs no invite; say so rather than emailing a welcome
  // link to someone who has a password.
  if (account.status === 'active') return done({ ok: true, lp_account_id: account.id, emailed: false, already_active: true })

  const result = await sendLpInvite(admin, {
    fundId, fundName: await fundNameOf(admin, fundId), email, lpAccountId: account.id, lpInvestorId, sentBy: actor.userId,
  })
  await bindAuthUser(admin, account.id, result.authUserId, account.auth_user_id)
  return done({ ok: true, lp_account_id: account.id, emailed: result.method !== null, method: result.method, warning: result.error })
}

/**
 * What an invite to this address would do, without doing it: whether an account exists (and is
 * already active, so nothing is emailed), and the email that would go out.
 */
export async function previewInvite(admin: SupabaseClient, fundId: string, email: string): Promise<{
  to: string; existing_account: { status: string } | null; would_email: boolean; subject: string; html: string
}> {
  const { data: existing } = await (admin as any).from('lp_accounts').select('status').eq('email', email).maybeSingle()
  const { subject, html } = buildInviteEmail(await fundNameOf(admin, fundId), email)
  return { to: email, existing_account: existing ? { status: existing.status } : null, would_email: existing?.status !== 'active', subject, html }
}

/**
 * Disable an LP (they and their authorized users lose the portal at the next request; they stop
 * receiving LP emails) or re-enable one.
 */
export async function setPortalAccountStatus(
  admin: SupabaseClient, fundId: string, lpAccountId: string, requested: unknown,
): Promise<Outcome<{ ok: true; status: string }>> {
  const a = admin as any
  const status = requested === 'disabled' ? 'disabled' : requested === 'active' ? 'active' : null
  if (!lpAccountId) return fail(400, 'lp_account_id is required')
  if (!status) return fail(400, "status must be 'active' or 'disabled'")

  // Only accounts linked to this fund's investors are this admin's to switch.
  const { data: link } = await a
    .from('lp_account_links').select('id, lp_accounts(id, status, auth_user_id)')
    .eq('fund_id', fundId).eq('lp_account_id', lpAccountId).limit(1).maybeSingle()
  if (!link?.lp_accounts) return fail(404, 'Account not found in your fund')

  // Re-enabling an account that never activated puts it back to 'invited', not 'active': the LP
  // still has to finish the welcome flow, and 'active' without a bound auth user is the
  // corrupted state the activate route refuses to bind by email.
  const next = status === 'active' && !link.lp_accounts.auth_user_id ? 'invited' : status
  const { error } = await a
    .from('lp_accounts')
    .update({ status: next, updated_at: new Date().toISOString() })
    .eq('id', lpAccountId)
  if (error) return dbFail(error, 'lps-invites')
  return done({ ok: true, status: next })
}

/** Revoke a direct LP-investor link (lp_account_links.id) for this fund. */
export async function unlinkPortalAccount(admin: SupabaseClient, fundId: string, linkId: string): Promise<Outcome<{ ok: true }>> {
  if (!linkId) return fail(400, 'id is required')
  // Scope the unlink to the admin's own fund.
  const { error } = await (admin as any)
    .from('lp_account_links')
    .delete()
    .eq('id', linkId)
    .eq('fund_id', fundId)
  if (error) return dbFail(error, 'lps-invites')
  return done({ ok: true })
}

/**
 * Email the welcome link again to an invited (not yet active) account linked to this fund, through
 * the same helper as the first invite. Logged to lp_deliveries either way.
 */
export async function resendInvite(
  admin: SupabaseClient, actor: PortalActor, lpAccountId: string,
): Promise<Outcome<{ ok: true; emailed: true; method: 'supabase' | 'outbound' }>> {
  const a = admin as any
  const { fundId } = actor
  if (!lpAccountId) return fail(400, 'lp_account_id is required')
  const { data: link } = await a
    .from('lp_account_links')
    .select('lp_investor_id, lp_accounts(id, email, status, auth_user_id)')
    .eq('fund_id', fundId).eq('lp_account_id', lpAccountId).limit(1).maybeSingle()
  const account = link?.lp_accounts
  if (!account) return fail(404, 'Account not found in your fund')
  if (account.status === 'active') return fail(409, 'This LP has already activated their access.')
  if (account.status === 'disabled') return fail(409, 'This account is disabled. Re-enable it first.')

  const result = await sendLpInvite(admin, {
    fundId, fundName: await fundNameOf(admin, fundId), email: account.email, lpAccountId: account.id,
    lpInvestorId: link.lp_investor_id, sentBy: actor.userId,
  })
  await bindAuthUser(admin, account.id, result.authUserId, account.auth_user_id)
  if (result.method === null) return fail(502, result.error ?? 'send failed', { ok: false, emailed: false })
  return done({ ok: true, emailed: true, method: result.method })
}

// ── Bulk ────────────────────────────────────────────────────────────────────────────────────

export interface BulkRow { name?: string; email?: string; display_name?: string; authorized_emails?: string[] }

interface Task { rowNum: number; name: string; email: string; displayName: string | null; authorizedEmails: string[]; investorId: string | null }

export interface BulkInviteSummary {
  rows: number
  matched: number
  toCreate: string[]
  lpInvites: number
  authorizedInvites: number
  errors: { row: number; message: string }[]
  failed: string[]
  committed: boolean
}

const INVITE_CONCURRENCY = 5
export const BULK_MAX_ROWS = 2000
const isEmail = (s: unknown): s is string => typeof s === 'string' && /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(s.trim())

/**
 * Bulk LP onboarding from a sheet of investors + emails (+ authorized-user emails): match investors
 * by name, create the ones that don't exist, create/link lp_accounts, and email invites.
 *
 *   commit:false → dry-run preview (no writes, no emails): what would happen.
 *   commit:true  → create investors/accounts/links + send invites, batched.
 *
 * Sending is concurrency-limited. An address that could not be emailed is listed in `failed` with
 * the reason in `errors`, and can be resent from the accounts table.
 */
export async function bulkInvite(admin: SupabaseClient, actor: PortalActor, rawRows: unknown, commit: boolean): Promise<Outcome<BulkInviteSummary>> {
  const rows: BulkRow[] = Array.isArray(rawRows) ? rawRows : []
  if (rows.length === 0) return fail(400, 'No rows provided')
  if (rows.length > BULK_MAX_ROWS) return fail(400, `Too many rows (max ${BULK_MAX_ROWS})`)

  const { data: existingInvestors } = await (admin as any)
    .from('lp_investors').select('id, name').eq('fund_id', actor.fundId)
  const byName = new Map<string, string>((existingInvestors ?? []).map((r: any) => [String(r.name).trim().toLowerCase(), r.id]))

  // ── Phase 1: validate + classify every row (no writes) ──────────────────────
  const tasks: Task[] = []
  const errors: { row: number; message: string }[] = []
  const toCreate = new Map<string, string>() // lower → original-case, for the preview list
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i] ?? {}
    const name = (r.name ?? '').trim()
    const email = (r.email ?? '').trim().toLowerCase()
    const authorizedEmails = (r.authorized_emails ?? []).map(e => String(e).trim().toLowerCase()).filter(isEmail)
    if (!name) { errors.push({ row: i + 1, message: 'Missing investor name' }); continue }
    if (!isEmail(email)) { errors.push({ row: i + 1, message: `Invalid email "${r.email ?? ''}"` }); continue }
    const investorId = byName.get(name.toLowerCase()) ?? null
    if (!investorId) toCreate.set(name.toLowerCase(), name)
    tasks.push({ rowNum: i + 1, name, email, displayName: r.display_name?.trim() || null, authorizedEmails, investorId })
  }

  const summary: BulkInviteSummary = {
    rows: rows.length,
    matched: tasks.filter(t => t.investorId).length,
    toCreate: Array.from(toCreate.values()),
    lpInvites: tasks.length,
    authorizedInvites: tasks.reduce((a, t) => a + t.authorizedEmails.length, 0),
    errors,
    failed: [],
    committed: commit,
  }
  if (!commit) return done(summary)

  // ── Phase 2a: create the new investors (sequential, deduped by name) ─────────
  for (const t of tasks) {
    if (t.investorId) continue
    const key = t.name.toLowerCase()
    let id = byName.get(key)
    if (!id) {
      const { data: inv, error } = await (admin as any)
        .from('lp_investors').insert({ fund_id: actor.fundId, name: t.name }).select('id').single()
      if (error || !inv) { summary.errors.push({ row: t.rowNum, message: `Could not create investor "${t.name}"` }); continue }
      id = inv.id as string
      byName.set(key, id)
    }
    t.investorId = id
  }

  await commitInviteTasks(admin, actor, tasks, summary)
  return done(summary)
}

/** Phase 2b: invite + account + link + authorized users, concurrency-limited. */
async function commitInviteTasks(admin: SupabaseClient, actor: PortalActor, tasks: Task[], summary: BulkInviteSummary): Promise<void> {
  const { fundId, userId } = actor
  const fundName = await fundNameOf(admin, fundId)
  async function invite(email: string, lpAccountId: string, investorId: string, currentAuth: string | null, rowNum: number) {
    const r = await sendLpInvite(admin, { fundId, fundName, email, lpAccountId, lpInvestorId: investorId, sentBy: userId })
    await bindAuthUser(admin, lpAccountId, r.authUserId, currentAuth)
    if (r.method === null) {
      summary.failed.push(email)
      summary.errors.push({ row: rowNum, message: `Could not email ${email}: ${r.error ?? 'send failed'}` })
    }
  }

  await runPool(tasks.filter(t => t.investorId), INVITE_CONCURRENCY, async (t) => {
    // Create the lp_account first (the LP-access whitelist the hook checks), then invite.
    const account = await ensureLpAccount(admin, t.email, 'lp', t.displayName)
    if (!account) { summary.errors.push({ row: t.rowNum, message: `Could not set up ${t.email}` }); summary.failed.push(t.email); return }
    const { error: linkErr } = await (admin as any)
      .from('lp_account_links').insert({ lp_account_id: account.id, fund_id: fundId, lp_investor_id: t.investorId, created_by: userId })
    if (linkErr && linkErr.code !== '23505') summary.errors.push({ row: t.rowNum, message: `Link failed for ${t.email}` })
    await ensureEntityForInvestor(admin, fundId, t.investorId!, t.name)
    // An LP who already activated (a second investor for the same person) needs no new invite.
    if (account.status !== 'active') await invite(t.email, account.id, t.investorId!, account.auth_user_id, t.rowNum)

    for (const ae of t.authorizedEmails) {
      const aAccount = await ensureLpAccount(admin, ae, 'authorized_user', null)
      if (!aAccount) { summary.errors.push({ row: t.rowNum, message: `Could not set up authorized user ${ae}` }); summary.failed.push(ae); continue }
      const { error: auErr } = await (admin as any)
        .from('lp_authorized_users').insert({ authorized_user_account_id: aAccount.id, principal_lp_account_id: account.id, lp_investor_id: t.investorId, created_by: userId })
      if (auErr && auErr.code !== '23505') summary.errors.push({ row: t.rowNum, message: `Delegation failed for ${ae}` })
      if (aAccount.status !== 'active') await invite(ae, aAccount.id, t.investorId!, aAccount.auth_user_id, t.rowNum)
    }
  })
}

// ── Invite everyone who is missing ─────────────────────────────────────────────────────────

export interface MissingInviteCandidate {
  lp_investor_id: string
  investor: string
  email: string
  /** Where the address came from: the investor's relationship contact, or an entity's notice email. */
  source: 'contact_email' | 'notice_email'
}

export interface MissingInvitePlan {
  /** Investors in scope with no portal account yet and an address to invite. */
  candidates: MissingInviteCandidate[]
  /** Investors in scope with no portal account and no usable address: fix with lp_update_profile. */
  no_email: { lp_investor_id: string; investor: string; reason: string }[]
  /** Investors in scope that already have a portal account. */
  already_linked: number
}

/** LP investor ids with a position in these vehicles (lib/access/lp-scope.ts's RPCs, for an admin's chosen set). */
export async function lpInvestorIdsInVehicles(admin: SupabaseClient, vehicles: { id: string; name: string }[]): Promise<Set<string>> {
  const { data: entityIds, error } = await (admin as any).rpc('lp_entity_ids_for', { p_vehicle_ids: vehicles.map(v => v.id), p_names: vehicles.map(v => v.name) })
  if (error) throw new Error('Could not read which LPs are in those entities.')
  const ids = (entityIds as string[] | null) ?? []
  if (ids.length === 0) return new Set()
  const { data: investorIds, error: invErr } = await (admin as any).rpc('lp_investor_ids_for', { p_entity_ids: ids })
  if (invErr) throw new Error('Could not read which LPs are in those entities.')
  return new Set((investorIds as string[] | null) ?? [])
}

/**
 * Every LP investor in the fund (or in `onlyInvestorIds`, e.g. those in named vehicles) that has
 * no portal account yet, with the address an invite would go to: the investor's contact email, or
 * failing that, the notice email its entities share. Reads only.
 */
export async function planMissingInvites(
  admin: SupabaseClient, fundId: string, onlyInvestorIds: Set<string> | null,
): Promise<MissingInvitePlan> {
  const a = admin as any
  const [{ data: investors, error }, { data: entities }, { data: links }] = await Promise.all([
    a.from('lp_investors').select('id, name, contact_email').eq('fund_id', fundId).order('name'),
    a.from('lp_entities').select('investor_id, notice_email').eq('fund_id', fundId),
    a.from('lp_account_links').select('lp_investor_id').eq('fund_id', fundId),
  ])
  if (error) throw new Error('Could not read the fund\'s investors.')
  const linked = new Set(((links ?? []) as { lp_investor_id: string }[]).map(l => l.lp_investor_id))
  const noticeEmails = new Map<string, Set<string>>()
  for (const e of (entities ?? []) as { investor_id: string | null; notice_email: string | null }[]) {
    if (!e.investor_id || !isEmail(e.notice_email)) continue
    const set = noticeEmails.get(e.investor_id) ?? new Set<string>()
    set.add(e.notice_email.trim().toLowerCase())
    noticeEmails.set(e.investor_id, set)
  }

  const plan: MissingInvitePlan = { candidates: [], no_email: [], already_linked: 0 }
  for (const inv of (investors ?? []) as { id: string; name: string; contact_email: string | null }[]) {
    if (onlyInvestorIds && !onlyInvestorIds.has(inv.id)) continue
    if (linked.has(inv.id)) { plan.already_linked += 1; continue }
    const contact = isEmail(inv.contact_email) ? inv.contact_email.trim().toLowerCase() : null
    const notices = [...(noticeEmails.get(inv.id) ?? [])]
    const email = contact ?? (notices.length === 1 ? notices[0] : null)
    if (!email) {
      plan.no_email.push({
        lp_investor_id: inv.id, investor: inv.name,
        reason: notices.length > 1
          ? `No contact email, and its entities name ${notices.length} different notice emails (${notices.join(', ')}). Set the contact email.`
          : 'No contact email or notice email on file.',
      })
      continue
    }
    plan.candidates.push({ lp_investor_id: inv.id, investor: inv.name, email, source: contact ? 'contact_email' : 'notice_email' })
  }
  return plan
}

/**
 * Invite everyone `planMissingInvites` finds, through the same steps as a bulk sheet: account,
 * link, entity, invite email. Investors are matched by id, not name, so two investors with the
 * same name each get their own link.
 */
export async function inviteMissing(admin: SupabaseClient, actor: PortalActor, plan: MissingInvitePlan): Promise<BulkInviteSummary> {
  const tasks: Task[] = plan.candidates.map((c, i) => ({
    rowNum: i + 1, name: c.investor, email: c.email, displayName: null, authorizedEmails: [], investorId: c.lp_investor_id,
  }))
  const summary: BulkInviteSummary = {
    rows: tasks.length, matched: tasks.length, toCreate: [], lpInvites: tasks.length, authorizedInvites: 0,
    errors: [], failed: [], committed: true,
  }
  await commitInviteTasks(admin, actor, tasks, summary)
  return summary
}

// ── Authorized users ───────────────────────────────────────────────────────────────────────

/** The fund's investor ids: the delegation table has no fund_id, so investors are the tenant boundary. */
export async function fundInvestorIds(admin: SupabaseClient, fundId: string): Promise<string[]> {
  const { data: investors } = await (admin as any).from('lp_investors').select('id').eq('fund_id', fundId)
  return (investors ?? []).map((r: any) => r.id as string)
}

/** Authorized users across this fund's investors, newest first. */
export async function listAuthorizedUsers(admin: SupabaseClient, fundId: string, investorIds?: string[]): Promise<Outcome<any[]>> {
  const ids = investorIds ?? await fundInvestorIds(admin, fundId)
  if (ids.length === 0) return done([])
  const { data, error } = await (admin as any)
    .from('lp_authorized_users')
    .select('id, lp_investor_id, created_at, lp_investors(name), lp_accounts!lp_authorized_users_authorized_user_account_id_fkey(email, display_name, status)')
    .in('lp_investor_id', ids)
    .order('created_at', { ascending: false })
  if (error) return dbFail(error, 'lps-authorized-users')
  return done(data ?? [])
}

/**
 * Grant an authorized user (e.g. an LP's advisor) delegated, read-only portal access to one
 * investor, acting for that investor's primary LP, and invite them.
 */
export async function addAuthorizedUser(
  admin: SupabaseClient, actor: PortalActor, input: InviteInput, investorIds?: string[],
): Promise<Outcome<{ ok: true; emailed: false; already_active: true } | { ok: true; emailed: boolean; method: 'supabase' | 'outbound' | null; warning: string | null }>> {
  const { fundId, userId } = actor
  const { email, lpInvestorId } = input
  const ids = investorIds ?? await fundInvestorIds(admin, fundId)
  if (!email || !email.includes('@')) return fail(400, 'A valid email is required')
  if (!ids.includes(lpInvestorId)) return fail(404, 'Investor not found in your fund')

  // The investor must have a primary LP account for an authorized user to act for.
  const { data: links } = await (admin as any)
    .from('lp_account_links')
    .select('lp_account_id, lp_accounts(id, kind)')
    .eq('fund_id', fundId)
    .eq('lp_investor_id', lpInvestorId)
  const principal = (links ?? []).find((l: any) => l.lp_accounts?.kind === 'lp')
  if (!principal) return fail(409, "Invite this investor's LP before adding an authorized user.")

  // lp_accounts is the LP-access whitelist the auth hook checks, so the account must exist BEFORE
  // we invite. Reuses an existing account for this email: the same login may be an LP for some
  // investors and an authorized user for others; the delegation row is what grants access.
  const account = await ensureLpAccount(admin, email, 'authorized_user', input.displayName || null)
  if (!account) return fail(500, 'Could not create the account')

  const { error: linkErr } = await (admin as any)
    .from('lp_authorized_users')
    .insert({
      authorized_user_account_id: account.id,
      principal_lp_account_id: principal.lp_account_id,
      lp_investor_id: lpInvestorId,
      created_by: userId,
    })
  if (linkErr && linkErr.code !== '23505') return dbFail(linkErr, 'lps-authorized-users')

  // Someone who already has portal access needs no invite; the delegation row alone grants it.
  if (account.status === 'active') return done({ ok: true, emailed: false, already_active: true })

  const result = await sendLpInvite(admin, {
    fundId, fundName: await fundNameOf(admin, fundId), email, lpAccountId: account.id, lpInvestorId, sentBy: userId,
  })
  await bindAuthUser(admin, account.id, result.authUserId, account.auth_user_id)
  return done({ ok: true, emailed: result.method !== null, method: result.method, warning: result.error })
}

/** Revoke a delegation row, scoped to this fund's investors. */
export async function removeAuthorizedUser(admin: SupabaseClient, fundId: string, id: string, investorIds?: string[]): Promise<Outcome<{ ok: true }>> {
  if (!id) return fail(400, 'id is required')
  const ids = investorIds ?? await fundInvestorIds(admin, fundId)
  const { error } = await (admin as any)
    .from('lp_authorized_users')
    .delete()
    .eq('id', id)
    .in('lp_investor_id', ids.length ? ids : ['00000000-0000-0000-0000-000000000000'])
  if (error) return dbFail(error, 'lps-authorized-users')
  return done({ ok: true })
}

// ── The two portal switches ────────────────────────────────────────────────────────────────

export interface PortalSwitches {
  lpPortalEnabled?: unknown
  lpAgentEnabled?: unknown
}

/**
 * The fund_settings columns the LP portal switch and the investor connector switch write. The
 * Settings route and lp_portal_settings both build their update here.
 *
 *   lp_portal_enabled: the LP portal itself.
 *   lp_agent_enabled:  whether investors may connect an assistant to their own portal
 *                      (app/api/portal/mcp). Inert unless the portal is on too; checked live.
 */
export function portalSwitchUpdates(input: PortalSwitches): Record<string, boolean> {
  const out: Record<string, boolean> = {}
  if (input.lpPortalEnabled !== undefined) out.lp_portal_enabled = !!input.lpPortalEnabled
  if (input.lpAgentEnabled !== undefined) out.lp_agent_enabled = !!input.lpAgentEnabled
  return out
}

/** Apply the switches and return both as they now stand. */
export async function setPortalSwitches(
  admin: SupabaseClient, actor: PortalActor, input: PortalSwitches,
): Promise<{ lpPortalEnabled: boolean; lpAgentEnabled: boolean; changed: string[] }> {
  const updates = portalSwitchUpdates(input)
  const changed = Object.keys(updates)
  if (changed.length) {
    const { error } = await (admin as any).from('fund_settings').update(updates).eq('fund_id', actor.fundId)
    if (error) throw new Error('Could not save the portal settings.')
    logActivity(admin, actor.fundId, actor.userId, 'settings.update', { fields: changed })
    expireTag('fund-data')
    expireTag('fund-settings')
  }
  const { data } = await (admin as any).from('fund_settings').select('lp_portal_enabled, lp_agent_enabled').eq('fund_id', actor.fundId).maybeSingle()
  return { lpPortalEnabled: !!data?.lp_portal_enabled, lpAgentEnabled: !!data?.lp_agent_enabled, changed }
}
