// An LP document for the investor portal, shared by the web routes (app/api/lps/documents and its
// upload-url) and the agent tools `lp_document_upload_url` / `lp_add_document`. Recording one is
// what puts it in front of LPs (every LP for scope 'fund', the named investors, or everyone in a
// vehicle), so both doors are admin-only: the routes check the role, the tools are ADMIN_ONLY_TOOLS.

import type { SupabaseClient } from '@supabase/supabase-js'
import { extractFromBuffer } from '@/lib/parsing/extractAttachmentText'
import { scanFile } from '@/lib/security/scan-file'
import { dbFail, done, fail, type Outcome } from '@/lib/service-outcome'

export const LP_DOCUMENT_BUCKET = 'lp-documents'
/** The bucket sets no cap of its own, so the storage project's upload limit applies (50 MB by default). */
export const MAX_LP_DOCUMENT_BYTES = 50 * 1024 * 1024

export function safeLpDocumentName(rawName: string): string {
  return rawName.replace(/[\/\\:*?"<>|]/g, '_').replace(/\.\./g, '_').slice(0, 200)
}

/** Inside the fund's folder, at a path the server picks. */
export function lpDocumentPath(fundId: string, rawName: string): string {
  return `${fundId}/${Date.now()}_${safeLpDocumentName(rawName)}`
}

export async function createLpDocumentUploadUrl(
  admin: SupabaseClient, fundId: string, rawName: string,
): Promise<Outcome<{ storagePath: string; token: string; signedUrl: string }>> {
  if (!rawName) return fail(400, 'file_name is required')
  const storagePath = lpDocumentPath(fundId, rawName)
  const { data, error } = await (admin as any).storage.from(LP_DOCUMENT_BUCKET).createSignedUploadUrl(storagePath)
  if (error || !data) return fail(500, error?.message ?? 'Failed to create upload URL')
  return done({ storagePath, token: data.token as string, signedUrl: data.signedUrl as string })
}

export interface LpDocumentInput {
  title?: unknown
  file_name?: unknown
  storage_path?: unknown
  mime_type?: unknown
  size_bytes?: unknown
  /** 'fund' (all LPs), 'investor' (lp_investor_ids), or 'vehicle' (everyone in `vehicle`). */
  scope?: unknown
  lp_investor_ids?: unknown
  vehicle?: unknown
  category?: unknown
  doc_date?: unknown
  /** false: do not cache its text for the portal analyst (an onboarding W-9, a passport scan). */
  index?: unknown
}

/** Record a file already uploaded to the fund's folder, share it as scoped, and index its text. */
export async function recordLpDocument(
  admin: SupabaseClient,
  ctx: { fundId: string; userId: string },
  body: LpDocumentInput,
): Promise<Outcome<{ ok: true; id: string }>> {
  const { fundId } = ctx
  const db = admin as any
  const title = typeof body.title === 'string' ? body.title.trim() : ''
  const fileName = typeof body.file_name === 'string' ? body.file_name.trim() : ''
  const storagePath = typeof body.storage_path === 'string' ? body.storage_path : ''
  // A vehicle document is stored as an investor-scoped document whose recipients are resolved from
  // the vehicle now, so access is enforced by the same lp_document_shares path (and stays stable if
  // the vehicle is later renamed).
  const requestedScope = body.scope === 'investor' ? 'investor' : body.scope === 'vehicle' ? 'vehicle' : 'fund'
  const requestedInvestorIds: string[] = Array.isArray(body.lp_investor_ids)
    ? body.lp_investor_ids.filter((x: unknown): x is string => typeof x === 'string') : []
  const mimeType = typeof body.mime_type === 'string' ? body.mime_type : ''

  if (!title || !fileName || !storagePath) return fail(400, 'title, file_name and storage_path are required')
  // Inside this fund's folder (the upload URL guarantees it; the caller sends the path).
  if (!storagePath.startsWith(`${fundId}/`) || storagePath.includes('..')) return fail(400, 'Invalid storage path')

  const scope: 'fund' | 'investor' = requestedScope === 'fund' ? 'fund' : 'investor'
  let vehicle: string | null = null
  let investorIds: string[] = []

  if (requestedScope === 'investor') {
    const { data: valid } = await db
      .from('lp_investors').select('id').eq('fund_id', fundId)
      .in('id', requestedInvestorIds.length ? requestedInvestorIds : ['00000000-0000-0000-0000-000000000000'])
    investorIds = (valid ?? []).map((r: any) => r.id)
    if (investorIds.length === 0) return fail(400, 'Select at least one investor for an investor-scoped document')
  } else if (requestedScope === 'vehicle') {
    vehicle = typeof body.vehicle === 'string' ? body.vehicle.trim() : ''
    if (!vehicle) return fail(400, 'Select an investment vehicle')
    // Every investor with a position in this vehicle, across all snapshots (deduped).
    const { data: rows } = await db
      .from('lp_investments')
      .select('lp_entities!inner(investor_id)')
      .eq('fund_id', fundId)
      .eq('portfolio_group', vehicle)
    investorIds = Array.from(new Set(
      ((rows ?? []) as any[]).map(r => r.lp_entities?.investor_id as string | undefined).filter((x): x is string => !!x),
    ))
    if (investorIds.length === 0) return fail(400, 'No investors are in that vehicle')
  }

  // Scanned before it is recorded, like every other inbound file; a hit is deleted.
  const { data: uploaded } = await db.storage.from(LP_DOCUMENT_BUCKET).download(storagePath)
  if (uploaded) {
    const scan = scanFile(Buffer.from(await uploaded.arrayBuffer()), fileName, mimeType)
    if (!scan.safe) {
      await db.storage.from(LP_DOCUMENT_BUCKET).remove([storagePath])
      return fail(400, `That file was rejected: ${scan.reason ?? 'it did not pass the safety check'}.`)
    }
  }

  const { data: doc, error } = await db
    .from('lp_documents')
    .insert({
      fund_id: fundId, title, file_name: fileName, storage_path: storagePath,
      mime_type: body.mime_type ?? null, size_bytes: body.size_bytes ?? null, scope, vehicle,
      category: (typeof body.category === 'string' && body.category.trim()) ? body.category.trim() : null,
      doc_date: body.doc_date || null, uploaded_by: ctx.userId,
    })
    .select('id').single()
  if (error || !doc) return dbFail(error ?? { message: 'Insert failed' }, 'lps-documents')

  if (investorIds.length) {
    await db.from('lp_document_shares').insert(investorIds.map(id => ({ document_id: doc.id, lp_investor_id: id, fund_id: fundId })))
  }

  // Best effort: cache the text so the LP-portal analyst can read it. Failure never blocks the upload.
  if (body.index === false) return done({ ok: true, id: doc.id })
  try {
    const { data: file } = await db.storage.from(LP_DOCUMENT_BUCKET).download(storagePath)
    if (file) {
      const result = await extractFromBuffer(Buffer.from(await file.arrayBuffer()), fileName, mimeType)
      const text = (result?.extractedText ?? '').trim()
      if (text) await db.from('lp_documents').update({ extracted_text: text }).eq('id', doc.id)
    }
  } catch (e) {
    console.warn('[lp document] text extraction failed:', e instanceof Error ? e.message : e)
  }
  return done({ ok: true, id: doc.id })
}
