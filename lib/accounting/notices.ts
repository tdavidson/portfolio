// Notices: from a register row to a PDF in each partner's portal, and from there to their inbox.
//
// Two steps, deliberately. PUBLISHING renders one notice per partner from the frozen register line
// and files it in their portal as a document; it is idempotent, because the line remembers the
// document it produced and a second publish reuses it rather than filing a copy. EMAILING sends
// that document (as a portal link, an attachment, or both) to the partner's account and the
// authorized users under it, and writes a delivery-log row per send. A GP can do either alone or
// both in one action; the route composes them.
//
// Every figure comes from the REGISTER, never recomputed: the 1300 receivable and the 2300 payable
// both decay as money moves, so deriving a notice from the ledger would restate what a partner was
// told every time somebody paid.

import type { SupabaseClient } from '@supabase/supabase-js'
import { runPool } from '@/lib/lp-report-pdf'
import { generateNoticePdf, generateReceiptPdf } from './notice-pdf'
import { getOutboundConfig, sendOutboundEmail, type EmailAttachment } from '@/lib/email'
import { buildLpEmailHtml, siteUrl } from '@/lib/lp-email'
import { logDelivery, listDeliveries, lastSentByItem, type DeliveryKind } from '@/lib/lp-deliveries'
import { roundCents } from './ledger'
import { lpCapitalSummary, listCapitalCalls } from './capital-calls'
import { resolveLpRecipients } from '@/lib/lp-recipients'
import { displayFontOf } from '@/lib/theme'
import { documentLetterhead, contactBlock } from '@/lib/vehicle-letterhead'
import {
  noticeDataFor, noticeTitle, type NoticeRegister, type PublishContext,
} from './notice-register'

// The register and the preview live in notice-register.ts (no Chromium); re-exported for callers.
export {
  loadNoticeRegister, noticeDataFor, noticeTitle, previewNoticeRecipients, purposeRows,
  type NoticeForLine, type NoticeLine, type NoticeRecipientPreview, type NoticeRegister, type PublishContext,
} from './notice-register'

export interface PublishedNotice {
  lineId: string
  lpEntityId: string
  name: string
  amount: number
  documentId: string
  investorId: string | null
  /** True when the document already existed and was reused. */
  reused: boolean
}

/**
 * One notice per selected partner, filed in their portal. Idempotent: a line that already has a
 * notice document keeps it unless `regenerate` is set.
 */
export async function publishNotices(
  admin: SupabaseClient,
  ctx: PublishContext,
  reg: NoticeRegister,
  opts: { lpEntityIds?: string[]; regenerate?: boolean } = {},
): Promise<{ published: PublishedNotice[]; errors: string[] }> {
  const { fundId, userId } = ctx
  const requested = opts.lpEntityIds ?? []
  const targets = requested.length > 0 ? reg.lines.filter(l => requested.includes(l.lpEntityId)) : reg.lines
  if (targets.length === 0) return { published: [], errors: ['No partners selected'] }

  const notices = await noticeDataFor(admin, ctx, reg, targets)
  const title = noticeTitle(reg)
  const table = reg.kind === 'capital_call' ? 'capital_call_lines' : 'distribution_lines'
  const published: PublishedNotice[] = []
  const errors: string[] = []

  await runPool(notices, 3, async ({ line, partnerName, investorId, data }) => {
    try {
      // Reuse the document the line already produced. The partner's portal then holds ONE
      // notice for this call, however many times the GP presses the button.
      if (line.noticeDocumentId && !opts.regenerate) {
        const { data: existing } = await admin.from('lp_documents' as any).select('id').eq('id', line.noticeDocumentId).eq('fund_id', fundId).maybeSingle()
        if (existing) {
          if (investorId) await ensureShare(admin, fundId, line.noticeDocumentId, investorId)
          published.push({ lineId: line.id, lpEntityId: line.lpEntityId, name: partnerName, amount: line.amount, documentId: line.noticeDocumentId, investorId, reused: true })
          return
        }
      }

      const pdf = await generateNoticePdf(data)

      const fileName = `${title.replace(/[^a-zA-Z0-9 ._-]/g, '_')} — ${partnerName.replace(/[^a-zA-Z0-9 ._-]/g, '_')}.pdf`
      const storagePath = `${fundId}/${Date.now()}_${fileName}`
      const { error: upErr } = await admin.storage
        .from('lp-documents')
        .upload(storagePath, pdf, { contentType: 'application/pdf', upsert: false })
      if (upErr) { errors.push(`${partnerName}: upload failed — ${upErr.message}`); return }

      const { data: doc, error: docErr } = await admin
        .from('lp_documents' as any)
        .insert({
          fund_id: fundId,
          title,
          file_name: fileName,
          storage_path: storagePath,
          mime_type: 'application/pdf',
          size_bytes: pdf.length,
          scope: 'investor', // a notice states one partner's amount
          vehicle: ctx.group,
          category: reg.kind === 'capital_call' ? 'Capital Call Notice' : 'Distribution Notice',
          doc_date: reg.noticeDate,
          uploaded_by: userId,
        })
        .select('id')
        .single()
      if (docErr || !doc) { errors.push(`${partnerName}: ${docErr?.message ?? 'insert failed'}`); return }
      const documentId = (doc as any).id as string

      // Every line the notice covers: a GP's LP and carry lines share one document.
      await admin.from(table as any).update({ notice_document_id: documentId }).in('id', line.lineIds ?? [line.id]).eq('fund_id', fundId)

      if (investorId) {
        await ensureShare(admin, fundId, documentId, investorId)
      } else {
        // Stored, but nobody can open it until the entity is linked to an LP investor. Report
        // it rather than counting a silent success.
        errors.push(`${partnerName}: generated, but not shared — this entity has no linked LP investor.`)
      }
      published.push({ lineId: line.id, lpEntityId: line.lpEntityId, name: partnerName, amount: line.amount, documentId, investorId, reused: false })
    } catch (e: any) {
      errors.push(`${partnerName}: ${e?.message ?? 'could not generate the notice'}`)
    }
  })

  return { published, errors }
}

async function ensureShare(admin: SupabaseClient, fundId: string, documentId: string, investorId: string): Promise<void> {
  const { data } = await admin.from('lp_document_shares' as any).select('id').eq('document_id', documentId).eq('lp_investor_id', investorId).maybeSingle()
  if (data) return
  await admin.from('lp_document_shares' as any).insert({ document_id: documentId, lp_investor_id: investorId, fund_id: fundId })
}

export type NoticeDelivery = 'link' | 'attachment' | 'both'

export interface NoticeEmailOptions {
  subject?: string | null
  message?: string | null
  delivery: NoticeDelivery
}

export interface NoticeSendResult {
  sent: number
  failures: string[]
  skipped: string[]
}

/** A stored, shared document to email to one partner, with the facts its email states. */
export interface DocumentToEmail {
  /** The register line the document belongs to — what the delivery log records. */
  lineId: string
  lpEntityId: string
  name: string
  investorId: string | null
  documentId: string
  facts: { label: string; value: string }[]
}

/**
 * Email each partner their document — as a portal link, an attachment or both — logging every
 * send under `logKind`. Shared by notices and receipts.
 */
export async function emailDocuments(
  admin: SupabaseClient,
  ctx: PublishContext,
  items: DocumentToEmail[],
  opts: NoticeEmailOptions & { logKind: DeliveryKind; title: string; linkPath: string; linkLabel: string },
): Promise<NoticeSendResult | { error: string }> {
  const { fundId, userId } = ctx
  const [fs, fundRes, config] = await Promise.all([
    (admin as any).from('fund_settings').select('lp_portal_enabled').eq('fund_id', fundId).maybeSingle(),
    admin.from('funds' as any).select('name').eq('id', fundId).maybeSingle(),
    getOutboundConfig(admin, fundId),
  ])
  const portalEnabled = !!(fs as any)?.data?.lp_portal_enabled
  if (!portalEnabled && opts.delivery !== 'attachment') {
    return { error: 'The LP portal is off, so portal links won\u2019t work. Enable it in Settings, or send as a PDF attachment instead.' }
  }
  if (!config) return { error: 'No outbound email provider is configured for this fund.' }

  const fundName = (await documentLetterhead(admin, fundId, (fundRes as any).data, [ctx.group])).name || 'Your fund'
  const subject = opts.subject?.trim() || `${fundName}: ${opts.title}`
  const message = opts.message ?? ''
  const link = opts.delivery === 'attachment' ? null : `${siteUrl()}${opts.linkPath}`
  const wantsAttachment = opts.delivery !== 'link'

  const investorIds = Array.from(new Set(items.map(p => p.investorId).filter(Boolean) as string[]))
  const groups = await resolveLpRecipients(admin, fundId, investorIds)
  const groupByInvestor = new Map<string, { to: string; cc: string[] }>()
  for (const g of groups) for (const inv of g.investorIds) groupByInvestor.set(inv, { to: g.primaryEmail, cc: g.ccEmails })

  const result: NoticeSendResult = { sent: 0, failures: [], skipped: [] }

  await runPool(items, 3, async p => {
    const g = p.investorId ? groupByInvestor.get(p.investorId) : undefined
    if (!g) { result.skipped.push(`${p.name}: no portal account`); return }

    const html = buildLpEmailHtml({ fundName, itemTitle: opts.title, message, link, linkLabel: opts.linkLabel, facts: p.facts })

    const attachments: EmailAttachment[] = []
    if (wantsAttachment) {
      const { data: doc } = await admin.from('lp_documents' as any).select('storage_path, file_name').eq('id', p.documentId).maybeSingle()
      const path = (doc as any)?.storage_path as string | undefined
      const blob = path ? (await admin.storage.from('lp-documents').download(path)).data : null
      if (!blob) { result.failures.push(`${p.name}: could not read the PDF`); return }
      attachments.push({ filename: (doc as any).file_name, content: Buffer.from(await blob.arrayBuffer()), contentType: 'application/pdf' })
    }

    const log = (extra: { providerMessageId?: string | null; status?: 'sent' | 'failed'; error?: string }) => logDelivery(admin, {
      fundId, kind: opts.logKind, itemId: p.lineId, lpInvestorId: p.investorId, lpEntityId: p.lpEntityId,
      toEmail: g.to, ccEmails: g.cc, subject, provider: config.provider, sentBy: userId, ...extra,
    })
    try {
      const sent = await sendOutboundEmail(config, {
        to: g.to,
        cc: g.cc.length ? g.cc.join(', ') : undefined,
        subject,
        html,
        attachments: attachments.length ? attachments : undefined,
      })
      result.sent += 1
      await log({ providerMessageId: sent.id ?? null })
    } catch (e) {
      const msg = (e as Error)?.message ?? 'send failed'
      result.failures.push(`${p.name}: ${msg}`)
      await log({ status: 'failed', error: msg })
    }
  })

  return result
}

/** Email each published notice to its partner, logging every send. */
export async function emailNotices(
  admin: SupabaseClient,
  ctx: PublishContext,
  reg: NoticeRegister,
  published: PublishedNotice[],
  opts: NoticeEmailOptions,
): Promise<NoticeSendResult | { error: string }> {
  const { data: settings } = await admin.from('fund_settings' as any).select('currency').eq('fund_id', ctx.fundId).maybeSingle()
  const fmt = moneyFmt(((settings as any)?.currency as string | undefined) || 'USD')
  return emailDocuments(admin, ctx, published.map(p => ({
    lineId: p.lineId, lpEntityId: p.lpEntityId, name: p.name, investorId: p.investorId, documentId: p.documentId,
    facts: [
      { label: reg.kind === 'capital_call' ? 'Amount due' : 'Amount payable', value: fmt(p.amount) },
      ...(reg.dueDate ? [{ label: 'Due', value: reg.dueDate }] : []),
    ],
  })), { ...opts, logKind: 'notice', title: noticeTitle(reg), linkPath: '/portal/notices', linkLabel: 'View the notice' })
}

function moneyFmt(currency: string) {
  return (v: number) => `${currency} ${v.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
}

// ---------------------------------------------------------------------------------------------
// Receipts — the mirror of the call notice, sent once the money has arrived.
// ---------------------------------------------------------------------------------------------

export interface ReceiptCandidate {
  lineId: string
  lpEntityId: string
  name: string
  /** What has arrived against the line, and when the latest of it arrived. */
  received: number
  receivedOn: string | null
  settlementReview?: string
  outstanding: number
  /** The last receipt emailed for this line, if any. */
  lastReceiptAt: string | null
  /** True when money arrived after the last receipt — the default selection. */
  due: boolean
  investorId: string | null
}

/**
 * Which lines on a call have money against them, and which of those have not yet been receipted
 * for it. Nothing is written.
 */
export async function receiptCandidates(
  admin: SupabaseClient,
  fundId: string,
  group: string,
  callId: string,
): Promise<{ call: { id: string; date: string; number: number | null; description: string | null } ; candidates: ReceiptCandidate[] } | { error: string; status: number }> {
  const calls = await listCapitalCalls(admin, fundId, group)
  const call = calls.find(c => c.id === callId)
  if (!call) return { error: 'Capital call not found on this vehicle', status: 404 }
  const funded = call.lines.filter(l => l.settled > 0.005)
  const [sentBefore, entityRows] = await Promise.all([
    listDeliveries(admin, fundId, 'receipt', funded.map(l => l.id)),
    admin.from('lp_entities' as any).select('id, investor_id').eq('fund_id', fundId).in('id', funded.map(l => l.lpEntityId)),
  ])
  const last = lastSentByItem(sentBefore)
  const investorByEntity = new Map<string, string | null>(
    (((entityRows as any).data as any[]) ?? []).map(e => [e.id as string, (e.investor_id ?? null) as string | null])
  )
  return {
    call: { id: call.id, date: call.callDate, number: call.callNumber, description: call.description },
    candidates: funded.map(l => {
      const lastAt = last.get(l.id)?.sentAt ?? null
      // A receipt is due when money arrived after the last one went out. The funding date is a
      // day; the delivery a timestamp — compare on the day, so a receipt sent the day of the wire
      // counts as covering it.
      const due = !lastAt || (!!l.lastSettlementOn && l.lastSettlementOn > lastAt.slice(0, 10))
      return {
        lineId: l.id, lpEntityId: l.lpEntityId, name: l.name,
        received: l.settled, receivedOn: l.lastSettlementOn, outstanding: l.outstanding,
        settlementReview: l.settlementReview, lastReceiptAt: lastAt, due: due && !l.settlementReview, investorId: investorByEntity.get(l.lpEntityId) ?? null,
      }
    }),
  }
}

/**
 * Render a receipt per selected funded line, file it in the partner's portal, and email it.
 *
 * Unlike a notice a receipt is not reused: each one acknowledges the funding as it stood when it
 * was sent, so a second wire on the same line earns a second receipt with the new total.
 */
export async function sendReceipts(
  admin: SupabaseClient,
  ctx: PublishContext,
  callId: string,
  opts: { lineIds?: string[]; email: NoticeEmailOptions | null },
): Promise<{ receipts: { lineId: string; name: string; documentId: string }[]; errors: string[]; send: NoticeSendResult | null } | { error: string; status: number }> {
  const { fundId, group, userId } = ctx
  const found = await receiptCandidates(admin, fundId, group, callId)
  if ('error' in found) return found
  const requested = opts.lineIds ?? []
  const targets = found.candidates.filter(c => requested.length === 0 ? c.due : requested.includes(c.lineId))
  if (targets.some(c => c.settlementReview)) return { error: 'Reconcile manual payments with accounting records before issuing receipts for these lines.', status: 409 }
  if (targets.length === 0) return { error: 'Nothing to receipt: no selected line has money against it', status: 400 }

  const [fundRes, settingsRes, summary] = await Promise.all([
    admin.from('funds' as any).select('name, logo_url, address').eq('id', fundId).maybeSingle(),
    admin.from('fund_settings' as any).select('currency, theme').eq('fund_id', fundId).maybeSingle(),
    lpCapitalSummary(admin, fundId, group),
  ])
  const fund = (fundRes as any).data
  const letterhead = await documentLetterhead(admin, fundId, fund, [group])
  const currency = (settingsRes as any).data?.currency || 'USD'
  const summaryByLp = new Map(summary.map(r => [r.lpEntityId, r]))
  const title = `Receipt — Capital Call${found.call.number ? ` No. ${found.call.number}` : ''} — ${found.call.date}`

  const receipts: { lineId: string; name: string; documentId: string }[] = []
  const toEmail: DocumentToEmail[] = []
  const errors: string[] = []
  const fmt = moneyFmt(currency)

  await runPool(targets, 3, async c => {
    try {
      const row = summaryByLp.get(c.lpEntityId)
      const pdf = await generateReceiptPdf({
        displayFont: displayFontOf((settingsRes as any).data?.theme),
        fundName: letterhead.name, fundLogo: letterhead.logo, fundAddress: contactBlock(letterhead), currency,
        vehicle: group, partnerName: c.name,
        amountReceived: c.received, receivedOn: c.receivedOn ?? found.call.date,
        call: { date: found.call.date, number: found.call.number, description: found.call.description, amount: roundCents(c.received + c.outstanding), outstanding: c.outstanding },
        context: row ? [
          { label: 'Commitment', value: row.commitment },
          { label: 'Funded to date', value: row.funded },
          { label: 'Remaining to be called', value: row.outstanding },
        ] : [],
      })
      const fileName = `${title.replace(/[^a-zA-Z0-9 ._-]/g, '_')} — ${c.name.replace(/[^a-zA-Z0-9 ._-]/g, '_')}.pdf`
      const storagePath = `${fundId}/${Date.now()}_${fileName}`
      const { error: upErr } = await admin.storage.from('lp-documents').upload(storagePath, pdf, { contentType: 'application/pdf', upsert: false })
      if (upErr) { errors.push(`${c.name}: upload failed — ${upErr.message}`); return }
      const { data: doc, error: docErr } = await admin.from('lp_documents' as any).insert({
        fund_id: fundId, title, file_name: fileName, storage_path: storagePath, mime_type: 'application/pdf', size_bytes: pdf.length,
        scope: 'investor', vehicle: group, category: 'Capital Call Receipt', doc_date: c.receivedOn ?? found.call.date, uploaded_by: userId,
      }).select('id').single()
      if (docErr || !doc) { errors.push(`${c.name}: ${docErr?.message ?? 'insert failed'}`); return }
      const documentId = (doc as any).id as string
      if (c.investorId) await ensureShare(admin, fundId, documentId, c.investorId)
      else errors.push(`${c.name}: generated, but not shared — this entity has no linked LP investor.`)
      receipts.push({ lineId: c.lineId, name: c.name, documentId })
      toEmail.push({
        lineId: c.lineId, lpEntityId: c.lpEntityId, name: c.name, investorId: c.investorId, documentId,
        facts: [
          { label: 'Amount received', value: fmt(c.received) },
          ...(c.receivedOn ? [{ label: 'Received', value: c.receivedOn }] : []),
          ...(c.outstanding > 0.005 ? [{ label: 'Still outstanding', value: fmt(c.outstanding) }] : []),
        ],
      })
    } catch (e: any) {
      errors.push(`${c.name}: ${e?.message ?? 'could not generate the receipt'}`)
    }
  })

  let send: NoticeSendResult | null = null
  if (opts.email) {
    const r = await emailDocuments(admin, ctx, toEmail.filter(t => t.investorId), { ...opts.email, logKind: 'receipt', title, linkPath: '/portal/notices', linkLabel: 'View the receipt' })
    if ('error' in r) return { error: r.error, status: 400 }
    send = r
  }
  return { receipts, errors, send }
}
