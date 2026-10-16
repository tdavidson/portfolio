// Handlers for the LP portal and outreach tools (lp-portal-tools-manifest.ts). Each resolves names
// to ids, then calls the function the web route calls: lib/lps/portal-access.ts (accounts, invites,
// authorized users, the portal switches), lib/lps/outreach.ts (announcements, sending an item) and
// lib/accounting/proposed-calls.ts (proposed capital calls).
//
// The portal tools are admin-only, as their routes are. For writes the dispatcher enforces it
// (ADMIN_ONLY_TOOLS: a member's chat call is staged for an admin, a member's key refused); the
// handler checks again, because a read or a preview runs directly from any chat, and because an
// approved staged call runs here as the approver.
//
// This function ships no headless Chromium (lib/pdf-routes.mjs), so the two things that render a PDF
// ask a route that does, with a signed short-lived token, and that route re-checks the member's live
// access: a statement or letter attached to an email (lib/agent/remote-pdf.ts, through
// app/api/agent/reports/[token]) and the notices an approved proposed call publishes
// (lib/agent/notice-publish-link.ts, through app/api/agent/call-notices/publish).

import type { SupabaseClient } from '@supabase/supabase-js'
import type { AgentToolContext, AgentToolHandler } from '@/lib/accounting/agent-tools'
import { adminOnlyMessage } from '@/lib/access/admin-only'
import { resolveVehicle } from '@/lib/accounting/vehicle-resolver'
import { vehicleIdByName } from '@/lib/accounting/vehicle-id'
import {
  approveProposedCall, discardProposedCall, getProposedCall, listProposedCalls, proposeCapitalCall, reviseProposedCall,
  type ProposedCallStatus,
} from '@/lib/accounting/proposed-calls'
import { proposedCallRequestFrom } from '@/lib/accounting/proposed-call-input'
import { unwrap } from '@/lib/service-outcome'
import {
  addAuthorizedUser, bulkInvite, inviteLp, inviteMissing, listAuthorizedUsers, listPortalAccounts, lpInvestorIdsInVehicles,
  planMissingInvites, previewInvite, removeAuthorizedUser, resendInvite, setPortalAccountStatus, setPortalSwitches,
  unlinkPortalAccount, type PortalActor,
} from '@/lib/lps/portal-access'
import { announceToLps, sendItemRecipients, sendPortalItem } from '@/lib/lps/outreach'
import { attachmentNameFor } from '@/lib/lps/attachment-names'
import { resolveInvestor } from './lp-record-tools'
import { remotePdfRenderers } from './remote-pdf'
import { publishNoticesRemotely } from './notice-publish-link'

const str = (v: unknown) => (typeof v === 'string' ? v.trim() : '')

/** The admin behind this call, or a refusal in the words every surface uses. */
function requireAdmin(ctx: AgentToolContext, label: string): PortalActor {
  if (ctx.access.role !== 'admin') throw new Error(adminOnlyMessage(label))
  if (!ctx.userId) throw new Error('This needs a person behind the credential.')
  return { fundId: ctx.fundId, userId: ctx.userId }
}

/** One portal account linked to this fund, by lp_account_id or email. */
async function resolveAccount(admin: SupabaseClient, fundId: string, ref: unknown): Promise<{ id: string; email: string }> {
  const needle = str(ref)
  if (!needle) throw new Error('Name the portal account (its id or email).')
  const { data } = await (admin as any)
    .from('lp_account_links').select('lp_account_id, lp_accounts(id, email)').eq('fund_id', fundId)
  const accounts = ((data ?? []) as any[]).map(l => l.lp_accounts).filter(Boolean) as { id: string; email: string }[]
  const hit = accounts.find(a => a.id === needle) ?? accounts.find(a => String(a.email).toLowerCase() === needle.toLowerCase())
  if (!hit) throw new Error(`No portal account "${needle}" in this fund. lp_portal_accounts lists them.`)
  return hit
}

async function investorIds(admin: SupabaseClient, fundId: string, refs: unknown): Promise<string[]> {
  if (!Array.isArray(refs)) throw new Error('investors must be a list of investor ids or names.')
  const out: string[] = []
  for (const r of refs) out.push((await resolveInvestor(admin, fundId, String(r))).id)
  return Array.from(new Set(out))
}

const NEXT_AFTER_PREVIEW =
  'Nothing was sent or changed. Show the person exactly this (recipients and the email), and only after they explicitly say yes, ' +
  'call the tool again without preview.'

async function proposalGroup(ctx: AgentToolContext, input: any): Promise<string> {
  return resolveVehicle(ctx.admin, ctx.fundId, str(input?.vehicle) || undefined, { access: ctx.access })
}

export const LP_PORTAL_HANDLERS: Record<string, AgentToolHandler> = {
  // ── Accounts and invites ─────────────────────────────────────────────────────────────────
  lp_portal_accounts: async (ctx) => {
    requireAdmin(ctx, 'see LP portal accounts')
    const rows = unwrap(await listPortalAccounts(ctx.admin, ctx.fundId))
    const { data: fs } = await (ctx.admin as any).from('fund_settings').select('lp_portal_enabled, lp_agent_enabled').eq('fund_id', ctx.fundId).maybeSingle()
    return {
      portal_enabled: !!fs?.lp_portal_enabled,
      investor_connector_enabled: !!fs?.lp_agent_enabled,
      accounts: rows.map(r => ({
        link_id: r.id,
        lp_account_id: r.lp_accounts?.id ?? null,
        investor: r.lp_investors?.name ?? null,
        lp_investor_id: r.lp_investor_id,
        email: r.lp_accounts?.email ?? null,
        display_name: r.lp_accounts?.display_name ?? null,
        kind: r.lp_accounts?.kind ?? null,
        status: r.lp_accounts?.status ?? null,
        last_login_at: r.last_login_at,
        last_invite_at: r.last_invite_at,
        last_invite_status: r.last_invite_status,
        last_invite_error: r.last_invite_error,
      })),
    }
  },

  lp_portal_invite: async (ctx, input) => {
    const actor = requireAdmin(ctx, 'invite an LP to the portal')
    const investor = await resolveInvestor(ctx.admin, ctx.fundId, str(input?.investor))
    const email = str(input?.email).toLowerCase()
    if (input?.preview === true) {
      if (!email.includes('@')) throw new Error('A valid email is required')
      return { preview: true, investor: investor.name, ...(await previewInvite(ctx.admin, ctx.fundId, email)), next: NEXT_AFTER_PREVIEW }
    }
    const out = unwrap(await inviteLp(ctx.admin, actor, { lpInvestorId: investor.id, email, displayName: str(input?.display_name) }))
    return { investor: investor.name, email, ...out }
  },

  lp_portal_invite_bulk: async (ctx, input) => {
    const actor = requireAdmin(ctx, 'invite LPs to the portal')
    const commit = input?.commit === true
    const mode = input?.mode ?? (Array.isArray(input?.rows) ? 'rows' : 'missing')
    const { data: fund } = await (ctx.admin as any).from('funds').select('name').eq('id', ctx.fundId).maybeSingle()
    // The email each new account gets, as the person approving should see it (for the first address).
    const sample = async (email: string | undefined) =>
      email ? (({ subject, html }) => ({ subject, html, sample_to: email }))(await previewInvite(ctx.admin, ctx.fundId, email)) : null

    if (mode === 'rows') {
      const summary = unwrap(await bulkInvite(ctx.admin, actor, input?.rows, commit))
      if (commit) return summary
      const first = (input.rows as any[]).find(r => typeof r?.email === 'string' && r.email.includes('@'))?.email?.trim().toLowerCase()
      return { ...summary, invite_email: await sample(first), next: commitNext(fund?.name) }
    }
    if (mode !== 'missing') throw new Error('mode must be "missing" or "rows".')

    let only: Set<string> | null = null
    const vehicles: string[] = []
    if (Array.isArray(input?.vehicles) && input.vehicles.length) {
      const resolved: { id: string; name: string }[] = []
      for (const v of input.vehicles) {
        const name = await resolveVehicle(ctx.admin, ctx.fundId, String(v), { access: ctx.access })
        const id = await vehicleIdByName(ctx.admin, ctx.fundId, name)
        if (!id) throw new Error(`Unknown vehicle "${v}"`)
        resolved.push({ id, name })
        vehicles.push(name)
      }
      only = await lpInvestorIdsInVehicles(ctx.admin, resolved)
    }
    const plan = await planMissingInvites(ctx.admin, ctx.fundId, only)
    const scope = vehicles.length ? `LPs in ${vehicles.join(', ')}` : 'every LP in the fund'
    if (!commit) {
      return {
        preview: true,
        scope,
        would_invite: plan.candidates.map(c => ({ investor: c.investor, email: c.email, from: c.source })),
        not_invited_no_email: plan.no_email.map(n => ({ investor: n.investor, reason: n.reason })),
        already_have_portal_account: plan.already_linked,
        invite_email: await sample(plan.candidates[0]?.email),
        next: plan.candidates.length ? commitNext(fund?.name) : 'There is no one to invite.',
      }
    }
    if (plan.candidates.length === 0) return { committed: true, scope, invited: [], note: 'There was no one to invite.' }
    const summary = await inviteMissing(ctx.admin, actor, plan)
    return {
      ...summary,
      scope,
      invited: plan.candidates.filter(c => !summary.failed.includes(c.email)).map(c => ({ investor: c.investor, email: c.email })),
      not_invited_no_email: plan.no_email.map(n => n.investor),
    }
  },

  lp_portal_account_status: async (ctx, input) => {
    requireAdmin(ctx, 'change an LP\'s portal access')
    const account = await resolveAccount(ctx.admin, ctx.fundId, input?.account)
    return { email: account.email, ...unwrap(await setPortalAccountStatus(ctx.admin, ctx.fundId, account.id, input?.status)) }
  },

  lp_portal_resend_invite: async (ctx, input) => {
    const actor = requireAdmin(ctx, 'resend an LP portal invite')
    const account = await resolveAccount(ctx.admin, ctx.fundId, input?.account)
    if (input?.preview === true) {
      return { preview: true, ...(await previewInvite(ctx.admin, ctx.fundId, account.email)), next: NEXT_AFTER_PREVIEW }
    }
    return { email: account.email, ...unwrap(await resendInvite(ctx.admin, actor, account.id)) }
  },

  lp_portal_unlink: async (ctx, input) => {
    requireAdmin(ctx, 'remove an LP\'s portal link')
    let linkId = str(input?.link_id)
    if (!linkId) {
      if (!input?.account || !input?.investor) throw new Error('Pass link_id, or account and investor.')
      const account = await resolveAccount(ctx.admin, ctx.fundId, input.account)
      const investor = await resolveInvestor(ctx.admin, ctx.fundId, str(input.investor))
      const { data } = await (ctx.admin as any).from('lp_account_links').select('id')
        .eq('fund_id', ctx.fundId).eq('lp_account_id', account.id).eq('lp_investor_id', investor.id).maybeSingle()
      if (!data) throw new Error(`${account.email} is not linked to ${investor.name}.`)
      linkId = data.id
    }
    return { link_id: linkId, ...unwrap(await unlinkPortalAccount(ctx.admin, ctx.fundId, linkId)) }
  },

  // ── Authorized users ─────────────────────────────────────────────────────────────────────
  lp_authorized_users: async (ctx, input) => {
    requireAdmin(ctx, 'see LP authorized users')
    const only = input?.investor ? [(await resolveInvestor(ctx.admin, ctx.fundId, str(input.investor))).id] : undefined
    const rows = unwrap(await listAuthorizedUsers(ctx.admin, ctx.fundId, only))
    return {
      authorized_users: rows.map((r: any) => ({
        id: r.id, investor: r.lp_investors?.name ?? null, lp_investor_id: r.lp_investor_id,
        email: r.lp_accounts?.email ?? null, display_name: r.lp_accounts?.display_name ?? null, status: r.lp_accounts?.status ?? null,
        created_at: r.created_at,
      })),
    }
  },

  lp_authorized_user_add: async (ctx, input) => {
    const actor = requireAdmin(ctx, 'grant an authorized user portal access')
    const investor = await resolveInvestor(ctx.admin, ctx.fundId, str(input?.investor))
    const email = str(input?.email).toLowerCase()
    if (input?.preview === true) {
      if (!email.includes('@')) throw new Error('A valid email is required')
      return { preview: true, investor: investor.name, ...(await previewInvite(ctx.admin, ctx.fundId, email)), next: NEXT_AFTER_PREVIEW }
    }
    const out = unwrap(await addAuthorizedUser(ctx.admin, actor, { lpInvestorId: investor.id, email, displayName: str(input?.display_name) }))
    return { investor: investor.name, email, ...out }
  },

  lp_authorized_user_remove: async (ctx, input) => {
    requireAdmin(ctx, 'revoke an authorized user')
    return unwrap(await removeAuthorizedUser(ctx.admin, ctx.fundId, str(input?.id)))
  },

  // ── Email to LPs ─────────────────────────────────────────────────────────────────────────
  lp_announce: async (ctx, input) => {
    const actor = requireAdmin(ctx, 'announce to LPs')
    const refs = input?.investors
    const lpInvestorIds = refs == null || refs === 'all' ? 'all' : await investorIds(ctx.admin, ctx.fundId, refs)
    const out = unwrap(await announceToLps(ctx.admin, { ...actor, role: ctx.access.role }, {
      subject: input?.subject, body: input?.body, lp_investor_ids: lpInvestorIds, preview: input?.preview === true,
    }))
    return 'preview' in out ? { ...out, next: NEXT_AFTER_PREVIEW } : out
  },

  lp_send_item_recipients: async (ctx, input) => {
    requireAdmin(ctx, 'send to LPs')
    return unwrap(await sendItemRecipients(ctx.admin, ctx.fundId, input?.kind, str(input?.id)))
  },

  lp_send_item: async (ctx, input) => {
    const actor = requireAdmin(ctx, 'send to LPs')
    let ids: string[]
    if (input?.investors == null) {
      ids = unwrap(await sendItemRecipients(ctx.admin, ctx.fundId, input?.kind, str(input?.id))).investors.map(i => i.id)
      if (ids.length === 0) throw new Error('This item is not shared with any investor yet. Share it with them first.')
    } else {
      ids = await investorIds(ctx.admin, ctx.fundId, input.investors)
    }
    // A statement or letter attachment is rendered by a Chromium-bundled route (see the header).
    const renderers = remotePdfRenderers({ userId: actor.userId, origin: ctx.origin })
    const sent = await sendPortalItem(ctx.admin, actor, {
      kind: input?.kind, id: str(input?.id), lp_investor_ids: ids, subject: input?.subject, message: input?.message,
      delivery: input?.delivery, preview: input?.preview === true,
    }, renderers)
    // A letter that could not be rendered refuses the whole send; say why, not only that it failed.
    if (!sent.ok && renderers.errors.length) throw new Error(`${sent.error} ${renderers.errors[0]}`)
    const out = unwrap(sent)
    if ('preview' in out) {
      const attachment_name = out.attachment ? await attachmentNameFor(ctx.admin, ctx.fundId, input?.kind, str(input?.id)) : null
      return { ...out, ...(attachment_name ? { attachment_name } : {}), next: NEXT_AFTER_PREVIEW }
    }
    // A recipient whose statement could not be rendered was not emailed at all (never sent without it).
    return renderers.errors.length
      ? { ...out, attachment_errors: Array.from(new Set(renderers.errors)), note: 'The recipients in failures were not emailed: their attachment could not be rendered. Nothing was sent to them without it.' }
      : out
  },

  // ── Switches ─────────────────────────────────────────────────────────────────────────────
  lp_portal_settings: async (ctx, input) => {
    const actor = requireAdmin(ctx, 'change the LP portal settings')
    const switches = {
      ...(typeof input?.portal_enabled === 'boolean' ? { lpPortalEnabled: input.portal_enabled } : {}),
      ...(typeof input?.investor_connector_enabled === 'boolean' ? { lpAgentEnabled: input.investor_connector_enabled } : {}),
    }
    if (Object.keys(switches).length === 0) throw new Error('Pass portal_enabled and/or investor_connector_enabled.')
    const out = await setPortalSwitches(ctx.admin, actor, switches)
    return {
      portal_enabled: out.lpPortalEnabled,
      investor_connector_enabled: out.lpAgentEnabled,
      changed: out.changed,
      ...(out.lpAgentEnabled && !out.lpPortalEnabled ? { note: 'The investor connector works only while the LP portal is on.' } : {}),
    }
  },

  // ── Proposed capital calls ───────────────────────────────────────────────────────────────
  lp_proposed_calls: async (ctx, input) => {
    const status = ['proposed', 'approved', 'discarded'].includes(input?.status) ? input.status as ProposedCallStatus : undefined
    const id = str(input?.id)
    if (id || str(input?.vehicle) || !ctx.access.vehicles?.all) {
      const group = await proposalGroup(ctx, input)
      if (id) return unwrap(await getProposedCall(ctx.admin, { fundId: ctx.fundId, group, userId: ctx.userId }, id))
      const vehicleId = await vehicleIdByName(ctx.admin, ctx.fundId, group)
      if (!vehicleId) return { calls: [] }
      return { calls: unwrap(await listProposedCalls(ctx.admin, ctx.fundId, [{ id: vehicleId, name: group }], status)) }
    }
    // Every vehicle, for a caller who sees them all.
    return { calls: unwrap(await listProposedCalls(ctx.admin, ctx.fundId, null, status)) }
  },

  lp_proposed_call_propose: async (ctx, input) => {
    requireAdmin(ctx, 'propose a capital call')
    const parsed = proposedCallRequestFrom(input)
    if ('error' in parsed) throw new Error(parsed.error)
    const group = await proposalGroup(ctx, input)
    return unwrap(await proposeCapitalCall(ctx.admin, { fundId: ctx.fundId, group, userId: ctx.userId }, parsed.request))
  },

  lp_proposed_call_revise: async (ctx, input) => {
    requireAdmin(ctx, 'revise a capital call')
    const parsed = proposedCallRequestFrom(input, { partial: true })
    if ('error' in parsed) throw new Error(parsed.error)
    const group = await proposalGroup(ctx, input)
    return unwrap(await reviseProposedCall(ctx.admin, { fundId: ctx.fundId, group, userId: ctx.userId }, str(input?.id), parsed.request))
  },

  lp_proposed_call_discard: async (ctx, input) => {
    requireAdmin(ctx, 'discard a capital call')
    const group = await proposalGroup(ctx, input)
    return unwrap(await discardProposedCall(ctx.admin, { fundId: ctx.fundId, group, userId: ctx.userId }, str(input?.id)))
  },

  // As the app's Approve button: issue the call, then publish each LP's notice to their portal. The
  // notices are rendered PDFs, so a Chromium-bundled route publishes them (see the header).
  lp_proposed_call_approve: async (ctx, input) => {
    const group = await proposalGroup(ctx, input)
    const id = str(input?.id)
    const approved = await approveProposedCall(ctx.admin, { fundId: ctx.fundId, group, userId: ctx.userId }, id, {
      role: ctx.access.role, acknowledge: input?.acknowledge === true,
    })
    if (!approved.ok) {
      // The checks that stopped it, so the assistant can show them rather than just the refusal.
      throw new Error(approved.extra ? `${approved.error} ${JSON.stringify(approved.extra)}` : approved.error)
    }
    const callId = approved.value.capitalCallId
    try {
      const notices = await publishNoticesRemotely(
        { mode: 'proposed_call', fundId: ctx.fundId, userId: ctx.userId!, vehicle: group, callId, proposedCallId: id },
        { origin: ctx.origin },
      )
      return {
        ...approved.value,
        vehicle: group,
        noticesPublished: notices.published,
        noticesReused: notices.reused,
        publishErrors: notices.errors,
        ...(notices.errors.length
          ? { next: `The call is issued and ${notices.published + notices.reused} notices are in the LPs' portals, but some could not be published: ` +
              'tell the person each error. Calling lp_proposed_call_approve again with the same id retries them; notices already published are reused.' }
          : {}),
      }
    } catch (e) {
      // The call IS issued: this must not read as a failed approval, or it gets approved twice.
      return {
        ...approved.value,
        vehicle: group,
        noticesPublished: 0,
        publishFailed: (e as Error)?.message ?? 'The notices could not be published.',
        next: `The call is issued (capitalCallId ${callId}), but its notices were NOT published to the LPs' portals: ` +
          `${(e as Error)?.message ?? 'publishing failed'} Tell the person exactly that. To retry, call lp_proposed_call_approve again ` +
          'with the same id (it does not issue the call twice; it publishes the notices), or use preview_call_notices then publish_call_notices.',
      }
    }
  },
}

function commitNext(fundName: string | null | undefined): string {
  return 'Nothing was created or emailed. Show the person who would be invited and the invite email' +
    `${fundName ? ` (from ${fundName})` : ''}, and only after they explicitly say yes call this again with commit: true.`
}
