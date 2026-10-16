// Email to LPs: an announcement (a plain message to chosen LPs), and a portal item (a snapshot,
// letter or uploaded document) sent to the LPs it is shared with. Shared by app/api/lps/announce,
// app/api/lps/send and the lp_announce / lp_send_item agent tools (lib/agent/lp-portal-tools.ts).
//
// Both have a preview that returns the exact addresses (To, and the authorized users Cc'd) and the
// rendered email without sending: the review step before anything goes out.
//
// Rendering a statement or letter as a PDF attachment launches headless Chromium, which only some
// routes ship (lib/pdf-routes.mjs). So this module never imports the PDF renderer: the caller passes
// it in as `renderers`. The send route renders in-process; lp_send_item, whose function ships no
// Chromium, passes renderers that fetch the same PDF from a route that does (lib/agent/remote-pdf.ts).
// A caller with none can still send links and uploaded documents.

import { randomUUID } from 'node:crypto'
import type { SupabaseClient } from '@supabase/supabase-js'
import { getOutboundConfig, sendOutboundEmail, type EmailAttachment } from '@/lib/email'
import { resolveLpRecipients, type LpRecipientGroup } from '@/lib/lp-recipients'
import { buildLpEmailHtml, siteUrl } from '@/lib/lp-email'
import { logDelivery } from '@/lib/lp-deliveries'
import { runPool } from '@/lib/async-pool'
import { loadLpScope, lpVisible } from '@/lib/access/lp-scope'
import { done, fail, type Outcome } from '@/lib/service-outcome'

/** Who is sending: their fund, and their role (an announcement is scoped to the LPs they can see). */
export interface OutreachActor {
  fundId: string
  userId: string
  role: string
}

const recipientsOf = (groups: LpRecipientGroup[]) =>
  groups.map(g => ({ to: g.primaryEmail, name: g.primaryName, cc: g.ccEmails, investorCount: g.investorIds.length }))

// ── Announcements ──────────────────────────────────────────────────────────────────────────

export interface AnnouncePreview {
  preview: true
  subject: string
  html: string
  recipients: { to: string; name: string | null; cc: string[]; investorCount: number }[]
  /** Investors selected but with nobody to email. */
  unreachable: number
}

export interface SendSummary {
  ok: true
  sent: number
  primaryRecipients: number
  ccRecipients: number
  failures: string[]
}

/**
 * An announcement: a message to chosen LPs (or all of them) with nothing attached to it.
 *
 *   { subject, body, lp_investor_ids?: string[] | 'all', preview?: boolean }
 *
 * It goes out through the same recipient resolution as every LP email (the investor's account To,
 * their authorized users Cc), is recorded as an outbound message per investor so the portal shows
 * it, and is logged per send. `preview` returns the exact addresses without sending.
 */
export async function announceToLps(
  admin: SupabaseClient, actor: OutreachActor, body: any,
): Promise<Outcome<AnnouncePreview | (SendSummary & { announcementId: string })>> {
  const a = admin as any
  const { fundId } = actor
  const subject = typeof body?.subject === 'string' ? body.subject.trim().slice(0, 200) : ''
  const text = typeof body?.body === 'string' ? body.body.trim().slice(0, 20_000) : ''
  if (!subject) return fail(400, 'A subject is required')
  if (!text) return fail(400, 'A message is required')

  let investorIds: string[]
  if (body.lp_investor_ids === 'all' || body.lp_investor_ids == null) {
    const { data: invs } = await a.from('lp_investors').select('id').eq('fund_id', fundId)
    investorIds = ((invs ?? []) as { id: string }[]).map(i => i.id)
  } else if (Array.isArray(body.lp_investor_ids)) {
    const requested = body.lp_investor_ids.filter((x: unknown): x is string => typeof x === 'string')
    const { data: invs } = await a.from('lp_investors').select('id').eq('fund_id', fundId).in('id', requested)
    investorIds = ((invs ?? []) as { id: string }[]).map(i => i.id)
  } else {
    return fail(400, 'lp_investor_ids must be a list or "all"')
  }
  // Only investors the caller can see — "all" means all of theirs.
  const lp = await loadLpScope(admin, actor)
  investorIds = investorIds.filter(id => lpVisible(lp.investorIds, id))
  if (investorIds.length === 0) return fail(400, 'No investors selected')

  const groups = await resolveLpRecipients(admin, fundId, investorIds)
  if (groups.length === 0) {
    return fail(400, 'None of the selected LPs have portal accounts yet. Invite them from LP Portal → Access.')
  }
  const { data: fund } = await a.from('funds').select('name').eq('id', fundId).maybeSingle()
  const fundName = (fund?.name as string | undefined) || 'Your fund'
  const { data: fs } = await a.from('fund_settings').select('lp_portal_enabled').eq('fund_id', fundId).maybeSingle()
  const html = buildLpEmailHtml({
    fundName, itemTitle: subject, message: text,
    link: fs?.lp_portal_enabled ? `${siteUrl()}/portal/contact` : null, linkLabel: 'Reply in your portal',
  })
  const fullSubject = `${fundName}: ${subject}`

  if (body.preview === true) {
    return done({
      preview: true, subject: fullSubject, html,
      recipients: recipientsOf(groups),
      unreachable: investorIds.length - groups.reduce((n, g) => n + g.investorIds.length, 0),
    })
  }

  const config = await getOutboundConfig(a, fundId)
  if (!config) return fail(400, 'No outbound email provider is configured for this fund.')

  const announcementId = randomUUID()
  const summary: SendSummary = { ok: true, sent: 0, primaryRecipients: groups.length, ccRecipients: groups.reduce((n, g) => n + g.ccEmails.length, 0), failures: [] }

  await runPool(groups, 3, async g => {
    // The message exists in each investor's portal whether or not the email lands.
    const rows = g.investorIds.map(investorId => ({
      fund_id: fundId, lp_account_id: g.primaryAccountId, lp_investor_id: investorId, from_email: null,
      subject, body: text, status: 'resolved', direction: 'outbound', announcement_id: announcementId, sent_by: actor.userId,
    }))
    const { data: inserted } = await a.from('lp_messages').insert(rows).select('id, lp_investor_id')
    const itemIdByInvestor = new Map<string, string>(((inserted ?? []) as any[]).map(r => [r.lp_investor_id, r.id]))
    const log = { fundId, kind: 'announcement' as const, toEmail: g.primaryEmail, ccEmails: g.ccEmails, subject: fullSubject, provider: config.provider, sentBy: actor.userId }
    try {
      const sent = await sendOutboundEmail(config, { to: g.primaryEmail, cc: g.ccEmails.length ? g.ccEmails.join(', ') : undefined, subject: fullSubject, html })
      summary.sent += 1
      for (const investorId of g.investorIds) {
        await logDelivery(a, { ...log, itemId: itemIdByInvestor.get(investorId) ?? null, lpInvestorId: investorId, providerMessageId: sent.id ?? null })
      }
    } catch (e) {
      const msg = (e as Error)?.message ?? 'send failed'
      summary.failures.push(g.primaryEmail)
      for (const investorId of g.investorIds) {
        await logDelivery(a, { ...log, itemId: itemIdByInvestor.get(investorId) ?? null, lpInvestorId: investorId, status: 'failed', error: msg })
      }
    }
  })

  return done({ ...summary, announcementId })
}

// ── A portal item, by email ────────────────────────────────────────────────────────────────

export type SendKind = 'snapshot' | 'letter' | 'document'
export type SendDelivery = 'link' | 'attachment' | 'both'
export const SEND_KINDS: SendKind[] = ['snapshot', 'letter', 'document']

/**
 * The PDF renderers an attachment needs (see the header). A renderer that cannot produce the PDF
 * should throw: a snapshot's recipient is then counted as failed and not emailed, and a letter's
 * send is refused, rather than either going out without the attachment.
 */
export interface SendPdfRenderers {
  snapshotPdf(admin: SupabaseClient, opts: { fundId: string; snapshotId: string; investorIds: string[] }): Promise<{ pdf: Buffer; fileName: string } | null>
  letterPdf(admin: SupabaseClient, opts: { fundId: string; letterId: string }): Promise<{ pdf: Buffer; fileName: string } | null>
}

/** For a caller that passes no renderers. */
export const NO_PDF_RENDERER_MESSAGE =
  'Attaching a statement or letter renders a PDF, which this caller cannot do. Send it as a secure link (delivery "link"), ' +
  'or send it with the attachment from the LP Portal page.'

// Each snapshot attachment spins up its own headless Chrome, so keep this low to avoid exhausting
// serverless memory; link-only sends are just API calls.
const SEND_CONCURRENCY = 3

const sendSiteUrl = () => process.env.NEXT_PUBLIC_SITE_URL || process.env.NEXT_PUBLIC_APP_URL || 'http://localhost:3000'

interface ResolvedItem {
  itemTitle: string
  link: string
  /** Every investor the item is shared with (fund-wide docs => all fund investors). */
  sharedInvestorIds: string[]
  docRow: { storage_path: string; mime_type: string | null; file_name: string } | null
}

/**
 * Resolve an LP item within the caller's fund and the full set of investors it's shared with.
 * Shared by the recipient list and the send, so both agree on eligibility.
 */
async function resolveSendItem(admin: SupabaseClient, fundId: string, kind: SendKind, id: string): Promise<Outcome<ResolvedItem>> {
  const a = admin as any
  const base = sendSiteUrl()
  if (kind === 'snapshot') {
    const { data: snap } = await a.from('lp_snapshots').select('id, name').eq('id', id).eq('fund_id', fundId).maybeSingle()
    if (!snap) return fail(404, 'Snapshot not found')
    const { data: shares } = await a.from('lp_snapshot_shares').select('lp_investor_id').eq('snapshot_id', id).eq('fund_id', fundId)
    return done({ itemTitle: snap.name || 'Statement', link: `${base}/portal/snapshots/${id}`, sharedInvestorIds: Array.from(new Set((shares ?? []).map((s: any) => s.lp_investor_id as string))), docRow: null })
  }
  if (kind === 'letter') {
    const { data: letter } = await a.from('lp_letters').select('id, period_label, status').eq('id', id).eq('fund_id', fundId).maybeSingle()
    if (!letter) return fail(404, 'Letter not found')
    if (letter.status === 'generating') return fail(400, 'Letter is still generating')
    const { data: shares } = await a.from('lp_letter_shares').select('lp_investor_id').eq('letter_id', id).eq('fund_id', fundId)
    return done({ itemTitle: letter.period_label || 'Letter', link: `${base}/portal/letters/${id}`, sharedInvestorIds: Array.from(new Set((shares ?? []).map((s: any) => s.lp_investor_id as string))), docRow: null })
  }
  const { data: doc } = await a.from('lp_documents').select('id, title, file_name, storage_path, mime_type, scope').eq('id', id).eq('fund_id', fundId).maybeSingle()
  if (!doc) return fail(404, 'Document not found')
  const docRow = { storage_path: doc.storage_path, mime_type: doc.mime_type, file_name: doc.file_name }
  let sharedInvestorIds: string[]
  if (doc.scope === 'fund') {
    // Fund-wide doc: every investor in the fund can see it.
    const { data: invs } = await a.from('lp_investors').select('id').eq('fund_id', fundId)
    sharedInvestorIds = (invs ?? []).map((r: any) => r.id as string)
  } else {
    const { data: shares } = await a.from('lp_document_shares').select('lp_investor_id').eq('document_id', id)
    sharedInvestorIds = Array.from(new Set((shares ?? []).map((s: any) => s.lp_investor_id as string)))
  }
  return done({ itemTitle: doc.title || doc.file_name, link: `${base}/portal/snapshots`, sharedInvestorIds, docRow })
}

const validKind = (k: unknown): k is SendKind => SEND_KINDS.includes(k as SendKind)

/** The investors an item is shared with (the valid send recipients), and whether the portal is on. */
export async function sendItemRecipients(
  admin: SupabaseClient, fundId: string, kind: unknown, id: string,
): Promise<Outcome<{ portalEnabled: boolean; itemTitle: string; investors: { id: string; name: string }[] }>> {
  const a = admin as any
  if (!validKind(kind) || !id) return fail(400, 'Invalid request')
  const resolved = await resolveSendItem(admin, fundId, kind, id)
  if (!resolved.ok) return resolved
  const { data: fs } = await a.from('fund_settings').select('lp_portal_enabled').eq('fund_id', fundId).maybeSingle()
  let investors: { id: string; name: string }[] = []
  if (resolved.value.sharedInvestorIds.length) {
    const { data: invs } = await a.from('lp_investors').select('id, name').eq('fund_id', fundId).in('id', resolved.value.sharedInvestorIds)
    investors = (invs ?? []).map((r: any) => ({ id: r.id, name: r.name }))
  }
  return done({ portalEnabled: !!fs?.lp_portal_enabled, itemTitle: resolved.value.itemTitle, investors })
}

export interface SendPreview {
  preview: true
  subject: string
  itemTitle: string
  fromName: string
  html: string
  attachment: boolean
  recipients: { to: string; name: string | null; cc: string[]; investorCount: number }[]
}

/**
 * Email an LP-portal item to selected LPs. Authorized users delegated under each LP are Cc'd
 * automatically. Recipients are restricted to investors the item is actually shared with, so we
 * never email someone a link they can't open.
 *
 *   { kind, id, lp_investor_ids: string[], subject?, message?, delivery?, preview? }
 */
export async function sendPortalItem(
  admin: SupabaseClient, actor: Pick<OutreachActor, 'fundId' | 'userId'>, body: any, renderers: SendPdfRenderers | null,
): Promise<Outcome<SendPreview | SendSummary>> {
  const a = admin as any
  const { fundId } = actor
  const kind = body?.kind
  const id = typeof body?.id === 'string' ? body.id : ''
  const delivery = (['link', 'attachment', 'both'].includes(body?.delivery) ? body.delivery : 'link') as SendDelivery
  const requested: string[] = Array.isArray(body?.lp_investor_ids)
    ? body.lp_investor_ids.filter((x: unknown): x is string => typeof x === 'string')
    : []
  const message = typeof body?.message === 'string' ? body.message : ''
  let subject = typeof body?.subject === 'string' && body.subject.trim() ? body.subject.trim() : ''
  if (!validKind(kind) || !id) return fail(400, 'Invalid request')
  if (requested.length === 0) return fail(400, 'Select at least one LP')
  const wantsAttachment = delivery === 'attachment' || delivery === 'both'
  if (wantsAttachment && kind !== 'document' && !renderers) return fail(400, NO_PDF_RENDERER_MESSAGE)

  const { data: fund } = await a.from('funds').select('name').eq('id', fundId).maybeSingle()
  const fundName = fund?.name || 'Your fund'
  const { data: fs } = await a.from('fund_settings').select('lp_portal_enabled').eq('fund_id', fundId).maybeSingle()
  const portalEnabled = !!fs?.lp_portal_enabled

  // Resolve the item (verifies fund ownership) and intersect the investors it's shared with
  // against the ones selected.
  const resolved = await resolveSendItem(admin, fundId, kind, id)
  if (!resolved.ok) return resolved
  const { itemTitle, link, docRow } = resolved.value
  const requestedSet = new Set(requested)
  const sharedInvestorIds = resolved.value.sharedInvestorIds.filter(x => requestedSet.has(x))

  if (!portalEnabled && delivery !== 'attachment') {
    return fail(400, 'The LP portal is off, so portal links won\'t work. Enable it in Settings, or send as a PDF attachment instead.')
  }
  if (sharedInvestorIds.length === 0) {
    return fail(400, 'None of the selected LPs have access to this item. Share it with them first.')
  }

  const groups = await resolveLpRecipients(admin, fundId, sharedInvestorIds)
  if (groups.length === 0) {
    return fail(400, 'The selected LPs don\'t have portal accounts yet. Invite them from Settings → LP access.')
  }

  const config = await getOutboundConfig(a, fundId)
  if (!config) return fail(400, 'No outbound email provider is configured for this fund.')

  if (!subject) subject = `${fundName}: ${itemTitle}`
  const emailLink = delivery === 'attachment' ? null : link
  const html = buildLpEmailHtml({ fundName, message, link: emailLink, itemTitle })

  // Preview: exactly who would be emailed (To + auto-Cc addresses) and the rendered email,
  // WITHOUT sending. The review step confirmed before anything goes out.
  if (body.preview === true) {
    return done({ preview: true, subject, itemTitle, fromName: fundName, html, attachment: wantsAttachment, recipients: recipientsOf(groups) })
  }

  // Letter / document attachments are identical for everyone — build once. (Snapshot attachments
  // are built per recipient, scoped to that recipient's investors.) A failure here would otherwise
  // fail the whole batch, so report it as a clear error instead.
  let sharedAttachment: EmailAttachment | null = null
  if (wantsAttachment && (kind === 'letter' || kind === 'document')) {
    try {
      if (kind === 'letter') {
        const pdf = await renderers!.letterPdf(admin, { fundId, letterId: id })
        if (pdf) sharedAttachment = { filename: pdf.fileName, content: pdf.pdf, contentType: 'application/pdf' }
      } else if (docRow) {
        const { data: blob } = await a.storage.from('lp-documents').download(docRow.storage_path)
        if (blob) {
          const buf = Buffer.from(await blob.arrayBuffer())
          sharedAttachment = { filename: docRow.file_name, content: buf, contentType: docRow.mime_type || 'application/octet-stream' }
        }
      }
    } catch (e) {
      console.error('[lps/send] attachment build failed:', (e as Error)?.message)
    }
    if (!sharedAttachment) return fail(502, 'Could not prepare the attachment. Try again, or send a secure link instead.')
  }

  const summary: SendSummary = {
    ok: true,
    sent: 0,
    primaryRecipients: groups.length,
    ccRecipients: groups.reduce((n, g) => n + g.ccEmails.length, 0),
    failures: [],
  }

  await runPool(groups, SEND_CONCURRENCY, async (g) => {
    const log = { fundId, kind, itemId: id, toEmail: g.primaryEmail, ccEmails: g.ccEmails, subject, provider: config.provider, sentBy: actor.userId }
    try {
      const attachments: EmailAttachment[] = []
      if (wantsAttachment) {
        if (kind === 'snapshot') {
          // Snapshot PDFs are scoped to each recipient's own investor slice.
          const pdf = await renderers!.snapshotPdf(admin, { fundId, snapshotId: id, investorIds: g.investorIds })
          if (pdf) attachments.push({ filename: pdf.fileName, content: pdf.pdf, contentType: 'application/pdf' })
        } else if (sharedAttachment) {
          attachments.push(sharedAttachment)
        }
        // Attachment-only delivery with nothing to attach would be an empty email — skip it and
        // report the recipient as a failure instead.
        if (delivery === 'attachment' && attachments.length === 0) {
          summary.failures.push(g.primaryEmail)
          return
        }
      }
      const sent = await sendOutboundEmail(config, {
        to: g.primaryEmail,
        cc: g.ccEmails.length ? g.ccEmails.join(', ') : undefined,
        subject,
        html,
        attachments: attachments.length ? attachments : undefined,
      })
      summary.sent += 1
      // One log row per investor on the email, so a per-investor query finds it either way.
      for (const investorId of g.investorIds) {
        await logDelivery(a, { ...log, lpInvestorId: investorId, providerMessageId: sent.id ?? null })
      }
    } catch (e) {
      summary.failures.push(g.primaryEmail)
      console.error(`[lps/send] failed for ${g.primaryEmail}:`, (e as Error)?.message)
      for (const investorId of g.investorIds) {
        await logDelivery(a, { ...log, lpInvestorId: investorId, status: 'failed', error: (e as Error)?.message ?? 'send failed' })
      }
    }
  })

  return done(summary)
}
