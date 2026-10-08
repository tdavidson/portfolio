import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { entityDocumentsGate } from '@/lib/entity-documents/http'
import { ENTITY_DOCUMENT_BUCKET, getDocument } from '@/lib/entity-documents'

/** GET → a short-lived signed link to the original file (?inline=1 to view a PDF in the browser). */
export async function GET(req: NextRequest, props: { params: Promise<{ id: string; docId: string }> }) {
  const { id, docId } = await props.params
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  const admin = createAdminClient()
  const gate = await entityDocumentsGate(admin, user.id, id, 'read')
  if (gate instanceof NextResponse) return gate
  const doc = await getDocument(admin, gate.fundId, docId, [id])
  if (!doc) return NextResponse.json({ error: 'Not found' }, { status: 404 })

  const inline = req.nextUrl.searchParams.get('inline') === '1' && doc.content_type === 'application/pdf'
  const downloadName = doc.file_name.replace(/[^\w.\-]/g, '_').slice(0, 200)
  const { data, error } = await (admin as any).storage.from(ENTITY_DOCUMENT_BUCKET)
    .createSignedUrl(doc.storage_path, 60, inline ? undefined : { download: downloadName })
  if (error || !data) return NextResponse.json({ error: 'Could not sign the link' }, { status: 500 })
  return NextResponse.redirect(data.signedUrl, 302)
}
