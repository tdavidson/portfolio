import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { assertWriteAccess, assertReadAccess } from '@/lib/api-helpers'
import { dbError } from '@/lib/api-error'
import { recordLpDocument } from '@/lib/lps/documents'
import { outcomeResponse } from '@/lib/service-outcome'
import { loadLpScope, lpVisible } from '@/lib/access/lp-scope'

/**
 * Admin-only LP document management (gap 2).
 *
 *   GET  → the fund's documents (with their per-investor assignments).
 *   POST { title, file_name, storage_path, mime_type?, size_bytes?, scope, lp_investor_ids?, vehicle?, index? }
 *        → record an uploaded file. scope 'fund' = all LPs; 'investor' = the
 *          listed investors only (verified to belong to this fund); 'vehicle' =
 *          every investor in the named investment vehicle (portfolio_group),
 *          resolved now and stored as an investor share tagged with the vehicle.
 *   DELETE ?id=... → remove the row, its shares, and the storage object.
 */

export async function GET() {
  const supabase = await createClient()
  const admin = createAdminClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const access = await assertReadAccess(admin, user.id)
  if (access instanceof NextResponse) return access

  const { data: docs, error } = await (admin as any)
    .from('lp_documents')
    .select('id, title, file_name, mime_type, size_bytes, scope, vehicle, category, doc_date, uploaded_at, lp_document_shares(lp_investor_id, lp_investors(name))')
    .eq('fund_id', access.fundId)
    .order('uploaded_at', { ascending: false })
  if (error) return dbError(error, 'lps-documents')
  // Fund-wide documents, and those shared with an investor the caller can see — naming only those
  // investors. Same rule as the lp_documents policy (20261007100300).
  const lp = await loadLpScope(admin, access)
  const documents = ((docs as any[]) ?? [])
    .map(d => ({ ...d, lp_document_shares: (d.lp_document_shares ?? []).filter((s: any) => lpVisible(lp.investorIds, s.lp_investor_id)) }))
    .filter(d => lp.investorIds === null || d.scope === 'fund'
      || (d.lp_document_shares.length > 0 && (!d.vehicle || lp.scope.vehicleNames === null || lp.scope.vehicleNames.includes(d.vehicle))))
  return NextResponse.json({ documents })
}

export async function POST(req: NextRequest) {
  const supabase = await createClient()
  const admin = createAdminClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const writeCheck = await assertWriteAccess(admin, user.id)
  if (writeCheck instanceof NextResponse) return writeCheck
  if (writeCheck.role !== 'admin') return NextResponse.json({ error: 'Admin access required' }, { status: 403 })

  // Record, share as scoped, scan and index: lib/lps/documents.ts, which `lp_add_document` calls too.
  const body = await req.json().catch(() => ({}))
  return outcomeResponse(await recordLpDocument(admin, { fundId: writeCheck.fundId, userId: user.id }, body))
}

export async function DELETE(req: NextRequest) {
  const supabase = await createClient()
  const admin = createAdminClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const writeCheck = await assertWriteAccess(admin, user.id)
  if (writeCheck instanceof NextResponse) return writeCheck
  if (writeCheck.role !== 'admin') return NextResponse.json({ error: 'Admin access required' }, { status: 403 })

  const id = new URL(req.url).searchParams.get('id') ?? ''
  if (!id) return NextResponse.json({ error: 'id is required' }, { status: 400 })

  const { data: doc } = await (admin as any)
    .from('lp_documents').select('id, storage_path').eq('id', id).eq('fund_id', writeCheck.fundId).maybeSingle()
  if (!doc) return NextResponse.json({ error: 'Not found' }, { status: 404 })

  await admin.storage.from('lp-documents').remove([doc.storage_path]).catch(() => {})
  const { error } = await (admin as any).from('lp_documents').delete().eq('id', id).eq('fund_id', writeCheck.fundId)
  if (error) return dbError(error, 'lps-documents')
  return NextResponse.json({ ok: true })
}
