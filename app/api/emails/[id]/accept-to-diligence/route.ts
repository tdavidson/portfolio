import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { classifyDocumentHeuristic } from '@/lib/memo-agent/heuristic-classify'
import { enqueueIngestForDocuments } from '@/lib/diligence/enqueue-ingest'
import { scanFileAsync } from '@/lib/security/scan-file'
import type { PostmarkPayload } from '@/lib/pipeline/processEmail'
import { loadEntityScopeForUser } from '@/lib/access/entity-scope'
import { canSeeVehicle } from '@/lib/access/scope'

/**
 * Accept an inbound email into a diligence deal's data room.
 *
 * The inbound router only ever *proposes* a match (diligence_intake_status =
 * 'pending'). This endpoint is the human's decision, and it is the only path
 * that writes email content into `diligence_documents` — so a mis-routed email
 * can never become memo evidence on its own.
 *
 * The caller chooses:
 *   deal_id            — override the router's guess with any active deal
 *   attachment_indexes — which attachments to take (default: all)
 *   include_body       — file the email text itself as a document (default: true)
 *
 * POST   = accept
 * DELETE = reject (never offered again)
 */

export const maxDuration = 120

const MAX_BYTES = 100 * 1024 * 1024  // diligence-documents bucket cap

export async function POST(req: NextRequest, props: { params: Promise<{ id: string }> }) {
  const params = await props.params;
  const guard = await ensureMember()
  if ('error' in guard) return guard.error
  const { admin, fundId, userId } = guard

  const { data: email } = await admin
    .from('inbound_emails')
    .select('id, subject, from_address, received_at, raw_payload, diligence_deal_id, diligence_intake_status')
    .eq('id', params.id)
    .eq('fund_id', fundId)
    .maybeSingle()
  if (!email) return NextResponse.json({ error: 'Not found' }, { status: 404 })

  if ((email as any).diligence_intake_status === 'accepted') {
    return NextResponse.json({ error: 'This email has already been added to a data room.' }, { status: 409 })
  }

  const body = await req.json().catch(() => ({}))

  // The reviewer may override the router's guess — that's the whole point of the
  // approval step.
  const dealId = typeof body.deal_id === 'string' && body.deal_id
    ? body.deal_id
    : (email as any).diligence_deal_id as string | null
  if (!dealId) {
    return NextResponse.json({ error: 'deal_id is required — no deal was matched for this email.' }, { status: 400 })
  }

  // Only into one of the caller's entities' data rooms — the router matches against every active
  // record, and the request may name any. '*': vehicle_id exists once the entity migration has run.
  const { data: deal } = await admin
    .from('diligence_deals')
    .select('*')
    .eq('id', dealId)
    .eq('fund_id', fundId)
    .maybeSingle()
  const scope = await loadEntityScopeForUser(admin, userId)
  if (!deal || !scope || !canSeeVehicle(scope.access, (deal as any).vehicle_id ?? null)) {
    return NextResponse.json({ error: 'Diligence deal not found' }, { status: 404 })
  }

  const payload = ((email as any).raw_payload ?? {}) as PostmarkPayload
  const attachments = payload.Attachments ?? []

  // Default: take everything. An explicit list lets the reviewer drop signatures,
  // logos, and tracking pixels that would otherwise pollute the evidence base.
  const selected: number[] = Array.isArray(body.attachment_indexes)
    ? (body.attachment_indexes as unknown[])
        .map(Number)
        .filter(n => Number.isInteger(n) && n >= 0 && n < attachments.length)
    : attachments.map((_, i) => i)

  const includeBody = body.include_body !== false

  const documentIds: string[] = []
  const imported: string[] = []
  const skipped: Array<{ item: string; reason: string }> = []

  // --- The email text itself ------------------------------------------------
  if (includeBody) {
    const md = renderEmailAsMarkdown(email as any, payload)
    const bytes = Buffer.from(md, 'utf-8')
    const dateStr = ((email as any).received_at ?? '').slice(0, 10) || 'undated'
    const subjectSafe = ((email as any).subject ?? 'No subject')
      .replace(/[\x00-\x1f\x7f\/\\:*?"<>|]/g, '_')
      .slice(0, 80)
    const fileName = `Email ${dateStr} — ${subjectSafe}.md`
    const storagePath = `${dealId}/${Date.now()}_email_${(email as any).id.slice(0, 8)}.md`

    const { error: upErr } = await admin.storage
      .from('diligence-documents')
      .upload(storagePath, bytes, { contentType: 'text/markdown', upsert: false })

    if (upErr) {
      skipped.push({ item: fileName, reason: upErr.message })
    } else {
      const { data: row, error: insErr } = await admin
        .from('diligence_documents')
        .insert({
          deal_id: dealId,
          fund_id: fundId,
          storage_path: storagePath,
          file_name: fileName,
          file_format: 'md',
          file_size_bytes: bytes.length,
          // Let the agent's ingest stage classify it authoritatively.
          detected_type: 'other',
          type_confidence: 'low',
          parse_status: 'pending',
          source_kind: 'email',
          source_email_id: (email as any).id,
          uploaded_by: userId,
        } as any)
        .select('id')
        .single()

      if (insErr) {
        await admin.storage.from('diligence-documents').remove([storagePath]).catch(() => {})
        skipped.push({ item: fileName, reason: insErr.message })
      } else {
        documentIds.push((row as any).id as string)
        imported.push(fileName)
      }
    }
  }

  // --- Attachments ----------------------------------------------------------
  for (const index of selected) {
    const att = attachments[index]
    if (!att) continue
    const label = att.Name || `attachment_${index}`

    try {
      // Attachments live in the email-attachments bucket (Content is stripped
      // from raw_payload at receive time). Legacy rows may still carry inline
      // base64 — handle both.
      let bytes: Buffer | null = null
      if (att.StoragePath) {
        const { data, error } = await admin.storage
          .from('email-attachments')
          .download(att.StoragePath)
        if (error || !data) {
          skipped.push({ item: label, reason: 'could not download from storage' })
          continue
        }
        bytes = Buffer.from(await data.arrayBuffer())
      } else if (att.Content) {
        bytes = Buffer.from(att.Content, 'base64')
      }

      if (!bytes || bytes.length === 0) {
        skipped.push({ item: label, reason: 'empty attachment' })
        continue
      }
      if (bytes.length > MAX_BYTES) {
        skipped.push({ item: label, reason: 'exceeds the 100 MB data-room limit' })
        continue
      }

      const safeName = label
        .replace(/[\x00-\x1f\x7f\/\\:*?"<>|]/g, '_')
        .replace(/\.\./g, '_')
        .slice(0, 200) || `attachment_${index}`
      const ext = (safeName.match(/\.([a-z0-9]+)$/i)?.[1] ?? 'bin').toLowerCase()
      const keySafe = safeName.replace(/[^a-zA-Z0-9._-]/g, '_')
      const mime = att.ContentType || 'application/octet-stream'
      const storagePath = `${dealId}/${Date.now()}_email_${index}_${keySafe}`

      // Defense-in-depth: these bytes come from email-attachments, which are scanned at inbound
      // time — but re-scan before they enter the diligence bucket so this path can't silently
      // become a gap if that upstream ever changes.
      const scan = await scanFileAsync(bytes, safeName, mime)
      if (!scan.safe) {
        skipped.push({ item: label, reason: `rejected by file scan (${scan.reason ?? 'unsafe'})` })
        continue
      }

      const { error: upErr } = await admin.storage
        .from('diligence-documents')
        .upload(storagePath, bytes, { contentType: mime, upsert: false })
      if (upErr) {
        skipped.push({ item: label, reason: upErr.message })
        continue
      }

      const { detected_type, confidence } = classifyDocumentHeuristic(safeName, mime)

      const { data: row, error: insErr } = await admin
        .from('diligence_documents')
        .insert({
          deal_id: dealId,
          fund_id: fundId,
          storage_path: storagePath,
          file_name: safeName,
          file_format: ext,
          file_size_bytes: bytes.length,
          detected_type,
          type_confidence: confidence,
          parse_status: 'pending',
          source_kind: 'email',
          source_email_id: (email as any).id,
          uploaded_by: userId,
        } as any)
        .select('id')
        .single()

      if (insErr) {
        await admin.storage.from('diligence-documents').remove([storagePath]).catch(() => {})
        skipped.push({ item: label, reason: insErr.message })
        continue
      }

      documentIds.push((row as any).id as string)
      imported.push(safeName)

      // A recording needs transcription before it's usable as evidence — same
      // rule the direct-upload path applies.
      if (detected_type === 'call_recording') {
        const { data: activeJob } = await admin
          .from('memo_agent_jobs')
          .select('id')
          .eq('deal_id', dealId)
          .eq('fund_id', fundId)
          .in('status', ['pending', 'running'])
          .limit(1)
          .maybeSingle()
        if (!activeJob) {
          await admin.from('memo_agent_jobs').insert({
            fund_id: fundId,
            deal_id: dealId,
            kind: 'transcribe',
            payload: { document_id: (row as any).id },
            enqueued_by: userId,
          } as any)
        }
      }
    } catch (err) {
      skipped.push({ item: label, reason: err instanceof Error ? err.message : 'unknown error' })
    }
  }

  if (documentIds.length === 0) {
    return NextResponse.json(
      { error: 'Nothing was imported.', skipped },
      { status: 400 }
    )
  }

  // Mark the proposal resolved and clear it out of the review queue.
  await admin
    .from('inbound_emails')
    .update({
      routed_to: 'diligence',
      diligence_deal_id: dealId,
      diligence_intake_status: 'accepted',
      diligence_accepted_at: new Date().toISOString(),
      diligence_accepted_by: userId,
      processing_status: 'success',
    } as any)
    .eq('id', params.id)

  await admin
    .from('parsing_reviews')
    .delete()
    .eq('email_id', params.id)
    .eq('issue_type', 'diligence_intake_pending')

  const ingest = await enqueueIngestForDocuments(admin, {
    fundId,
    dealId,
    documentIds,
    enqueuedBy: userId,
  })

  return NextResponse.json({
    accepted: true,
    deal: { id: dealId, name: (deal as any).name },
    imported,
    skipped,
    document_ids: documentIds,
    ingest_queued: ingest.enqueued,
    ingest_note: ingest.enqueued ? null : ingest.reason,
  })
}

export async function DELETE(_req: NextRequest, props: { params: Promise<{ id: string }> }) {
  const params = await props.params;
  const guard = await ensureMember()
  if ('error' in guard) return guard.error
  const { admin, fundId } = guard

  const { data: email } = await admin
    .from('inbound_emails')
    .select('id')
    .eq('id', params.id)
    .eq('fund_id', fundId)
    .maybeSingle()
  if (!email) return NextResponse.json({ error: 'Not found' }, { status: 404 })

  await admin
    .from('inbound_emails')
    .update({
      diligence_intake_status: 'rejected',
      processing_status: 'not_processed',
    } as any)
    .eq('id', params.id)

  await admin
    .from('parsing_reviews')
    .delete()
    .eq('email_id', params.id)
    .eq('issue_type', 'diligence_intake_pending')

  return NextResponse.json({ rejected: true })
}

/**
 * The email as a data-room document. The header carries who sent it and when —
 * without that, a claim extracted from this text traces back to "an email" with
 * no way to tell the founder's own words from a third party's.
 */
function renderEmailAsMarkdown(
  email: { subject: string | null; from_address: string | null; received_at: string | null },
  payload: PostmarkPayload
): string {
  const bodyText = payload.TextBody
    || (payload.HtmlBody ? htmlToText(payload.HtmlBody) : '')
    || '(no body)'

  const attachmentList = (payload.Attachments ?? []).map(a => `- ${a.Name} (${a.ContentType})`).join('\n')

  return [
    `# Email — ${email.subject ?? 'No subject'}`,
    '',
    `- **Source:** inbound email`,
    `- **From:** ${payload.FromFull?.Name ? `${payload.FromFull.Name} <${payload.FromFull.Email}>` : email.from_address ?? 'unknown'}`,
    `- **Received:** ${email.received_at ?? 'unknown'}`,
    ...(attachmentList ? ['', '**Attachments:**', attachmentList] : []),
    '',
    '---',
    '',
    bodyText.trim(),
    '',
  ].join('\n')
}

function htmlToText(html: string): string {
  return html
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|li|h[1-6]|tr)>/gi, '\n')
    .replace(/<li[^>]*>/gi, '- ')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

async function ensureMember() {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return { error: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }) }
  const admin = createAdminClient()
  const { data: membership } = await admin
    .from('fund_members')
    .select('fund_id')
    .eq('user_id', user.id)
    .maybeSingle()
  if (!membership) return { error: NextResponse.json({ error: 'No fund found' }, { status: 403 }) }
  return { admin, fundId: (membership as any).fund_id as string, userId: user.id }
}
