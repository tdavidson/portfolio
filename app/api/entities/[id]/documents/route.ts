import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { logActivity } from '@/lib/activity'
import { entityDocumentsGate } from '@/lib/entity-documents/http'
import { ingestDocument, isDocumentKind, listDocuments, pathBelongsTo } from '@/lib/entity-documents'

export const maxDuration = 120

/** GET — the entity's governing documents. */
export async function GET(_req: NextRequest, props: { params: Promise<{ id: string }> }) {
  const { id } = await props.params
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  const admin = createAdminClient()
  const gate = await entityDocumentsGate(admin, user.id, id, 'read')
  if (gate instanceof NextResponse) return gate
  return NextResponse.json(await listDocuments(admin, gate.fundId, [id]))
}

/**
 * POST { storage_path, file_name, content_type, kind, title, effective_date } — record a file the
 * browser uploaded to the signed URL from ./upload-url: scan it, read its text, index it.
 */
export async function POST(req: NextRequest, props: { params: Promise<{ id: string }> }) {
  const { id } = await props.params
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  const admin = createAdminClient()
  const gate = await entityDocumentsGate(admin, user.id, id, 'write')
  if (gate instanceof NextResponse) return gate

  const body = await req.json().catch(() => ({}))
  const storagePath = typeof body.storage_path === 'string' ? body.storage_path : ''
  if (!pathBelongsTo(storagePath, gate.fundId, id)) return NextResponse.json({ error: 'Invalid upload' }, { status: 400 })
  const fileName = typeof body.file_name === 'string' && body.file_name.trim() ? body.file_name.trim().slice(0, 255) : 'document'
  const kind = isDocumentKind(body.kind) ? body.kind : 'other'
  const title = typeof body.title === 'string' && body.title.trim() ? body.title.trim().slice(0, 200) : fileName
  const effectiveDate = typeof body.effective_date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(body.effective_date) ? body.effective_date : null

  const result = await ingestDocument(admin, {
    fundId: gate.fundId, vehicleId: id, storagePath, fileName,
    contentType: typeof body.content_type === 'string' ? body.content_type : null,
    kind, title, effectiveDate, uploadedBy: user.id,
  })
  if ('error' in result) return NextResponse.json({ error: result.error }, { status: result.status })
  logActivity(admin, gate.fundId, user.id, 'entity_document.upload', { vehicleId: id, documentId: result.document.id, kind })
  return NextResponse.json(result.document, { status: 201 })
}
