/**
 * Run the inbound pipeline again on an email that is already saved: the Emails page's Reprocess
 * button (app/api/emails/[id]/reprocess) and the `reprocess_company_update` tool share this, so a
 * chat can re-read a saved company update (after a file was added with add_email_attachment, or
 * after a failure) exactly as the button does.
 *
 * What the last run wrote from this email is cleared first (its review items and metric values),
 * the company it was filed under is kept, and the stored attachments are read back from Storage.
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import { runPipeline, type PostmarkPayload } from '@/lib/pipeline/processEmail'
import { hydrateAttachments } from '@/lib/parsing/extractAttachmentText'

export interface ReprocessableEmail {
  id: string
  fund_id: string
  raw_payload: unknown
  processing_status: string | null
}

export class ReprocessRefused extends Error {
  constructor(message: string, readonly status: 409 | 422) {
    super(message)
  }
}

/** Throws ReprocessRefused when the email can't be run again now. */
export function assertReprocessable(email: ReprocessableEmail) {
  if (email.processing_status === 'processing') throw new ReprocessRefused('Already processing', 409)
  if (!email.raw_payload) throw new ReprocessRefused('No stored payload to reprocess', 422)
}

/** Clears what the last run wrote and marks the email processing. Call before runReprocess. */
export async function resetForReprocess(admin: SupabaseClient, email: ReprocessableEmail) {
  assertReprocessable(email)
  const db = admin as any
  await db.from('parsing_reviews').delete().eq('email_id', email.id).eq('fund_id', email.fund_id)
  await db.from('metric_values').delete().eq('source_email_id', email.id).eq('fund_id', email.fund_id)
  // company_id is kept, so a company chosen by hand isn't lost.
  await db.from('inbound_emails').update({
    processing_status: 'processing',
    processing_error: null,
    claude_response: null,
    metrics_extracted: 0,
  }).eq('id', email.id)
}

/**
 * Runs the pipeline on the stored payload until it reaches a terminal state. A failure is written
 * to the email (failed, with a readable error) rather than thrown.
 */
export async function runReprocess(admin: SupabaseClient, email: ReprocessableEmail): Promise<void> {
  const db = admin as any
  try {
    const payload = await hydrateAttachments(email.raw_payload as PostmarkPayload) as unknown as PostmarkPayload
    const senderEmail = (payload.FromFull?.Email ?? payload.From ?? '').trim().toLowerCase()
    const { data: memberRow } = await db.rpc('is_fund_member_by_email', { p_fund_id: email.fund_id, p_email: senderEmail })
    const fundMember = memberRow?.[0] ? { userId: memberRow[0].user_id as string } : null
    await runPipeline(db, email.id, email.fund_id, payload, fundMember)
  } catch (err) {
    const raw = err instanceof Error ? err.message : String(err)
    console.error(`[reprocess] Pipeline error for email ${email.id}:`, err)
    await db.from('inbound_emails')
      .update({ processing_status: 'failed', processing_error: describePipelineError(raw) })
      .eq('id', email.id)
  }
}

export function describePipelineError(raw: string): string {
  if (raw.includes('API key not configured')) {
    const provider = raw.includes('OpenAI') ? 'OpenAI' : raw.includes('Gemini') ? 'Gemini' : 'AI'
    return `${provider} API key not configured. Add it in Settings to process emails.`
  }
  if (raw.includes('Failed to refresh Google token') || raw.includes('invalid_grant')) {
    return 'Google Drive connection expired. Reconnect in Settings > Google credentials, then reprocess this email.'
  }
  if (raw.includes('rate limit') || raw.includes('429')) {
    return 'AI provider rate limit reached. Wait a few minutes and reprocess this email.'
  }
  if (raw.includes('timeout') || raw.includes('ETIMEDOUT') || raw.includes('ECONNREFUSED')) {
    return 'Connection to AI provider timed out. Check your API key and try reprocessing.'
  }
  return raw
}
