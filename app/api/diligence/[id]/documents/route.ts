import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { dbError } from '@/lib/api-error'
import { MAX_DILIGENCE_DOCUMENT_BYTES, registerUploadedDiligenceDocument, uploadDiligenceDocument } from '@/lib/diligence/service'
import { outcomeResponse } from '@/lib/service-outcome'

export async function GET(_req: NextRequest, props: { params: Promise<{ id: string }> }) {
  const params = await props.params;
  const guard = await ensureMember()
  if ('error' in guard) return guard.error
  const { admin, fundId } = guard

  // Verify deal belongs to fund first.
  const { data: deal } = await admin
    .from('diligence_deals')
    .select('id')
    .eq('id', params.id)
    .eq('fund_id', fundId)
    .maybeSingle()
  if (!deal) return NextResponse.json({ error: 'Not found' }, { status: 404 })

  const { data, error } = await admin
    .from('diligence_documents')
    .select('id, deal_id, fund_id, storage_path, file_name, file_format, file_size_bytes, detected_type, type_confidence, parse_status, parse_notes, drive_file_id, drive_source_url, uploaded_by, uploaded_at')
    .eq('deal_id', params.id)
    .eq('fund_id', fundId)
    .order('uploaded_at', { ascending: false })

  if (error) return dbError(error, 'diligence-documents-list')
  return NextResponse.json(data ?? [])
}

export async function POST(req: NextRequest, props: { params: Promise<{ id: string }> }) {
  const params = await props.params;
  const guard = await ensureMember()
  if ('error' in guard) return guard.error
  const { admin, fundId, userId } = guard

  // Verify deal.
  const { data: deal } = await admin
    .from('diligence_deals')
    .select('id')
    .eq('id', params.id)
    .eq('fund_id', fundId)
    .maybeSingle()
  if (!deal) return NextResponse.json({ error: 'Not found' }, { status: 404 })

  // Two acceptance modes:
  //   1. multipart/form-data with `file` — legacy small-upload path (≤4.5 MB
  //      due to Vercel's serverless body limit). Kept for backwards compat.
  //   2. JSON with `storage_path` — the file was already uploaded directly to
  //      Supabase Storage via a signed URL minted by `/upload-url`. No file
  //      body transits Vercel, so this path works for the full 100 MB bucket.
  // Both end in lib/diligence/service.ts (scan, classify, record, queue a transcription), the same
  // steps `diligence_add_documents` runs for a file uploaded from chat.
  const contentType = req.headers.get('content-type') ?? ''

  if (contentType.includes('application/json')) {
    const body = await req.json().catch(() => ({}))
    if (typeof body.storage_path !== 'string') {
      return NextResponse.json({ error: 'storage_path is required' }, { status: 400 })
    }
    return outcomeResponse(await registerUploadedDiligenceDocument(admin, { fundId, userId }, params.id, {
      storagePath: body.storage_path,
      fileName: typeof body.file_name === 'string' ? body.file_name : null,
      contentType: typeof body.content_type === 'string' ? body.content_type : null,
    }))
  }

  // Legacy multipart path for files under Vercel's body limit.
  let formData: FormData
  try {
    formData = await req.formData()
  } catch {
    return NextResponse.json({ error: 'Expected multipart/form-data or application/json' }, { status: 400 })
  }

  const file = formData.get('file')
  if (!(file instanceof File)) {
    return NextResponse.json({ error: 'file is required' }, { status: 400 })
  }
  if (file.size > MAX_DILIGENCE_DOCUMENT_BYTES) {
    return NextResponse.json({ error: 'File exceeds 100 MB limit' }, { status: 400 })
  }
  if (file.size === 0) {
    return NextResponse.json({ error: 'Empty file' }, { status: 400 })
  }
  return outcomeResponse(await uploadDiligenceDocument(admin, { fundId, userId }, params.id, {
    name: file.name, mime: file.type || 'application/octet-stream', bytes: Buffer.from(await file.arrayBuffer()),
  }))
}

// ---------------------------------------------------------------------------

async function ensureMember() {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return { error: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }) }
  const admin = createAdminClient()
  const { data: membership } = await admin
    .from('fund_members')
    .select('fund_id, role')
    .eq('user_id', user.id)
    .maybeSingle()
  if (!membership) return { error: NextResponse.json({ error: 'No fund found' }, { status: 403 }) }
  return {
    admin,
    fundId: (membership as any).fund_id as string,
    userId: user.id,
    role: (membership as any).role as string,
  }
}
