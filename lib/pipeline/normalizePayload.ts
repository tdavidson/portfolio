import type { PostmarkPayload } from './processEmail'

/**
 * Provider-agnostic normalized email payload.
 * Each inbound provider adapter converts its native format into this shape,
 * which is then converted to a PostmarkPayload so the existing pipeline
 * (processEmail.ts) works unchanged.
 */
export interface NormalizedEmailPayload {
  from: string
  fromName?: string
  to: string
  date?: string
  subject: string
  textBody: string
  htmlBody: string
  messageId?: string
  attachments: Array<{
    filename: string
    contentType: string
    content: string // base64
    size: number
  }>
}

/**
 * Convert a Resend received email (GET /emails/receiving/{id}) and its downloaded attachments into
 * a NormalizedEmailPayload. `to` is the recipient that matched the fund, since a received email can
 * be addressed to several.
 */
export function normalizeResendEmail(
  email: {
    from: string
    subject: string | null
    text: string | null
    html: string | null
    message_id?: string | null
    created_at?: string | null
    headers?: Record<string, string> | null
  },
  to: string,
  attachments: Array<{ filename: string; contentType: string; content: Buffer }>,
): NormalizedEmailPayload {
  return {
    from: extractEmail(email.from),
    fromName: extractName(email.from),
    to,
    date: headerValue(email.headers, 'date') ?? email.created_at ?? undefined,
    subject: email.subject ?? '',
    textBody: email.text ?? '',
    htmlBody: email.html ?? '',
    messageId: email.message_id || undefined,
    attachments: attachments.map(a => ({
      filename: a.filename,
      contentType: a.contentType,
      content: a.content.toString('base64'),
      size: a.content.length,
    })),
  }
}

/**
 * Convert a NormalizedEmailPayload into a PostmarkPayload so the existing
 * pipeline (processEmail.ts → runPipeline) works unchanged.
 */
export function toPostmarkPayload(normalized: NormalizedEmailPayload): PostmarkPayload {
  return {
    From: normalized.from,
    FromFull: { Email: normalized.from, Name: normalized.fromName || '' },
    To: normalized.to,
    OriginalRecipient: normalized.to,
    Date: normalized.date,
    Subject: normalized.subject,
    TextBody: normalized.textBody,
    HtmlBody: normalized.htmlBody,
    MessageID: normalized.messageId,
    Attachments: normalized.attachments.map(a => ({
      Name: a.filename,
      ContentType: a.contentType,
      Content: a.content,
      ContentLength: a.size,
    })),
  }
}

/** A header by name, ignoring case (Resend returns headers as an object keyed as sent). */
function headerValue(headers: Record<string, string> | null | undefined, name: string): string | undefined {
  if (!headers) return undefined
  const key = Object.keys(headers).find(k => k.toLowerCase() === name)
  return key ? headers[key] : undefined
}

// Extract email address from "Name <email@example.com>" format
export function extractEmail(from: string): string {
  const match = from.match(/<([^>]+)>/)
  return match ? match[1] : from.trim()
}

function extractName(from: string): string {
  const match = from.match(/^(.+?)\s*</)
  return match ? match[1].trim().replace(/^["']|["']$/g, '') : ''
}
