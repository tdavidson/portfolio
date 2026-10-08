import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { dbError } from '@/lib/api-error'
import { logActivity } from '@/lib/activity'
import { entityDocumentsGate } from '@/lib/entity-documents/http'
import { ENTITY_DOCUMENT_BUCKET, getDocument, isDocumentKind } from '@/lib/entity-documents'

/** PATCH { kind?, title?, effective_date? } — re-file a document. */
export async function PATCH(req: NextRequest, props: { params: Promise<{ id: string; docId: string }> }) {
  const { id, docId } = await props.params
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  const admin = createAdminClient()
  const gate = await entityDocumentsGate(admin, user.id, id, 'write')
  if (gate instanceof NextResponse) return gate
  if (!(await getDocument(admin, gate.fundId, docId, [id]))) return NextResponse.json({ error: 'Not found' }, { status: 404 })

  const body = await req.json().catch(() => ({}))
  const updates: Record<string, unknown> = {}
  if (body.kind !== undefined) {
    if (!isDocumentKind(body.kind)) return NextResponse.json({ error: 'Unknown document type' }, { status: 400 })
    updates.kind = body.kind
  }
  if (typeof body.title === 'string' && body.title.trim()) updates.title = body.title.trim().slice(0, 200)
  if (body.effective_date !== undefined) {
    if (body.effective_date !== null && !(typeof body.effective_date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(body.effective_date))) {
      return NextResponse.json({ error: 'effective_date must be YYYY-MM-DD' }, { status: 400 })
    }
    updates.effective_date = body.effective_date
  }
  if (Object.keys(updates).length === 0) return NextResponse.json({ error: 'Nothing to update' }, { status: 400 })
  const { error } = await (admin as any).from('entity_documents')
    .update({ ...updates, updated_at: new Date().toISOString() }).eq('id', docId).eq('fund_id', gate.fundId)
  if (error) return dbError(error, 'entity-documents')
  return NextResponse.json({ ok: true })
}

/** DELETE — remove a document and its file. */
export async function DELETE(_req: NextRequest, props: { params: Promise<{ id: string; docId: string }> }) {
  const { id, docId } = await props.params
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  const admin = createAdminClient()
  const gate = await entityDocumentsGate(admin, user.id, id, 'write')
  if (gate instanceof NextResponse) return gate
  const doc = await getDocument(admin, gate.fundId, docId, [id])
  if (!doc) return NextResponse.json({ error: 'Not found' }, { status: 404 })

  const { error } = await (admin as any).from('entity_documents').delete().eq('id', docId).eq('fund_id', gate.fundId)
  if (error) return dbError(error, 'entity-documents')
  await (admin as any).storage.from(ENTITY_DOCUMENT_BUCKET).remove([doc.storage_path])
  logActivity(admin, gate.fundId, user.id, 'entity_document.delete', { vehicleId: id, documentId: docId, title: doc.title })
  return NextResponse.json({ ok: true })
}
