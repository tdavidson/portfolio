import { NextRequest, NextResponse } from 'next/server'
import { Resend } from 'resend'
import { envCredential, type EnvCredential } from '@/lib/credentials/env'
import { createAdminClient } from '@/lib/supabase/admin'
import { normalizeResendEmail, toPostmarkPayload, extractEmail } from '@/lib/pipeline/normalizePayload'
import { runPipeline } from '@/lib/pipeline/processEmail'
import { checkFundMember } from '@/lib/pipeline/checkFundMember'
import { isAuthorizedSender } from '@/lib/pipeline/isAuthorizedSender'
import { decrypt } from '@/lib/crypto'
import { scanFileAsync } from '@/lib/security/scan-file'
import { rateLimit, getClientIp } from '@/lib/rate-limit'
import { emailFingerprint } from '@/lib/pipeline/emailFingerprint'
import { authenticationRejection, fetchInboundEmail, matchInboundDomain } from '@/lib/resend/inbound'
import type { Json } from '@/lib/types/database'

// Resend's `email.received` webhook. The event carries metadata only, so after the signature checks
// out this route reads the body and attachments back from Resend's API (lib/resend/inbound.ts).
//
// Returns 200 for everything it handles or deliberately drops, so Resend doesn't retry those. The
// one exception is a failure to read the email back from Resend: that returns 503, nothing has been
// stored yet, and Resend's retries (about 27 hours of them) get another go.

export async function POST(req: NextRequest) {
  // Rate limit inbound webhook: 60 per minute per IP
  const limited = await rateLimit({ key: `inbound-resend:${getClientIp(req)}`, limit: 60, windowSeconds: 60 })
  if (limited) return limited

  try {
    const outcome = await handleResendInbound(req)
    if (outcome === 'retry') return NextResponse.json({ ok: false }, { status: 503 })
  } catch (err) {
    console.error('[inbound-email/resend] Unhandled error:', err)
  }
  return NextResponse.json({ ok: true })
}

type ReceivedEvent = {
  type: string
  data?: { email_id?: string; from?: string; to?: string[]; received_for?: string[] }
}

async function handleResendInbound(req: NextRequest): Promise<'done' | 'retry'> {
  const supabase = createAdminClient()

  // The signature covers the exact bytes, so read the raw body before parsing it.
  const rawBody = await req.text()
  let event: ReceivedEvent
  try {
    event = JSON.parse(rawBody)
  } catch {
    console.warn('[inbound-email/resend] Body is not JSON')
    return 'done'
  }
  if (event.type !== 'email.received') return 'done'

  const emailId = event.data?.email_id
  const recipients = [...(event.data?.to ?? []), ...(event.data?.received_for ?? [])]
  if (!emailId || recipients.length === 0) {
    console.warn('[inbound-email/resend] Missing email id or recipients')
    return 'done'
  }

  // Resolve which fund this email belongs to by matching its Resend inbound domain
  const { data: allSettings } = await supabase
    .from('fund_settings')
    .select('fund_id, resend_inbound_domain, resend_webhook_secret_encrypted, resend_api_key_encrypted, encryption_key_encrypted')
    .eq('inbound_email_provider', 'resend')
    .not('resend_inbound_domain', 'is', null)

  const match = matchInboundDomain(recipients, allSettings ?? [])
  if (!match) {
    console.warn(`[inbound-email/resend] No fund matches recipients ${recipients.join(', ')}`)
    return 'done'
  }
  const { settings: fundSettings, recipient } = match
  const fundId = fundSettings.fund_id

  // The secrets saved in Settings, else RESEND_WEBHOOK_SECRET / RESEND_API_KEY (lib/credentials/env.ts).
  const secret = (column: string | null, name: EnvCredential): string | null => {
    if (column && fundSettings.encryption_key_encrypted) {
      const kek = process.env.ENCRYPTION_KEY
      if (!kek) {
        console.error('[inbound-email/resend] ENCRYPTION_KEY not set')
        return null
      }
      return decrypt(column, decrypt(fundSettings.encryption_key_encrypted, kek))
    }
    return envCredential(name)
  }
  const webhookSecret = secret(fundSettings.resend_webhook_secret_encrypted, 'resend_webhook')
  const apiKey = secret(fundSettings.resend_api_key_encrypted, 'resend')
  if (!webhookSecret || !apiKey) {
    console.warn(`[inbound-email/resend] Rejecting, fund ${fundId} has no Resend ${webhookSecret ? 'API key' : 'webhook secret'}`)
    return 'done'
  }

  const resend = new Resend(apiKey)
  try {
    resend.webhooks.verify({
      payload: rawBody,
      headers: {
        id: req.headers.get('svix-id') ?? '',
        timestamp: req.headers.get('svix-timestamp') ?? '',
        signature: req.headers.get('svix-signature') ?? '',
      },
      webhookSecret,
    })
  } catch {
    console.warn('[inbound-email/resend] Invalid webhook signature')
    return 'done'
  }

  const fromAddress = extractEmail(event.data?.from ?? '')
  if (!fromAddress) {
    console.warn('[inbound-email/resend] Missing from')
    return 'done'
  }

  // Check if sender is a fund member (determines interaction extraction, bypasses authorized_senders)
  const fundMember = await checkFundMember(supabase, fundId, fromAddress)

  // Check authorized senders (fund members bypass this check)
  if (!fundMember) {
    const authorized = await isAuthorizedSender(supabase, fundId, fromAddress)
    if (!authorized) {
      console.warn(`[inbound-email/resend] Unauthorized sender ${fromAddress} for fund ${fundId}`)
      return 'done'
    }
  }

  let fetched: Awaited<ReturnType<typeof fetchInboundEmail>>
  try {
    fetched = await fetchInboundEmail(resend.emails.receiving, emailId)
  } catch (err) {
    console.error('[inbound-email/resend] Could not read the email back from Resend:', err)
    return 'retry'
  }

  // A From that the sender's own domain disowns is a spoof of an authorized sender, not mail from them.
  const rejection = authenticationRejection(fetched.email.authentication)
  if (rejection) {
    console.warn(`[inbound-email/resend] Rejecting email from ${fromAddress} for fund ${fundId}: ${rejection}`)
    return 'done'
  }

  // Normalize to PostmarkPayload format for the unified pipeline
  const normalized = normalizeResendEmail(fetched.email, recipient, fetched.attachments)
  const payload = toPostmarkPayload(normalized)

  // Check for duplicate emails (same sender + subject + date)
  const fingerprint = emailFingerprint(
    fromAddress,
    payload.Subject ?? null,
    payload.Date ?? null,
    payload.MessageID ?? null
  )

  const { data: existingEmail } = await supabase
    .from('inbound_emails')
    .select('id')
    .eq('fund_id', fundId)
    .eq('email_fingerprint', fingerprint)
    .maybeSingle()

  if (existingEmail) {
    console.log(`[inbound-email/resend] Duplicate email detected (fingerprint=${fingerprint}), skipping`)
    return 'done'
  }

  // Build a storage-friendly payload (strip Content from attachments)
  const strippedPayload = { ...payload }
  if (payload.Attachments && payload.Attachments.length > 0) {
    strippedPayload.Attachments = payload.Attachments.map(att => ({
      Name: att.Name,
      ContentType: att.ContentType,
      ContentLength: att.ContentLength,
    }))
  }

  // Persist raw email (without attachment content)
  const { data: emailRow, error: insertError } = await supabase
    .from('inbound_emails')
    .insert({
      fund_id: fundId,
      from_address: fromAddress,
      subject: payload.Subject || null,
      raw_payload: strippedPayload as unknown as Json,
      processing_status: 'pending',
      attachments_count: payload.Attachments?.length ?? 0,
      email_fingerprint: fingerprint,
    })
    .select('id')
    .single()

  if (insertError || !emailRow) {
    console.error('[inbound-email/resend] Failed to insert email record:', insertError)
    return 'done'
  }

  const inboundId = emailRow.id

  // Upload attachments to Storage and update payload with StoragePaths
  if (payload.Attachments && payload.Attachments.length > 0) {
    const updatedAttachments = []
    for (let attIdx = 0; attIdx < payload.Attachments.length; attIdx++) {
      const att = payload.Attachments[attIdx]
      const buffer = Buffer.from(att.Content!, 'base64')

      // Scan attachment before uploading
      const scanResult = await scanFileAsync(buffer, att.Name, att.ContentType)
      if (!scanResult.safe) {
        console.warn(`[inbound-email/resend] Skipping unsafe attachment "${att.Name}": ${scanResult.reason}`)
        // Keep the descriptor and original ordinal while refusing to persist unsafe bytes.
        updatedAttachments.push({
          Name: att.Name,
          ContentType: att.ContentType,
          ContentLength: att.ContentLength,
          ContentError: `Safety scan failed: ${scanResult.reason ?? 'unknown reason'}`,
        })
        continue
      }

      const safeName = `${attIdx}_${att.Name.replace(/[\/\\:*?"<>|]/g, '_').replace(/\.\./g, '_')}`
      const storagePath = `${inboundId}/${safeName}`
      const { error: uploadError } = await supabase.storage
        .from('email-attachments')
        .upload(storagePath, buffer, { contentType: att.ContentType })

      if (uploadError) {
        console.error(`[inbound-email/resend] Failed to upload attachment "${att.Name}" to storage:`, uploadError.message)
        updatedAttachments.push({
          Name: att.Name,
          ContentType: att.ContentType,
          ContentLength: att.ContentLength,
          Content: att.Content,
        })
      } else {
        updatedAttachments.push({
          Name: att.Name,
          ContentType: att.ContentType,
          ContentLength: att.ContentLength,
          StoragePath: storagePath,
        })
      }
    }

    await supabase
      .from('inbound_emails')
      .update({
        raw_payload: { ...strippedPayload, Attachments: updatedAttachments } as unknown as Json,
      })
      .eq('id', inboundId)
  }

  try {
    await supabase
      .from('inbound_emails')
      .update({ processing_status: 'processing' })
      .eq('id', inboundId)

    // Pass original in-memory payload (with Content) to avoid extra Storage download
    await runPipeline(supabase, inboundId, fundId, payload, fundMember ? { userId: fundMember.user_id } : null)
  } catch (err) {
    const raw = err instanceof Error ? err.message : String(err)
    console.error(`[inbound-email/resend] Pipeline error for email ${inboundId}:`, err)
    const message = describePipelineError(raw)
    await supabase
      .from('inbound_emails')
      .update({ processing_status: 'failed', processing_error: message })
      .eq('id', inboundId)
  }
  return 'done'
}

function describePipelineError(raw: string): string {
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
