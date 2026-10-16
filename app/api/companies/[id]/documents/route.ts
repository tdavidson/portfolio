import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { assertWriteAccess } from '@/lib/api-helpers'
import { registerCompanyDocument } from '@/lib/companies/documents'
import { outcomeResponse } from '@/lib/service-outcome'
import { dbError } from '@/lib/api-error'

// Large files need more time for download + security scan + text extraction
export const maxDuration = 60

// ---------------------------------------------------------------------------
// GET — List all documents for a company
// ---------------------------------------------------------------------------

export async function GET(req: NextRequest, props: { params: Promise<{ id: string }> }) {
  const params = await props.params;
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const admin = createAdminClient()

  // Verify user is a member of the fund that owns this company
  const { data: company } = await admin
    .from('companies')
    .select('id, fund_id')
    .eq('id', params.id)
    .maybeSingle()

  if (!company) return NextResponse.json({ error: 'Company not found' }, { status: 404 })

  const { data: membership } = await admin
    .from('fund_members')
    .select('id')
    .eq('fund_id', company.fund_id)
    .eq('user_id', user.id)
    .maybeSingle()

  if (!membership) return NextResponse.json({ error: 'Not found' }, { status: 404 })

  const { data: documents, error } = await admin
    .from('company_documents' as any)
    .select('id, filename, file_type, file_size, has_native_content, storage_path, extracted_text, created_at')
    .eq('company_id', params.id)
    .order('created_at', { ascending: false }) as { data: any[] | null; error: { message: string } | null }

  if (error) return dbError(error, 'companies-id-documents')

  // Tag uploaded documents with source
  const uploadDocs = (documents ?? []).map(({ storage_path, extracted_text, ...d }) => ({
    ...d,
    source: 'upload' as const,
    has_readable_content: !!extracted_text || !!storage_path,
  }))

  // Email history is the legacy view of reporting mail. Once a company has captured Company
  // Updates the page shows those instead (richer: extraction status, cleaned body, OCR), and asks
  // this route for uploads only.
  // emails=other → only mail whose effective route is NOT reporting (deals, interactions, …), so
  // a company page never loses sight of an email just because it isn't a reporting update.
  const emailMode = req.nextUrl.searchParams.get('emails') ?? 'all'
  let emailQuery = admin
    .from('inbound_emails')
    .select('id, from_address, subject, raw_payload, received_at, routed_to')
    .eq('company_id', params.id)
    .in('processing_status', ['success', 'needs_review'])
  if (emailMode === 'other') emailQuery = emailQuery.not('routed_to', 'is', null).neq('routed_to', 'reporting')
  const { data: emails } = emailMode === '0'
    ? { data: [] as any[] }
    : await emailQuery.order('received_at', { ascending: false }) as { data: any[] | null }

  const emailHistory: any[] = []
  for (const email of emails ?? []) {
    const payload = email.raw_payload as Record<string, unknown> | null
    if (!payload) continue
    const textBody = typeof payload.TextBody === 'string' ? payload.TextBody.trim() : ''
    if (textBody) {
      emailHistory.push({
        id: `email-body-${email.id}`,
        email_id: email.id,
        filename: email.subject || '(no subject)',
        file_type: 'message/rfc822',
        file_size: new TextEncoder().encode(textBody).length,
        created_at: email.received_at,
        source: 'email_body' as const,
        email_subject: email.subject,
        email_from: email.from_address,
        email_route: email.routed_to ?? 'reporting',
        text_content: textBody,
      })
    }
    const attachments = (payload.Attachments ?? []) as Array<{
      Name: string
      ContentType: string
      ContentLength: number
    }>
    for (let i = 0; i < attachments.length; i++) {
      const att = attachments[i]
      emailHistory.push({
        id: `email-${email.id}-${i}`,
        email_id: email.id,
        attachment_index: i,
        filename: att.Name,
        file_type: att.ContentType,
        file_size: att.ContentLength,
        created_at: email.received_at,
        source: 'email' as const,
        email_subject: email.subject,
        email_from: email.from_address,
        email_route: email.routed_to ?? 'reporting',
      })
    }
  }

  // With emails=other the reporting mail itself lives in the Updates section, but its attachments
  // are still documents: list every captured artifact flat, by id, with its extraction status.
  const artifactDocs: any[] = []
  if (emailMode === 'other') {
    const { data: artifacts } = await admin
      .from('company_update_artifacts' as any)
      .select('id, update_id, ordinal, filename, declared_content_type, detected_content_type, byte_size, storage_path, extraction_status, ocr_status, company_updates!inner(source_email_id, received_at, subject, sender_email)')
      .eq('company_id', params.id)
      .eq('fund_id', company.fund_id)
      .order('ordinal', { ascending: true }) as { data: any[] | null }
    for (const artifact of artifacts ?? []) {
      const update = artifact.company_updates
      artifactDocs.push({
        id: `artifact-${artifact.id}`,
        artifact_id: artifact.id,
        update_id: artifact.update_id,
        email_id: update?.source_email_id,
        filename: artifact.filename,
        file_type: artifact.detected_content_type ?? artifact.declared_content_type ?? 'application/octet-stream',
        file_size: artifact.byte_size ?? 0,
        created_at: update?.received_at ?? null,
        source: 'update_attachment' as const,
        email_subject: update?.subject ?? null,
        email_from: update?.sender_email ?? null,
        email_route: 'reporting',
        extraction_status: artifact.extraction_status,
        ocr_status: artifact.ocr_status,
        has_source_file: Boolean(artifact.storage_path),
      })
    }
  }

  // Combine and sort by date descending
  const combined = [...uploadDocs, ...emailHistory, ...artifactDocs].sort(
    (a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime()
  )

  return NextResponse.json({ documents: combined })
}

// ---------------------------------------------------------------------------
// POST — Register an uploaded document and extract text
// ---------------------------------------------------------------------------

export async function POST(req: NextRequest, props: { params: Promise<{ id: string }> }) {
  const params = await props.params;
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const admin = createAdminClient()

  const writeCheck = await assertWriteAccess(admin, user.id)
  if (writeCheck instanceof NextResponse) return writeCheck

  // Verify company exists and user is a fund member
  const { data: company } = await admin
    .from('companies')
    .select('id, fund_id')
    .eq('id', params.id)
    .maybeSingle()

  if (!company) return NextResponse.json({ error: 'Company not found' }, { status: 404 })

  const { data: membership } = await supabase
    .from('fund_members')
    .select('role')
    .eq('fund_id', company.fund_id)
    .eq('user_id', user.id)
    .maybeSingle()

  if (!membership) return NextResponse.json({ error: 'Not a fund member' }, { status: 403 })

  const body = await req.json()
  const { storagePath, filename, fileType, fileSize, textOnly } = body

  // Scan, extract and record: lib/companies/documents.ts, the same steps `add_company_document`
  // runs for a file uploaded from chat.
  return outcomeResponse(await registerCompanyDocument(admin, { fundId: company.fund_id, userId: user.id }, params.id, {
    storagePath, filename, fileType, fileSize, textOnly,
  }))
}
