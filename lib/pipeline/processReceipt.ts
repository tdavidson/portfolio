// The receipts branch of the inbound mailbox: an email a member sent in as a receipt is stored as
// one receipt per attachment (or, for an e-receipt that IS the email, one rendered from its body),
// read, and matched to the entry it supports when there is exactly one obvious candidate.
//
// Decided before the routing classifier, deterministically (looksLikeReceipt), because receipts are
// a member's own paperwork and the classifier's five destinations are all about the portfolio.

import type { SupabaseClient } from '@supabase/supabase-js'
import { looksLikeReceipt, isReceiptFile } from '@/lib/accounting/receipts-core'
import { storeReceipt, extractReceipt, matchCandidates, attachReceipt, getReceipt } from '@/lib/accounting/receipts'
import type { PostmarkPayload } from './processEmail'

export { looksLikeReceipt }

export function receiptSignal(payload: PostmarkPayload, emailBody: string, isFundMember: boolean) {
  return {
    subject: payload.Subject ?? '',
    to: payload.OriginalRecipient || payload.To,
    attachmentNames: (payload.Attachments ?? []).map(a => a.Name),
    body: emailBody,
    isFundMember,
  }
}

/**
 * The entity a receipt from the mailbox is filed under before anyone looks at it: the fund's
 * management company when it has exactly one, since that is who pays a fund's expenses and bills
 * them back. Otherwise none, and the Receipts page asks.
 */
export async function defaultReceiptVehicle(admin: SupabaseClient, fundId: string): Promise<string | null> {
  const { data } = await admin.from('fund_vehicles' as any).select('id').eq('fund_id', fundId).eq('kind', 'manco').limit(2)
  const rows = (data as any[]) ?? []
  return rows.length === 1 ? rows[0].id as string : null
}

/** Score at or above which a lone candidate is attached without asking. */
const AUTO_ATTACH = 0.85

export async function processReceiptEmail(
  admin: SupabaseClient,
  args: { emailId: string; fundId: string; payload: PostmarkPayload; emailBody: string; userId: string | null },
): Promise<{ stored: number; matched: number; warnings: string[] }> {
  const { emailId, fundId, payload, emailBody, userId } = args
  const warnings: string[] = []
  const vehicleId = await defaultReceiptVehicle(admin, fundId)

  // A reprocessed email must not file its receipts twice.
  const { data: already } = await admin.from('receipts' as any).select('id').eq('fund_id', fundId).eq('source_email_id', emailId).limit(1)
  if (((already as any[]) ?? []).length > 0) return { stored: 0, matched: 0, warnings: ['Receipts from this email were already filed.'] }

  const files: { name: string; type: string; content: Buffer; text?: string }[] = []
  for (const a of payload.Attachments ?? []) {
    if (!a.Content || !isReceiptFile(a.ContentType, a.ContentLength)) continue
    files.push({ name: a.Name, type: a.ContentType, content: Buffer.from(a.Content, 'base64') })
  }

  // An e-receipt with no attachment: the email is the receipt. Kept as its (sanitized) HTML, or its
  // text. Not rendered here: the mailbox's functions do not ship a browser, and the invoice PDF,
  // which does, renders it when it appends the receipt as backup.
  if (files.length === 0) {
    const subject = (payload.Subject ?? 'receipt').replace(/^\s*((fwd?|fw):\s*)+/i, '').trim() || 'receipt'
    const base = subject.replace(/[^a-zA-Z0-9 ._-]/g, '_').slice(0, 80)
    if (payload.HtmlBody) {
      const { sanitizeHtml } = await import('@/lib/sanitize-html')
      files.push({ name: `${base}.html`, type: 'text/html', content: Buffer.from(sanitizeHtml(payload.HtmlBody), 'utf8'), text: emailBody })
    } else if (emailBody.trim()) {
      files.push({ name: `${base}.txt`, type: 'text/plain', content: Buffer.from(emailBody, 'utf8'), text: emailBody })
    }
  }

  if (files.length === 0) return { stored: 0, matched: 0, warnings: ['This email had no attachment or text to file as a receipt.'] }

  let stored = 0
  let matched = 0
  for (const f of files) {
    const row = await storeReceipt(admin, {
      fundId, vehicleId, source: 'email', sourceEmailId: emailId,
      fileName: f.name, contentType: f.type, content: f.content, uploadedBy: userId,
    })
    if ('error' in row) { warnings.push(`${f.name}: ${row.error}`); continue }
    stored++
    await extractReceipt(admin, fundId, row.id, { content: f.content, contentType: f.type, text: f.text ?? emailBody })

    // Attach without asking only when the answer is not in doubt: one candidate, strong, and no
    // runner-up close behind. Everything else waits on the Receipts page with its suggestions.
    const fresh = await getReceipt(admin, fundId, row.id)
    if (fresh) {
      const ranked = await matchCandidates(admin, fundId, fresh)
      const [best, next] = ranked
      if (best && best.score >= AUTO_ATTACH && (!next || next.score < 0.6)) {
        const res = await attachReceipt(admin, fundId, row.id,
          best.kind === 'entry' ? { journalEntryId: best.id } : { bankTransactionId: best.id }, null)
        if (!('error' in res)) matched++
      }
    }
  }
  return { stored, matched, warnings }
}
