import { NextRequest, NextResponse } from 'next/server'
import crypto from 'crypto'
import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { getFeatureProvider } from '@/lib/ai/feature-provider'
import { extractAttachmentText, type PostmarkPayload } from '@/lib/parsing/extractAttachmentText'
import { processDeal } from '@/lib/pipeline/processDeal'
import type { PostmarkPayload as PipelinePayload } from '@/lib/pipeline/processEmail'
import { loadEntityScopeForUser } from '@/lib/access/entity-scope'
import { dealEntityProblem } from '@/lib/access/scope'
import {
  MAX_NAME_LEN, MAX_EMAIL_LEN, MAX_URL_LEN, MAX_PITCH_LEN,
  EMAIL_RE, safeWebUrl, sanitizeFilename, validateAttachmentType,
} from '@/lib/deals/submission-validation'

const MAX_FILE_BYTES = 10 * 1024 * 1024
const MAX_FILES = 10

/**
 * Admin-authenticated in-app deal creation. Composes a synthetic email payload
 * from form fields + optional file attachments and runs it through the same
 * processDeal pipeline that handles Postmark webhooks and the public submit
 * form. The deal lands in /deals exactly like an emailed one.
 *
 * Accepts multipart/form-data so the client can upload files directly without
 * base64-encoding on the browser side. Fields:
 *   - company_name   (required)
 *   - founder_name   (required)
 *   - founder_email  (required)
 *   - company_url    (optional)
 *   - intro_source   (optional) — referral | cold | warm_intro | accelerator | demo_day | event | other
 *   - referrer_name  (optional)
 *   - referrer_email (optional)
 *   - pitch          (required) — free-form description
 *   - files[]        (optional, repeated) — up to MAX_FILES, each up to MAX_FILE_BYTES
 */
export async function POST(req: NextRequest) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const admin = createAdminClient()
  const { data: membership } = await admin
    .from('fund_members')
    .select('fund_id')
    .eq('user_id', user.id)
    .maybeSingle()
  if (!membership) return NextResponse.json({ error: 'No fund found' }, { status: 403 })
  const fundId = (membership as any).fund_id as string

  let form: FormData
  try {
    form = await req.formData()
  } catch {
    return NextResponse.json({ error: 'Expected multipart/form-data' }, { status: 400 })
  }

  // Which entity the deal is for. Required of a member (an unassigned deal is admins-only, so they
  // would lose sight of their own submission); optional for an admin.
  const vehicleId = String(form.get('vehicle_id') ?? '').trim() || null
  const scope = await loadEntityScopeForUser(admin, user.id)
  const entityProblem = scope ? dealEntityProblem(scope.access, vehicleId) : 'No fund found'
  if (entityProblem) return NextResponse.json({ error: entityProblem }, { status: 403 })
  if (vehicleId) {
    const { data: v } = await admin.from('fund_vehicles' as any).select('id').eq('fund_id', fundId).eq('id', vehicleId).maybeSingle()
    if (!v) return NextResponse.json({ error: 'Entity not found' }, { status: 404 })
  }

  const companyName = String(form.get('company_name') ?? '').trim().slice(0, MAX_NAME_LEN)
  const founderName = String(form.get('founder_name') ?? '').trim().slice(0, MAX_NAME_LEN)
  const founderEmail = String(form.get('founder_email') ?? '').trim().toLowerCase().slice(0, MAX_EMAIL_LEN)
  const rawCompanyUrl = String(form.get('company_url') ?? '').trim().slice(0, MAX_URL_LEN)
  const introSource = String(form.get('intro_source') ?? '').trim().slice(0, MAX_NAME_LEN)
  const referrerName = String(form.get('referrer_name') ?? '').trim().slice(0, MAX_NAME_LEN)
  const referrerEmail = String(form.get('referrer_email') ?? '').trim().slice(0, MAX_EMAIL_LEN)
  const pitch = String(form.get('pitch') ?? '').trim().slice(0, MAX_PITCH_LEN)

  if (!companyName || !founderName || !founderEmail || !pitch) {
    return NextResponse.json({ error: 'company_name, founder_name, founder_email, and pitch are required' }, { status: 400 })
  }
  if (!EMAIL_RE.test(founderEmail)) {
    return NextResponse.json({ error: 'Invalid founder email' }, { status: 400 })
  }
  if (referrerEmail && !EMAIL_RE.test(referrerEmail)) {
    return NextResponse.json({ error: 'Invalid referrer email' }, { status: 400 })
  }

  // Validate and normalize the website URL — only http(s) accepted so we
  // don't store `javascript:` URLs that would later render as <a href>.
  let companyUrl = ''
  if (rawCompanyUrl) {
    const normalized = safeWebUrl(rawCompanyUrl)
    if (!normalized) {
      return NextResponse.json({ error: 'company_url must be a valid http(s) URL' }, { status: 400 })
    }
    companyUrl = normalized
  }

  // Collect file entries (FormData.getAll for 'files' returns all entries).
  const fileEntries = form.getAll('files').filter((v): v is File => v instanceof File && v.size > 0)
  if (fileEntries.length > MAX_FILES) {
    return NextResponse.json({ error: `At most ${MAX_FILES} files per submission` }, { status: 400 })
  }
  for (const f of fileEntries) {
    if (f.size > MAX_FILE_BYTES) {
      return NextResponse.json({ error: `${f.name} exceeds ${MAX_FILE_BYTES / (1024 * 1024)}MB` }, { status: 400 })
    }
    const safeName = sanitizeFilename(f.name || 'untitled')
    const typeErr = validateAttachmentType(safeName, f.type || 'application/octet-stream')
    if (typeErr) return NextResponse.json({ error: `${f.name}: ${typeErr.message}` }, { status: 400 })
  }

  // Build the synthetic payload. Compose pitch + referral metadata so the
  // analyzer sees the full context the partner would have included in an email.
  const subject = `Manual entry: ${companyName}`
  const bodyLines = [
    `Founder: ${founderName} <${founderEmail}>`,
    companyUrl ? `Website: ${companyUrl}` : null,
    introSource ? `Intro source: ${introSource.replace(/_/g, ' ')}` : null,
    referrerName ? `Referrer: ${referrerName}${referrerEmail ? ` <${referrerEmail}>` : ''}` : null,
    '',
    pitch,
  ].filter(Boolean) as string[]
  const composedBody = bodyLines.join('\n')

  // Load each file into a base64 attachment record matching the Postmark shape
  // the rest of the pipeline expects.
  const attachments: Array<{ Name: string; ContentType: string; Content: string; ContentLength: number }> = []
  for (const file of fileEntries) {
    const buf = Buffer.from(await file.arrayBuffer())
    attachments.push({
      Name: sanitizeFilename(file.name || 'untitled'),
      ContentType: file.type || 'application/octet-stream',
      Content: buf.toString('base64'),
      ContentLength: buf.length,
    })
  }

  const messageId = `<manual-${crypto.randomUUID()}@hemrock.local>`
  const payload: PostmarkPayload & { From: string; To: string; FromFull: { Email: string; Name: string }; Subject: string; MessageID: string } = {
    From: founderEmail,
    To: 'manual-entry@hemrock.local',
    FromFull: { Email: founderEmail, Name: founderName },
    Subject: subject,
    TextBody: composedBody,
    HtmlBody: '',
    MessageID: messageId,
    Attachments: attachments,
  }

  // Insert the inbound_emails row that the deal will FK to.
  const { data: emailInsert, error: emailErr } = await admin
    .from('inbound_emails')
    .insert({
      fund_id: fundId,
      from_address: founderEmail,
      subject,
      received_at: new Date().toISOString(),
      raw_payload: stripAttachmentContent(payload) as any,
      processing_status: 'processing',
      attachments_count: attachments.length,
      routing_label: 'deals',
      routing_confidence: 1.0,
      routing_reasoning: `Manual entry by ${user.email ?? user.id}`,
      routing_secondary_label: null,
      routed_to: 'deals',
    } as any)
    .select('id')
    .single()

  if (emailErr || !emailInsert) {
    console.error('[deals/manual] inbound_emails insert failed:', emailErr)
    return NextResponse.json({ error: 'Failed to create deal' }, { status: 500 })
  }
  const emailId = (emailInsert as { id: string }).id

  // Upload attachments to storage and rewrite the payload to reference
  // StoragePath instead of inline content (so the row stays compact).
  if (attachments.length > 0) {
    const updatedAttachments: Array<{ Name: string; ContentType: string; ContentLength: number; StoragePath: string }> = []
    for (let i = 0; i < attachments.length; i++) {
      const a = attachments[i]
      const safeName = `${i}_${a.Name}`
      const storagePath = `${emailId}/${safeName}`
      const buf = Buffer.from(a.Content, 'base64')
      const { error: uploadErr } = await admin.storage
        .from('email-attachments')
        .upload(storagePath, buf, { contentType: a.ContentType, upsert: true })
      if (!uploadErr) {
        updatedAttachments.push({
          Name: a.Name,
          ContentType: a.ContentType,
          ContentLength: a.ContentLength,
          StoragePath: storagePath,
        })
      }
    }
    if (updatedAttachments.length > 0) {
      const stripped = { ...stripAttachmentContent(payload), Attachments: updatedAttachments }
      await admin.from('inbound_emails').update({ raw_payload: stripped as any }).eq('id', emailId)
    }
  }

  // Run the analyzer. On failure, the inbound_email row is marked failed but
  // we still return the email_id so the admin can see it in /audit and retry.
  let dealId: string | null = null
  try {
    const { provider, model, providerType } = await getFeatureProvider(admin, fundId, 'deal_analysis')
    const extracted = await extractAttachmentText(payload)
    const result = await processDeal({
      supabase: admin,
      emailId,
      fundId,
      payload: payload as PipelinePayload,
      extracted,
      provider,
      providerType,
      model,
    })
    dealId = (result as any)?.dealId ?? null
    // Stamp the owning entity the submitter chose; the analyzer does not know it.
    if (dealId && vehicleId) {
      await admin.from('inbound_deals').update({ vehicle_id: vehicleId } as any).eq('id', dealId).eq('fund_id', fundId)
    }
    await admin
      .from('inbound_emails')
      .update({ processing_status: 'success' })
      .eq('id', emailId)
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Unknown error'
    console.error('[deals/manual] processDeal failed:', msg)
    await admin
      .from('inbound_emails')
      .update({ processing_status: 'failed', processing_error: msg })
      .eq('id', emailId)
    return NextResponse.json({ error: msg, email_id: emailId }, { status: 500 })
  }

  // Look up the created deal so the client can route to it directly.
  if (!dealId) {
    const { data: deal } = await admin
      .from('inbound_deals')
      .select('id')
      .eq('email_id', emailId)
      .eq('fund_id', fundId)
      .maybeSingle()
    dealId = (deal as any)?.id ?? null
  }

  return NextResponse.json({ ok: true, email_id: emailId, deal_id: dealId })
}

function stripAttachmentContent(payload: any) {
  if (!payload.Attachments) return payload
  return {
    ...payload,
    Attachments: payload.Attachments.map((a: any) => {
      const { Content, ...rest } = a
      return rest
    }),
  }
}
