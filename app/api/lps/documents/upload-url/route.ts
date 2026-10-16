import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { assertWriteAccess } from '@/lib/api-helpers'
import { createLpDocumentUploadUrl } from '@/lib/lps/documents'

/**
 * Admin-only: issue a signed upload URL for an LP document. The browser uploads
 * the file directly to Storage (bypassing the serverless body limit), then calls
 * POST /api/lps/documents with { storage_path, ...metadata }. The server owns the
 * path so the browser can't write outside the fund's folder. `lp_document_upload_url`
 * mints the same URL from chat (lib/lps/documents.ts).
 */
export async function POST(req: NextRequest) {
  const supabase = await createClient()
  const admin = createAdminClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const writeCheck = await assertWriteAccess(admin, user.id)
  if (writeCheck instanceof NextResponse) return writeCheck
  if (writeCheck.role !== 'admin') return NextResponse.json({ error: 'Admin access required' }, { status: 403 })

  const body = await req.json().catch(() => ({}))
  const rawName = typeof body.file_name === 'string' ? body.file_name : ''
  const minted = await createLpDocumentUploadUrl(admin, writeCheck.fundId, rawName)
  if (!minted.ok) return NextResponse.json({ error: minted.error }, { status: minted.status })

  return NextResponse.json({ storage_path: minted.value.storagePath, token: minted.value.token, signed_url: minted.value.signedUrl })
}
