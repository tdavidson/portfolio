import { NextRequest, NextResponse } from 'next/server'
import { randomBytes, timingSafeEqual } from 'crypto'
import { createAdminClient } from '@/lib/supabase/admin'
import { decrypt, encrypt } from '@/lib/crypto'
import {
  runPipeline,
  type PostmarkPayload,
} from '@/lib/pipeline/processEmail'
import { checkFundMember } from '@/lib/pipeline/checkFundMember'
import { postmarkSenderVerified } from '@/lib/pipeline/sender-auth'
import { isAuthorizedSender } from '@/lib/pipeline/isAuthorizedSender'
import { rateLimit, getClientIp } from '@/lib/rate-limit'
import { scanFileAsync } from '@/lib/security/scan-file'
import { emailFingerprint } from '@/lib/pipeline/emailFingerprint'
import { matchPostmarkInbound } from '@/lib/postmark/inbound'

function safeTokenCompare(a: string, b: string): boolean {
  try {
    return a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b))
  } catch {
    return false
  }
}

// ---------------------------------------------------------------------------
// Entry point — always returns HTTP 200 to Postmark
// ---------------------------------------------------------------------------

export async function POST(req: NextRequest) {
  // Rate limit inbound webhook: 60 per minute per IP
  const limited = await rateLimit({ key: `inbound:${getClientIp(req)}`, limit: 60, windowSeconds: 60 })
  if (limited) return limited

  try {
    await handleInbound(req)
  } catch (err) {
    console.error('[inbound-email] Unhandled error:', err)
  }
  return NextResponse.json({ ok: true })
}

// ---------------------------------------------------------------------------
// Orchestrator
// ---------------------------------------------------------------------------

async function handleInbound(req: NextRequest) {
  const supabase = createAdminClient()
  // Accept token from Authorization header (preferred) or query string (legacy/Postmark)
  const authHeader = req.headers.get('authorization')
  const token = (authHeader?.startsWith('Bearer ') ? authHeader.slice(7) : null)
    ?? req.nextUrl.searchParams.get('token')
    ?? ''
  const payload = (await req.json()) as PostmarkPayload

  const toAddress = payload.OriginalRecipient || payload.To
  const fromAddress = payload.FromFull?.Email || payload.From

  // Step 1: Resolve which fund this email belongs to and validate the token
  const fundInfo = await resolveFund(supabase, toAddress, fromAddress, token)
  if (!fundInfo) {
    console.warn(`[inbound-email] Could not resolve fund for to=${toAddress} from=${fromAddress}`)
    return
  }
  const { fundId, isGlobal } = fundInfo

  // Step 1b: Check if sender is a fund member (determines interaction extraction, bypasses authorized_senders).
  // Only when the receiving server shows the mail really is from that address: a From header alone
  // is the sender's own claim.
  const fundMember = postmarkSenderVerified(fromAddress, payload.Headers)
    ? await checkFundMember(supabase, fundId, fromAddress)
    : null

  // Step 2: Check authorized senders (fund members bypass this check)
  if (!fundMember && !isGlobal) {
    const authorized = await isAuthorizedSender(supabase, fundId, fromAddress)
    if (!authorized) {
      console.warn(`[inbound-email] Unauthorized sender ${fromAddress} for fund ${fundId}`)
      return
    }
  }

  // Step 3: Check for duplicate emails (same sender + subject + date)
  const fingerprint = emailFingerprint(
    payload.FromFull?.Email || payload.From,
    payload.Subject ?? null,
    payload.Date ?? null,
    payload.MessageID
  )

  const { data: existingEmail } = await supabase
    .from('inbound_emails')
    .select('id')
    .eq('fund_id', fundId)
    .eq('email_fingerprint', fingerprint)
    .maybeSingle()

  if (existingEmail) {
    console.log(`[inbound-email] Duplicate email detected (fingerprint=${fingerprint}), skipping`)
    return
  }

  // Step 4: Build a storage-friendly payload (strip Content from attachments)
  const strippedPayload = { ...payload }
  if (payload.Attachments && payload.Attachments.length > 0) {
    strippedPayload.Attachments = payload.Attachments.map(att => ({
      Name: att.Name,
      ContentType: att.ContentType,
      ContentLength: att.ContentLength,
    }))
  }

  const { data: emailRow, error: insertError } = await supabase
    .from('inbound_emails')
    .insert({
      fund_id: fundId,
      from_address: fromAddress,
      subject: payload.Subject ?? null,
      raw_payload: strippedPayload as unknown as import('@/lib/types/database').Json,
      processing_status: 'pending',
      attachments_count: payload.Attachments?.length ?? 0,
      email_fingerprint: fingerprint,
    })
    .select('id')
    .single()

  if (insertError || !emailRow) {
    console.error('[inbound-email] Failed to insert email record:', insertError)
    return
  }

  const emailId = emailRow.id

  // Step 3b: Upload attachments to Storage and update payload with StoragePaths
  if (payload.Attachments && payload.Attachments.length > 0) {
    const updatedAttachments = []
    for (let attIdx = 0; attIdx < payload.Attachments.length; attIdx++) {
      const att = payload.Attachments[attIdx]
      const buffer = Buffer.from(att.Content!, 'base64')

      // Scan attachment before uploading
      const scanResult = await scanFileAsync(buffer, att.Name, att.ContentType)
      if (!scanResult.safe) {
        console.warn(`[inbound-email] Skipping unsafe attachment "${att.Name}": ${scanResult.reason}`)
        // Preserve the source ordinal even though unsafe bytes are not stored. Company Updates
        // must show a failed artifact rather than silently losing an attachment on reprocessing.
        updatedAttachments.push({
          Name: att.Name,
          ContentType: att.ContentType,
          ContentLength: att.ContentLength,
          ContentError: `Safety scan failed: ${scanResult.reason ?? 'unknown reason'}`,
        })
        continue
      }

      const safeName = `${attIdx}_${att.Name.replace(/[\/\\:*?"<>|]/g, '_').replace(/\.\./g, '_')}`
      const storagePath = `${emailId}/${safeName}`
      const { error: uploadError } = await supabase.storage
        .from('email-attachments')
        .upload(storagePath, buffer, { contentType: att.ContentType })

      if (uploadError) {
        console.error(`[inbound-email] Failed to upload attachment "${att.Name}" to storage:`, uploadError.message)
        // Keep Content in payload so it's not lost
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
        raw_payload: { ...strippedPayload, Attachments: updatedAttachments } as unknown as import('@/lib/types/database').Json,
      })
      .eq('id', emailId)
  }

  // Steps 4–8: extraction pipeline. Pass original in-memory payload (with Content).
  try {
    await supabase
      .from('inbound_emails')
      .update({ processing_status: 'processing' })
      .eq('id', emailId)

    await runPipeline(supabase, emailId, fundId, payload, fundMember ? { userId: fundMember.user_id } : null)
  } catch (err) {
    const raw = err instanceof Error ? err.message : String(err)
    console.error(`[inbound-email] Pipeline error for email ${emailId}:`, err)
    const message = describePipelineError(raw)
    await supabase
      .from('inbound_emails')
      .update({ processing_status: 'failed', processing_error: message })
      .eq('id', emailId)
  }
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

// ---------------------------------------------------------------------------
// Fund resolution helpers (specific to inbound routing)
// ---------------------------------------------------------------------------

async function resolveFund(
  supabase: ReturnType<typeof createAdminClient>,
  toAddress: string,
  fromAddress: string,
  token: string
): Promise<{ fundId: string; isGlobal: boolean } | null> {
  // By the saved address, else by its domain, so any name at a fund's inbound domain reaches it
  const { data: candidates } = await supabase
    .from('fund_settings')
    .select('fund_id, postmark_inbound_address, postmark_webhook_token, postmark_webhook_token_encrypted, encryption_key_encrypted')
    .not('postmark_inbound_address', 'is', null)
  const { data: appSettings } = await supabase
    .from('app_settings')
    .select('global_inbound_address, global_inbound_token, global_inbound_token_encrypted')
    .maybeSingle()
  const fundSettings = matchPostmarkInbound(toAddress, candidates ?? [], [appSettings?.global_inbound_address])

  if (fundSettings) {
    // Prefer encrypted token; fall back to plaintext for legacy
    let expectedToken = fundSettings.postmark_webhook_token ?? ''
    let fromEncrypted = false
    if (fundSettings.postmark_webhook_token_encrypted && fundSettings.encryption_key_encrypted) {
      try {
        const kek = process.env.ENCRYPTION_KEY
        if (kek) {
          const dek = decrypt(fundSettings.encryption_key_encrypted, kek)
          expectedToken = decrypt(fundSettings.postmark_webhook_token_encrypted, dek)
          fromEncrypted = true
        }
      } catch {
        // Fall back to plaintext
      }
    }
    if (!token || !expectedToken || !safeTokenCompare(token, expectedToken)) {
      console.warn('[inbound-email] Invalid token for per-fund address')
      return null
    }
    if (fundSettings.postmark_webhook_token) {
      await retireLegacyWebhookToken(supabase, fundSettings, token, fromEncrypted)
    }
    return { fundId: fundSettings.fund_id, isGlobal: false }
  }

  if (!appSettings?.global_inbound_address || toAddress !== appSettings.global_inbound_address) {
    return null
  }

  // Prefer encrypted token; fall back to plaintext for legacy
  let expectedGlobalToken = appSettings.global_inbound_token ?? ''
  if (appSettings.global_inbound_token_encrypted) {
    try {
      const kek = process.env.ENCRYPTION_KEY
      if (kek) {
        expectedGlobalToken = decrypt(appSettings.global_inbound_token_encrypted, kek)
      }
    } catch {
      // Fall back to plaintext
    }
  }

  if (!token || !expectedGlobalToken || !safeTokenCompare(token, expectedGlobalToken)) {
    console.warn('[inbound-email] Invalid token for global address')
    return null
  }

  const { data: senders } = await supabase
    .from('authorized_senders')
    .select('fund_id')
    .eq('email', fromAddress)

  if (!senders || senders.length === 0) return null

  if (senders.length > 1) {
    console.error(
      `[inbound-email] Ambiguous routing: ${fromAddress} is an authorized sender for multiple funds`
    )
    return null
  }

  return { fundId: senders[0].fund_id, isGlobal: true }
}

/**
 * Clears the plaintext `postmark_webhook_token` once a webhook has proved which token is current.
 * Anyone holding that value can forge inbound mail for the fund, and it used to sit in a column
 * every member could read.
 *
 * The plaintext copy is only dropped once an encrypted copy is known to decrypt: either it just
 * did (`fromEncrypted`), or the token that matched is encrypted here first. A fund whose encrypted
 * copy is unreadable (its data key was replaced by an older bug in the settings route) is healed
 * the same way, so no fund loses inbound mail. Best effort: a failure leaves the row as it was and
 * never refuses the webhook.
 */
async function retireLegacyWebhookToken(
  supabase: ReturnType<typeof createAdminClient>,
  row: { fund_id: string; encryption_key_encrypted?: string | null },
  token: string,
  fromEncrypted: boolean,
): Promise<void> {
  try {
    const update: Record<string, string | null> = { postmark_webhook_token: null }
    if (!fromEncrypted) {
      const kek = process.env.ENCRYPTION_KEY
      if (!kek) return
      let dek: string
      if (row.encryption_key_encrypted) {
        dek = decrypt(row.encryption_key_encrypted, kek)
      } else {
        dek = randomBytes(32).toString('hex')
        update.encryption_key_encrypted = encrypt(dek, kek)
      }
      update.postmark_webhook_token_encrypted = encrypt(token, dek)
    }
    let q = (supabase as any).from('fund_settings').update(update).eq('fund_id', row.fund_id)
    // Only the row as it was read: a concurrent save that set a data key wins over a fresh one.
    q = row.encryption_key_encrypted ? q.eq('encryption_key_encrypted', row.encryption_key_encrypted) : q.is('encryption_key_encrypted', null)
    await q
  } catch (err) {
    console.warn('[inbound-email] Could not retire the plaintext webhook token:', err instanceof Error ? err.message : err)
  }
}
