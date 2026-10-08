import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { entityDocumentsGate } from '@/lib/entity-documents/http'
import { documentStoragePath, ENTITY_DOCUMENT_BUCKET, MAX_ENTITY_DOCUMENT_BYTES } from '@/lib/entity-documents'

/**
 * POST { file_name, size_bytes } → a signed URL the browser uploads to directly (past the serverless
 * body limit). The server picks the path, inside this fund's and entity's folder.
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
  const fileName = typeof body.file_name === 'string' && body.file_name.trim() ? body.file_name.trim() : 'document'
  if (Number(body.size_bytes) > MAX_ENTITY_DOCUMENT_BYTES) return NextResponse.json({ error: 'Files can be up to 25 MB.' }, { status: 400 })
  const path = documentStoragePath(gate.fundId, id, fileName)
  const { data, error } = await (admin as any).storage.from(ENTITY_DOCUMENT_BUCKET).createSignedUploadUrl(path)
  if (error || !data) return NextResponse.json({ error: 'Could not start the upload' }, { status: 500 })
  return NextResponse.json({ storage_path: path, signed_url: data.signedUrl, token: data.token })
}
