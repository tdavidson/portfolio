import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { assertWriteAccess, assertReadAccess } from '@/lib/api-helpers'
import { dbError } from '@/lib/api-error'
import { extractFromBuffer } from '@/lib/parsing/extractAttachmentText'
import { scanFile } from '@/lib/security/scan-file'
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
  const fundId = writeCheck.fundId

  const body = await req.json().catch(() => ({}))
  const title = typeof body.title === 'string' ? body.title.trim() : ''
  const fileName = typeof body.file_name === 'string' ? body.file_name.trim() : ''
  const storagePath = typeof body.storage_path === 'string' ? body.storage_path : ''
  // Requested scope from the client: 'fund' (all fund LPs), 'investor' (hand-
  // picked), or 'vehicle' (everyone in a chosen investment vehicle). A vehicle
  // document is stored as an investor-scoped document whose recipients are
  // resolved from the vehicle now, so access is enforced by the same
  // lp_document_shares path (and stays stable if the vehicle is later renamed).
  const requestedScope = body.scope === 'investor' ? 'investor' : body.scope === 'vehicle' ? 'vehicle' : 'fund'
  const requestedInvestorIds: string[] = Array.isArray(body.lp_investor_ids) ? body.lp_investor_ids.filter((x: unknown): x is string => typeof x === 'string') : []

  if (!title || !fileName || !storagePath) return NextResponse.json({ error: 'title, file_name and storage_path are required' }, { status: 400 })
  // The path must be inside this fund's folder (the upload-url route guarantees this).
  if (!storagePath.startsWith(`${fundId}/`)) return NextResponse.json({ error: 'Invalid storage path' }, { status: 400 })

  // The stored scope is 'fund' or 'investor'; a vehicle share is an investor
  // share tagged with the vehicle name for display.
  const scope: 'fund' | 'investor' = requestedScope === 'fund' ? 'fund' : 'investor'
  let vehicle: string | null = null
  let investorIds: string[] = []

  if (requestedScope === 'investor') {
    const { data: valid } = await (admin as any)
      .from('lp_investors').select('id').eq('fund_id', fundId)
      .in('id', requestedInvestorIds.length ? requestedInvestorIds : ['00000000-0000-0000-0000-000000000000'])
    investorIds = (valid ?? []).map((r: any) => r.id)
    if (investorIds.length === 0) return NextResponse.json({ error: 'Select at least one investor for an investor-scoped document' }, { status: 400 })
  } else if (requestedScope === 'vehicle') {
    vehicle = typeof body.vehicle === 'string' ? body.vehicle.trim() : ''
    if (!vehicle) return NextResponse.json({ error: 'Select an investment vehicle' }, { status: 400 })
    // Resolve every investor with a position in this vehicle, across all
    // snapshots (the same investor may recur; dedupe).
    const { data: rows } = await (admin as any)
      .from('lp_investments')
      .select('lp_entities!inner(investor_id)')
      .eq('fund_id', fundId)
      .eq('portfolio_group', vehicle)
    investorIds = Array.from(new Set(
      ((rows ?? []) as any[]).map(r => r.lp_entities?.investor_id as string | undefined).filter((x): x is string => !!x)
    ))
    if (investorIds.length === 0) return NextResponse.json({ error: 'No investors are in that vehicle' }, { status: 400 })
  }

  // Scanned before it is recorded, like every other inbound file; a hit is deleted.
  {
    const { data: uploaded } = await admin.storage.from('lp-documents').download(storagePath)
    if (uploaded) {
      const scan = scanFile(Buffer.from(await uploaded.arrayBuffer()), fileName, typeof body.mime_type === 'string' ? body.mime_type : '')
      if (!scan.safe) {
        await admin.storage.from('lp-documents').remove([storagePath])
        return NextResponse.json({ error: `That file was rejected: ${scan.reason ?? 'it did not pass the safety check'}.` }, { status: 400 })
      }
    }
  }

  const { data: doc, error } = await (admin as any)
    .from('lp_documents')
    .insert({ fund_id: fundId, title, file_name: fileName, storage_path: storagePath, mime_type: body.mime_type ?? null, size_bytes: body.size_bytes ?? null, scope, vehicle, category: (typeof body.category === 'string' && body.category.trim()) ? body.category.trim() : null, doc_date: body.doc_date || null, uploaded_by: user.id })
    .select('id').single()
  if (error || !doc) return dbError(error ?? { message: 'Insert failed' }, 'lps-documents')

  if (investorIds.length) {
    const rows = investorIds.map(id => ({ document_id: doc.id, lp_investor_id: id, fund_id: fundId }))
    await (admin as any).from('lp_document_shares').insert(rows)
  }

  // Best-effort: cache extracted text so the LP-portal analyst can read this
  // document. Failure never blocks the upload — the analyst just skips it.
  // `index: false` opts out: an onboarding document (a W-9, a passport scan) is
  // not one to make searchable, and its identifiers stay in the file alone.
  if (body.index === false) return NextResponse.json({ ok: true, id: doc.id })
  try {
    const { data: file } = await admin.storage.from('lp-documents').download(storagePath)
    if (file) {
      const buffer = Buffer.from(await file.arrayBuffer())
      const result = await extractFromBuffer(buffer, fileName, typeof body.mime_type === 'string' ? body.mime_type : '')
      const text = (result?.extractedText ?? '').trim()
      if (text) await (admin as any).from('lp_documents').update({ extracted_text: text }).eq('id', doc.id)
    }
  } catch (e) {
    console.warn('[lp document] text extraction failed:', e instanceof Error ? e.message : e)
  }

  return NextResponse.json({ ok: true, id: doc.id })
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
