import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { createDiligenceUploadUrl } from '@/lib/diligence/service'

/**
 * Issue a signed upload URL for a diligence document. The browser uses this
 * to upload the file directly to Supabase Storage, bypassing Vercel's ~4.5 MB
 * serverless function body limit. After upload succeeds, the client calls
 * `POST /api/diligence/[id]/documents` with `{ storage_path, file_name,
 * file_size_bytes, content_type }` to record the row.
 *
 * Server picks the storage path so the browser can't write outside the
 * deal's folder. `diligence_document_upload_url` mints the same URL from chat.
 */
export async function POST(req: NextRequest, props: { params: Promise<{ id: string }> }) {
  const params = await props.params;
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

  // Verify the deal belongs to this fund before minting an upload URL.
  const { data: deal } = await admin
    .from('diligence_deals')
    .select('id')
    .eq('id', params.id)
    .eq('fund_id', fundId)
    .maybeSingle()
  if (!deal) return NextResponse.json({ error: 'Not found' }, { status: 404 })

  const body = await req.json().catch(() => ({}))
  const rawName = typeof body.file_name === 'string' ? body.file_name : ''
  const minted = await createDiligenceUploadUrl(admin, params.id, rawName)
  if (!minted.ok) return NextResponse.json({ error: minted.error }, { status: minted.status })

  return NextResponse.json({
    storage_path: minted.value.storagePath,
    token: minted.value.token,
    signed_url: minted.value.signedUrl,
  })
}
