// Resend inbound email: the parts of the webhook route that don't touch the database.
//
// Resend's `email.received` webhook carries only metadata (sender, recipients, subject, attachment
// names). The body comes from GET /emails/receiving/{id}, and each attachment from a signed
// download URL listed by GET /emails/receiving/{id}/attachments (valid for an hour).
// https://resend.com/docs/dashboard/receiving/introduction

import type { Resend } from 'resend'

/** SPF, DKIM and DMARC as Resend's receiving server computed them. Not forgeable by the sender. */
export type AuthVerdict = 'pass' | 'fail' | 'gray' | 'processing_failed' | 'unknown'
export interface ResendAuthentication {
  spf?: AuthVerdict
  dkim?: AuthVerdict
  dmarc?: AuthVerdict
}

export interface ResendInboundEmail {
  id: string
  from: string
  to: string[]
  subject: string | null
  text: string | null
  html: string | null
  message_id: string | null
  created_at: string | null
  headers: Record<string, string> | null
  /** Null for mail received before Resend added the field. */
  authentication: ResendAuthentication | null
}

export interface DownloadedAttachment {
  filename: string
  contentType: string
  content: Buffer
}

type ResendReceiving = Pick<Resend['emails']['receiving'], 'get'> & {
  attachments: Pick<Resend['emails']['receiving']['attachments'], 'list'>
}

/**
 * The fund whose Resend inbound domain one of the recipients is on, and that recipient. Recipients
 * are the `to` list plus `received_for` (the envelope recipients), so Bcc and forwarding work.
 */
export function matchInboundDomain<T extends { resend_inbound_domain: string | null }>(
  recipients: string[],
  settings: T[],
): { settings: T; recipient: string } | null {
  for (const raw of recipients) {
    const recipient = extractAddress(raw).toLowerCase()
    const domain = recipient.split('@')[1]
    if (!domain) continue
    const match = settings.find(s => s.resend_inbound_domain?.trim().toLowerCase() === domain)
    if (match) return { settings: match, recipient }
  }
  return null
}

/**
 * Why an email should be refused on its authentication results, or null to accept it.
 *
 * Refuses only a DMARC `fail`: the sender's own domain published a policy and this message broke
 * it, which is what a spoofed From looks like. `gray` (no policy, softfail) and missing results
 * are accepted, since plenty of legitimate small senders have no DMARC record.
 */
export function authenticationRejection(auth: ResendAuthentication | null): string | null {
  if (auth?.dmarc === 'fail') {
    return `DMARC failed (spf=${auth.spf ?? 'unknown'}, dkim=${auth.dkim ?? 'unknown'})`
  }
  return null
}

/** Fetch a received email's content and download its attachments. Throws when Resend can't be reached. */
export async function fetchInboundEmail(
  receiving: ResendReceiving,
  emailId: string,
  fetchImpl: typeof fetch = fetch,
): Promise<{ email: ResendInboundEmail; attachments: DownloadedAttachment[] }> {
  const { data, error } = await receiving.get(emailId)
  if (error || !data) throw new Error(`Resend: could not read received email ${emailId}: ${error?.message ?? 'no data'}`)
  const email: ResendInboundEmail = {
    id: data.id,
    from: data.from,
    to: data.to ?? [],
    subject: data.subject ?? null,
    text: data.text ?? null,
    html: data.html ?? null,
    message_id: data.message_id ?? null,
    created_at: data.created_at ?? null,
    headers: data.headers ?? null,
    // In the API response but not yet in the SDK's type.
    authentication: (data as { authentication?: ResendAuthentication | null }).authentication ?? null,
  }

  if (!data.attachments?.length) return { email, attachments: [] }

  const listed: Array<{ filename?: string; content_type: string; download_url: string }> = []
  let after: string | undefined
  for (;;) {
    const page = await receiving.attachments.list({ emailId, limit: 100, ...(after ? { after } : {}) })
    if (page.error || !page.data) {
      throw new Error(`Resend: could not list attachments for ${emailId}: ${page.error?.message ?? 'no data'}`)
    }
    listed.push(...page.data.data)
    if (!page.data.has_more || page.data.data.length === 0) break
    after = page.data.data[page.data.data.length - 1].id
  }

  const attachments: DownloadedAttachment[] = []
  for (const att of listed) {
    const res = await fetchImpl(att.download_url)
    if (!res.ok) throw new Error(`Resend: attachment download failed (${res.status}) for ${emailId}`)
    attachments.push({
      filename: att.filename || 'attachment',
      contentType: att.content_type || 'application/octet-stream',
      content: Buffer.from(await res.arrayBuffer()),
    })
  }
  return { email, attachments }
}

function extractAddress(value: string): string {
  const match = value.match(/<([^>]+)>/)
  return match ? match[1] : value.trim()
}
