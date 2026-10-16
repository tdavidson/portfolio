// A file added to an inbound email by hand (the email page's Upload document, or the review
// modal), shared by the web route (app/api/emails/[id]/attachments POST) and the agent tool
// `add_email_attachment`: the file is already in the email-attachments bucket under the email's
// folder, and this verifies it, scans it and lists it on the email like one that arrived with it.

import crypto from 'crypto'
import type { SupabaseClient } from '@supabase/supabase-js'
import { scanFileAsync } from '@/lib/security/scan-file'
import { dbFail, done, fail, type Outcome } from '@/lib/service-outcome'

export const EMAIL_ATTACHMENT_BUCKET = 'email-attachments'
/** The bucket's own cap. */
export const MAX_EMAIL_ATTACHMENT_BYTES = 25 * 1024 * 1024

/** The key the browser builds, `${emailId}/${uuid}-${name}`. */
export function emailAttachmentPath(emailId: string, fileName: string): string {
  return `${emailId}/${crypto.randomUUID()}-${fileName}`
}

export async function registerEmailAttachment(
  admin: SupabaseClient,
  fundId: string,
  emailId: string,
  input: { filename?: unknown; contentType?: unknown; contentLength?: unknown; storagePath?: unknown },
): Promise<Outcome<{ ok: true; filename: string }>> {
  const filename = typeof input.filename === 'string' ? input.filename : ''
  const contentType = typeof input.contentType === 'string' ? input.contentType : ''
  const storagePath = typeof input.storagePath === 'string' ? input.storagePath : ''
  const contentLength = Number(input.contentLength)
  if (!filename || !contentType || !storagePath) return fail(400, 'Missing filename, contentType, or storagePath')

  // Inside this email's folder only: no traversal into another email's (or fund's) files.
  if (storagePath.includes('..') || !storagePath.startsWith(`${emailId}/`)) return fail(400, 'Invalid storage path')
  if (!Number.isFinite(contentLength) || contentLength < 0 || contentLength > MAX_EMAIL_ATTACHMENT_BYTES) {
    return fail(400, 'Invalid attachment size')
  }

  const db = admin as any
  const { data: email, error } = await db.from('inbound_emails').select('id, fund_id, raw_payload').eq('id', emailId).maybeSingle()
  if (error) return dbFail(error, 'emails-id-attachments')
  if (!email || email.fund_id !== fundId) return fail(404, 'Not found')

  // The declared type and size are the client's. Pull the object back through the trusted server
  // and apply the same executable, magic-byte, EICAR and ZIP-bomb checks as inbound mail.
  const remove = () => db.storage.from(EMAIL_ATTACHMENT_BUCKET).remove([storagePath])
  const { data: stored, error: downloadError } = await db.storage.from(EMAIL_ATTACHMENT_BUCKET).download(storagePath)
  if (downloadError || !stored) {
    await remove()
    return fail(400, 'Uploaded attachment could not be verified')
  }
  const buffer = Buffer.from(await stored.arrayBuffer())
  if (buffer.length !== contentLength) {
    await remove()
    return fail(400, 'Attachment size does not match uploaded content')
  }
  const scan = await scanFileAsync(buffer, filename, contentType)
  if (!scan.safe) {
    await remove()
    return fail(400, `File rejected: ${scan.reason}`)
  }

  const rawPayload = (email.raw_payload ?? {}) as Record<string, unknown>
  const existing = (rawPayload.Attachments ?? []) as Array<Record<string, unknown>>
  // Metadata only (no Content): the file is in storage.
  const attachment = { AttachmentId: crypto.randomUUID(), Name: filename, ContentType: contentType, ContentLength: contentLength, StoragePath: storagePath }
  const { error: updateError } = await db.from('inbound_emails')
    .update({ raw_payload: { ...rawPayload, Attachments: [...existing, attachment] }, attachments_count: existing.length + 1 })
    .eq('id', emailId)
  if (updateError) {
    await remove()
    return dbFail(updateError, 'emails-id-attachments')
  }
  return done({ ok: true, filename })
}
