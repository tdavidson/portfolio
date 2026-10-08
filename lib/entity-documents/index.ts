import type { SupabaseClient } from '@supabase/supabase-js'
import { assemblePdfPages, chunkText, extractArtifact, normalizePlainText } from '@/lib/company-updates/extraction'
import type { OcrEngine } from '@/lib/company-updates/ocr'

// An entity's governing documents (LPA, operating agreement, side letters, amendments). Every read
// here takes the entities the caller can see and filters on them: the tables are service-role only,
// so this module IS the access boundary. See plans/spec-entity-documents.md.

export const ENTITY_DOCUMENT_BUCKET = 'entity-documents'
export const MAX_ENTITY_DOCUMENT_BYTES = 25 * 1024 * 1024

export const DOCUMENT_KINDS = ['lpa', 'operating_agreement', 'side_letter', 'amendment', 'other'] as const
export type DocumentKind = typeof DOCUMENT_KINDS[number]
export const KIND_LABELS: Record<DocumentKind, string> = {
  lpa: 'LPA',
  operating_agreement: 'Operating agreement',
  side_letter: 'Side letter',
  amendment: 'Amendment',
  other: 'Other',
}

export function isDocumentKind(v: unknown): v is DocumentKind {
  return typeof v === 'string' && (DOCUMENT_KINDS as readonly string[]).includes(v)
}

export interface EntityDocument {
  id: string
  vehicle_id: string
  kind: DocumentKind
  title: string
  effective_date: string | null
  file_name: string
  content_type: string | null
  size_bytes: number | null
  page_count: number | null
  extraction_status: string
  ocr_status: string
  warnings: string[]
  created_at: string
}

const LIST_COLUMNS = 'id, vehicle_id, kind, title, effective_date, file_name, content_type, size_bytes, page_count, extraction_status, ocr_status, warnings, created_at'

/** The storage path for a new upload: the fund, then the entity, then a unique file name. */
export function documentStoragePath(fundId: string, vehicleId: string, fileName: string, now = Date.now()): string {
  const safe = fileName.replace(/[^\w.\-]+/g, '_').slice(-120) || 'document'
  return `${fundId}/${vehicleId}/${now}_${safe}`
}

/** Whether a client-supplied storage path is one we issued for this fund and entity. */
export function pathBelongsTo(path: string, fundId: string, vehicleId: string): boolean {
  return path.startsWith(`${fundId}/${vehicleId}/`) && !path.includes('..')
}

/**
 * Store an uploaded file as a document: read it back from storage, run the safety scan and text
 * extraction (Company Updates' extractor), save the text and its searchable chunks, and queue OCR for
 * pages with no text layer. A file that fails the scan is removed and refused.
 */
export async function ingestDocument(
  admin: SupabaseClient,
  input: {
    fundId: string
    vehicleId: string
    storagePath: string
    fileName: string
    contentType: string | null
    kind: DocumentKind
    title: string
    effectiveDate: string | null
    uploadedBy: string
  },
): Promise<{ document: EntityDocument } | { error: string; status: number }> {
  const { data: blob, error: dlError } = await (admin as any).storage.from(ENTITY_DOCUMENT_BUCKET).download(input.storagePath)
  if (dlError || !blob) return { error: 'The upload was not found. Try again.', status: 400 }
  const buffer = Buffer.from(await (blob as Blob).arrayBuffer())
  if (buffer.length > MAX_ENTITY_DOCUMENT_BYTES) {
    await (admin as any).storage.from(ENTITY_DOCUMENT_BUCKET).remove([input.storagePath])
    return { error: 'Files can be up to 25 MB.', status: 400 }
  }

  const extracted = await extractArtifact({
    filename: input.fileName,
    declaredContentType: input.contentType,
    content: buffer.toString('base64'),
  })
  const result = extracted.result
  if (result.parser === 'safety-scan') {
    await (admin as any).storage.from(ENTITY_DOCUMENT_BUCKET).remove([input.storagePath])
    return { error: result.warnings[result.warnings.length - 1] ?? 'The file did not pass the safety scan.', status: 400 }
  }

  const needed = (result.metadata.ocrNeededPages as number[] | undefined) ?? []
  const isImage = (extracted.detectedContentType ?? '').startsWith('image/')
  const ocrNeeded = result.metadata.ocrNeeded === true
  const { data: doc, error } = await (admin as any).from('entity_documents').insert({
    fund_id: input.fundId,
    vehicle_id: input.vehicleId,
    kind: input.kind,
    title: input.title,
    effective_date: input.effectiveDate,
    file_name: input.fileName,
    content_type: extracted.detectedContentType ?? input.contentType,
    size_bytes: buffer.length,
    content_sha256: extracted.contentSha256,
    storage_path: input.storagePath,
    page_count: (result.metadata.pageCount as number | undefined) ?? null,
    extracted_text: result.text || null,
    extraction_status: result.status,
    ocr_status: ocrNeeded ? 'pending' : 'none',
    ocr_progress: ocrNeeded ? { needed: isImage ? [] : needed, pages: {} } : null,
    warnings: result.warnings,
    uploaded_by: input.uploadedBy,
  }).select(LIST_COLUMNS).single()
  if (error || !doc) return { error: 'Could not save the document.', status: 500 }

  await replaceChunks(admin, input.fundId, input.vehicleId, (doc as any).id, result.chunks)
  return { document: doc as EntityDocument }
}

async function replaceChunks(
  admin: SupabaseClient, fundId: string, vehicleId: string, documentId: string,
  chunks: Array<{ ordinal: number; locator: Record<string, unknown>; text: string }>,
): Promise<void> {
  await (admin as any).from('entity_document_chunks').delete().eq('document_id', documentId)
  if (chunks.length === 0) return
  const rows = chunks.map((c, i) => ({ fund_id: fundId, vehicle_id: vehicleId, document_id: documentId, ordinal: i, locator: c.locator, text: c.text }))
  for (let i = 0; i < rows.length; i += 200) {
    const { error } = await (admin as any).from('entity_document_chunks').insert(rows.slice(i, i + 200))
    if (error) throw new Error(error.message)
  }
}

/** The documents of the given entities (null = every entity in the fund), newest effective first. */
export async function listDocuments(admin: SupabaseClient, fundId: string, vehicleIds: string[] | null): Promise<EntityDocument[]> {
  if (vehicleIds !== null && vehicleIds.length === 0) return []
  let q = (admin as any).from('entity_documents').select(LIST_COLUMNS).eq('fund_id', fundId)
  if (vehicleIds !== null) q = q.in('vehicle_id', vehicleIds)
  const { data } = await q.order('effective_date', { ascending: false, nullsFirst: false }).order('created_at', { ascending: false })
  return (data as EntityDocument[] | null) ?? []
}

/** One document, if it belongs to one of the given entities (null = any in the fund). */
export async function getDocument(admin: SupabaseClient, fundId: string, documentId: string, vehicleIds: string[] | null) {
  const { data } = await (admin as any).from('entity_documents').select('*').eq('id', documentId).eq('fund_id', fundId).maybeSingle()
  if (!data) return null
  if (vehicleIds !== null && !vehicleIds.includes((data as any).vehicle_id)) return null
  return data as EntityDocument & { storage_path: string; extracted_text: string | null }
}

export interface SearchHit {
  document_id: string
  vehicle_id: string
  title: string
  kind: string
  locator: Record<string, unknown>
  excerpt: string
}

/** Full-text search across the given entities' documents. */
export async function searchDocuments(
  admin: SupabaseClient, fundId: string, vehicleIds: string[], query: string, limit = 8,
): Promise<SearchHit[]> {
  if (vehicleIds.length === 0 || !query.trim()) return []
  const { data, error } = await (admin as any).rpc('entity_document_search', {
    p_fund_id: fundId, p_vehicle_ids: vehicleIds, p_query: query, p_limit: limit,
  })
  if (error) throw new Error(error.message)
  return ((data as any[]) ?? []).map(r => ({
    document_id: r.document_id, vehicle_id: r.vehicle_id, title: r.title, kind: r.kind, locator: r.locator ?? {}, excerpt: r.excerpt,
  }))
}

/** A window of a document's text, for reading a clause in full or paging through. */
export function textWindow(text: string, offset: number, maxChars: number) {
  const start = Math.max(0, Math.min(offset, text.length))
  const end = Math.min(text.length, start + maxChars)
  return {
    text: text.slice(start, end),
    offset: start,
    total_chars: text.length,
    next_offset: end < text.length ? end : null,
  }
}

// ─── OCR worker ─────────────────────────────────────────────────────────────────────────────────

export const OCR_PAGES_PER_CALL = 8
export const OCR_MAX_ATTEMPTS = 3

/** A PDF of just these pages (1-based), so each OCR call stays far under the model's page limit. */
export async function pdfOfPages(buffer: Buffer, pages: number[]): Promise<Buffer> {
  const { PDFDocument } = await import('pdf-lib')
  const src = await PDFDocument.load(buffer, { ignoreEncryption: true })
  const out = await PDFDocument.create()
  const copied = await out.copyPages(src, pages.map(p => p - 1))
  for (const page of copied) out.addPage(page)
  return Buffer.from(await out.save())
}

export interface OcrRunResult {
  documents: number
  pages: number
  completed: number
  failed: number
}

/**
 * Transcribe pending documents' textless pages, a batch at a time, saving progress after each batch
 * so a long scanned LPA finishes over several runs. When the last page is read the full text and
 * chunks are rebuilt. `engineFor` supplies the fund's vision model.
 */
export async function runEntityDocumentOcr(
  admin: SupabaseClient,
  opts: { engineFor: (fundId: string) => Promise<OcrEngine>; maxDocuments?: number; maxPagesPerRun?: number },
): Promise<OcrRunResult> {
  const result: OcrRunResult = { documents: 0, pages: 0, completed: 0, failed: 0 }
  const { data: pending } = await (admin as any).from('entity_documents')
    .select('*').eq('ocr_status', 'pending').order('updated_at', { ascending: true }).limit(opts.maxDocuments ?? 3)
  for (const doc of ((pending as any[]) ?? [])) {
    result.documents++
    try {
      const engine = await opts.engineFor(doc.fund_id)
      const { data: blob, error } = await (admin as any).storage.from(ENTITY_DOCUMENT_BUCKET).download(doc.storage_path)
      if (error || !blob) throw new Error('file unavailable')
      const buffer = Buffer.from(await (blob as Blob).arrayBuffer())
      const saved = (doc.ocr_progress ?? {}) as { needed?: number[]; pages?: Record<string, string> }
      const progress: { needed: number[]; pages: Record<string, string> } = { needed: saved.needed ?? [], pages: saved.pages ?? {} }

      if ((doc.content_type ?? '').startsWith('image/')) {
        const text = normalizePlainText(await engine.transcribeImage(buffer, doc.content_type))
        await finish(admin, doc, text, text ? chunkText(text, { image: true, ocr: true }) : [], text ? 'complete' : 'not_applicable',
          text ? [] : ['OCR found no readable text in this image.'], engine.name)
        result.pages++
        result.completed++
        continue
      }

      const todo = progress.needed.filter(p => progress.pages[String(p)] === undefined)
      const budget = opts.maxPagesPerRun ?? 32
      const batch = todo.slice(0, budget)
      for (let i = 0; i < batch.length; i += OCR_PAGES_PER_CALL) {
        const pages = batch.slice(i, i + OCR_PAGES_PER_CALL)
        const sub = await pdfOfPages(buffer, pages)
        const read = await engine.transcribePdfPages(sub, pages.map((_, k) => k + 1))
        pages.forEach((p, k) => { progress.pages[String(p)] = normalizePlainText(read[k + 1] ?? '') })
        result.pages += pages.length
        // Saved after every call: a timeout mid-document resumes where it stopped.
        await (admin as any).from('entity_documents').update({ ocr_progress: progress, updated_at: new Date().toISOString() }).eq('id', doc.id)
      }

      if (progress.needed.every(p => progress.pages[String(p)] !== undefined)) {
        const { extractText, getDocumentProxy } = await import('unpdf')
        const pdf = await getDocumentProxy(new Uint8Array(buffer))
        const native = await extractText(pdf)
        const merged = native.text.map(normalizePlainText)
        const ocrPages: number[] = []
        for (const p of progress.needed) {
          const t = progress.pages[String(p)]
          if (t) { merged[p - 1] = t; ocrPages.push(p) }
        }
        const assembled = assemblePdfPages(merged, native.totalPages, { ocrPages, ocrEngine: engine.name })
        const missing = progress.needed.filter(p => !progress.pages[String(p)])
        const warnings = assembled.warnings.filter(w => !w.startsWith('PDF pages requiring OCR'))
        if (missing.length) warnings.push(`OCR found no readable text on page${missing.length === 1 ? '' : 's'} ${missing.join(', ')}.`)
        await finish(admin, doc, assembled.text, assembled.chunks, assembled.status, warnings, engine.name)
        result.completed++
      }
    } catch (err) {
      const attempts = (doc.ocr_attempts ?? 0) + 1
      const giveUp = attempts >= OCR_MAX_ATTEMPTS
      await (admin as any).from('entity_documents').update({
        ocr_attempts: attempts,
        ...(giveUp ? { ocr_status: 'failed', warnings: [...(doc.warnings ?? []), `OCR failed: ${(err as Error).message}`] } : {}),
        updated_at: new Date().toISOString(),
      }).eq('id', doc.id)
      if (giveUp) result.failed++
    }
  }
  return result
}

async function finish(
  admin: SupabaseClient, doc: any, text: string,
  chunks: Array<{ ordinal: number; locator: Record<string, unknown>; text: string }>,
  status: string, warnings: string[], engineName: string,
): Promise<void> {
  await replaceChunks(admin, doc.fund_id, doc.vehicle_id, doc.id, chunks)
  await (admin as any).from('entity_documents').update({
    extracted_text: text || null,
    extraction_status: status,
    ocr_status: 'complete',
    ocr_progress: null,
    warnings: [...warnings, `Scanned pages read by ${engineName}.`],
    updated_at: new Date().toISOString(),
  }).eq('id', doc.id)
}
