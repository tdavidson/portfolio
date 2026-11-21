// A holding's files, for an assistant: what list_company_documents and read_company_document
// return (lib/agent/company-document-tools.ts). Two kinds, listed together newest first as the
// holding page's Documents section shows them:
//
//   document  a file uploaded to the holding's Documents (company_documents)
//   update    a file attached to one of its company updates (company_update_artifacts)
//
// The caller has already resolved the holding with the member's access (resolveCompany), so every
// read here is scoped to that holding and the active fund, and nothing else.

import type { SupabaseClient } from '@supabase/supabase-js'
import { COMPANY_DOCUMENT_BUCKET } from './documents'
import { EMAIL_ATTACHMENT_BUCKET } from './document-hashes'
import { fingerprintFile } from './document-fingerprint'

type Admin = SupabaseClient

export type DocumentSource = 'document' | 'update'
export type ScanStatus = 'clean' | 'pending' | 'removed'
export type TextStatus = 'extracted' | 'text_only' | 'none' | 'pending'

export interface HoldingDocumentRow {
  id: string
  source: DocumentSource
  update_id: string | null
  filename: string
  content_type: string | null
  size_bytes: number | null
  sha256: string | null
  text_sha256: string | null
  uploaded_at: string | null
  uploaded_by: string | null
  via: string | null
  scan_status: ScanStatus
  text_status: TextStatus
  page_count: number | null
}

export interface ListOptions {
  source?: 'documents' | 'updates' | 'all'
  query?: string
  uploadedAfter?: string
  uploadedBefore?: string
  limit?: number
  cursor?: string
}

/** Signed download URLs live this long: long enough to fetch, short enough to be useless forwarded. */
export const DOWNLOAD_URL_TTL_SECONDS = 15 * 60
/** Characters of text one read returns, as submit_company_update accepts. */
export const MAX_READ_CHARS = 100_000
export const DEFAULT_LIST_LIMIT = 50
export const MAX_LIST_LIMIT = 200
/** Rows read from each table per holding. Far above any real holding; keeps a runaway read bounded. */
const MAX_ROWS_PER_SOURCE = 2_000

const isoDate = (v: unknown) => (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : undefined)

/** A PostgREST ilike pattern for words a person typed: wildcards and the filter syntax escaped. */
function likePattern(q: string): string {
  return `%${q.replace(/[\\%_]/g, c => `\\${c}`).replace(/[,()]/g, ' ').trim()}%`
}

export function encodeCursor(offset: number): string {
  return Buffer.from(JSON.stringify({ o: offset })).toString('base64url')
}

export function decodeCursor(cursor: string | undefined): number {
  if (!cursor) return 0
  try {
    const o = Number(JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'))?.o)
    return Number.isInteger(o) && o >= 0 ? o : 0
  } catch {
    return 0
  }
}

/** What a document row says about its text, from the row alone (its text is never loaded to list). */
export function documentTextStatus(d: { scan_status?: string | null; storage_path?: string | null; text_sha256?: string | null; hashed_at?: string | null; has_text?: boolean }): TextStatus {
  if (d.scan_status === 'removed') return 'none'
  if (!d.storage_path) return 'text_only'
  if (d.text_sha256) return 'extracted'
  if (!d.hashed_at) return 'pending'
  return 'none'
}

export function artifactTextStatus(a: { extraction_status?: string | null; ocr_status?: string | null; storage_path?: string | null }): TextStatus {
  if (a.ocr_status === 'pending' || a.ocr_status === 'running') return 'pending'
  const read = a.extraction_status === 'complete' || a.extraction_status === 'partial'
  if (!read) return 'none'
  return a.storage_path ? 'extracted' : 'text_only'
}

/** An update file the safety scan refused keeps its row, with no text: it reads as removed. */
export function artifactScanStatus(a: { parser?: string | null }): ScanStatus {
  return a.parser === 'safety-scan' ? 'removed' : 'clean'
}

async function uploaderEmails(admin: Admin, ids: string[]): Promise<Map<string, string>> {
  const out = new Map<string, string>()
  await Promise.all(ids.map(async id => {
    try {
      const { data } = await (admin as any).auth.admin.getUserById(id)
      if (data?.user?.email) out.set(id, data.user.email)
    } catch { /* an uploader who has since left: shown without an email */ }
  }))
  return out
}

/** Columns that exist before migration 20261121160000; the hash columns are read apart from them. */
const DOCUMENT_BASE = 'id, filename, file_type, file_size, storage_path, uploaded_by, created_at'
const DOCUMENT_HASHES = 'id, sha256, text_sha256, page_count, hashed_at, uploaded_via, scan_status'
const ARTIFACT_BASE = 'id, update_id, filename, declared_content_type, detected_content_type, byte_size, storage_path, ' +
  'content_sha256, extraction_status, ocr_status, parser, metadata, created_at, ' +
  'company_updates!inner(received_at, sender_email, forwarded_sender_email, source_email_id)'
const ARTIFACT_HASHES = 'id, text_sha256, hashed_at'

/**
 * The hash columns for these rows, by id. Read on their own so the list still works before the
 * migration is applied (the read then fails with undefined column, and every row reads unhashed).
 */
async function hashColumns(admin: Admin, table: string, columns: string, ids: string[]): Promise<Map<string, any>> {
  const out = new Map<string, any>()
  for (let i = 0; i < ids.length; i += 200) {
    const { data, error } = await (admin as any).from(table).select(columns).in('id', ids.slice(i, i + 200))
    if (error) return out
    for (const r of (data ?? []) as any[]) out.set(r.id, r)
  }
  return out
}

export function mapDocumentRow(d: any, uploaderEmail: string | null): HoldingDocumentRow {
  return {
    id: d.id,
    source: 'document',
    update_id: null,
    filename: d.filename,
    content_type: d.file_type ?? null,
    size_bytes: d.file_size ?? null,
    sha256: d.sha256 ?? null,
    text_sha256: d.text_sha256 ?? null,
    uploaded_at: d.created_at ?? null,
    uploaded_by: uploaderEmail,
    via: d.uploaded_via ?? null,
    scan_status: d.scan_status === 'removed' ? 'removed' : 'clean',
    text_status: documentTextStatus(d),
    page_count: d.page_count ?? null,
  }
}

export function mapArtifactRow(a: any): HoldingDocumentRow {
  const update = a.company_updates ?? {}
  const pages = Number(a.metadata?.pageCount)
  const removed = artifactScanStatus(a) === 'removed'
  return {
    id: a.id,
    source: 'update',
    update_id: a.update_id,
    filename: a.filename,
    content_type: a.detected_content_type ?? a.declared_content_type ?? null,
    size_bytes: a.byte_size == null ? null : Number(a.byte_size),
    sha256: a.content_sha256 ?? null,
    text_sha256: a.text_sha256 ?? null,
    uploaded_at: update.received_at ?? a.created_at ?? null,
    uploaded_by: update.forwarded_sender_email ?? update.sender_email ?? null,
    via: 'email',
    scan_status: removed ? 'removed' : 'clean',
    text_status: removed ? 'none' : artifactTextStatus(a),
    page_count: Number.isFinite(pages) && pages > 0 ? pages : null,
  }
}

async function loadDocumentRows(admin: Admin, ctx: { fundId: string; companyId: string }, opts: ListOptions & { id?: string }): Promise<any[]> {
  let q = (admin as any).from('company_documents').select(DOCUMENT_BASE)
    .eq('fund_id', ctx.fundId).eq('company_id', ctx.companyId)
  if (opts.id) q = q.eq('id', opts.id)
  if (opts.query) {
    const like = likePattern(opts.query)
    q = q.or(`filename.ilike.${like},extracted_text.ilike.${like}`)
  }
  if (opts.uploadedAfter) q = q.gte('created_at', `${opts.uploadedAfter}T00:00:00Z`)
  if (opts.uploadedBefore) q = q.lte('created_at', `${opts.uploadedBefore}T23:59:59.999Z`)
  const { data, error } = await q.order('created_at', { ascending: false }).limit(MAX_ROWS_PER_SOURCE)
  if (error) throw new Error(`The holding's documents could not be read: ${error.message}`)
  const rows = (data ?? []) as any[]
  const hashes = await hashColumns(admin, 'company_documents', DOCUMENT_HASHES, rows.map(r => r.id))
  return rows.map(r => ({ ...r, ...(hashes.get(r.id) ?? {}) }))
}

async function loadDocuments(admin: Admin, ctx: { fundId: string; companyId: string }, opts: ListOptions & { id?: string }): Promise<HoldingDocumentRow[]> {
  const rows = await loadDocumentRows(admin, ctx, opts)
  const emails = await uploaderEmails(admin, Array.from(new Set(rows.map(r => r.uploaded_by).filter(Boolean))))
  return rows.map(d => mapDocumentRow(d, d.uploaded_by ? emails.get(d.uploaded_by) ?? null : null))
}

async function loadArtifactRows(admin: Admin, ctx: { fundId: string; companyId: string }, opts: ListOptions & { id?: string }): Promise<any[]> {
  let q = (admin as any).from('company_update_artifacts').select(ARTIFACT_BASE)
    .eq('fund_id', ctx.fundId).eq('company_id', ctx.companyId)
  if (opts.id) q = q.eq('id', opts.id)
  if (opts.query) {
    const like = likePattern(opts.query)
    q = q.or(`filename.ilike.${like},extracted_text.ilike.${like}`)
  }
  // The update's received date is the file's date, as the Documents page shows it.
  if (opts.uploadedAfter) q = q.gte('company_updates.received_at', `${opts.uploadedAfter}T00:00:00Z`)
  if (opts.uploadedBefore) q = q.lte('company_updates.received_at', `${opts.uploadedBefore}T23:59:59.999Z`)
  const { data, error } = await q.order('created_at', { ascending: false }).limit(MAX_ROWS_PER_SOURCE)
  if (error) throw new Error(`The holding's update files could not be read: ${error.message}`)
  const rows = (data ?? []) as any[]
  const hashes = await hashColumns(admin, 'company_update_artifacts', ARTIFACT_HASHES, rows.map(r => r.id))
  return rows.map(r => ({ ...r, ...(hashes.get(r.id) ?? {}) }))
}

async function loadArtifacts(admin: Admin, ctx: { fundId: string; companyId: string }, opts: ListOptions & { id?: string }): Promise<HoldingDocumentRow[]> {
  return (await loadArtifactRows(admin, ctx, opts)).map(mapArtifactRow)
}

export interface ListResult {
  documents: HoldingDocumentRow[]
  total: number
  hasMore: boolean
  nextCursor: string | null
}

/** The holding's files, newest first, filtered and paged. */
export async function listHoldingDocuments(admin: Admin, ctx: { fundId: string; companyId: string }, raw: ListOptions = {}): Promise<ListResult> {
  const source = raw.source === 'documents' || raw.source === 'updates' ? raw.source : 'all'
  const opts: ListOptions = {
    ...raw,
    query: typeof raw.query === 'string' && raw.query.trim() ? raw.query.trim() : undefined,
    uploadedAfter: isoDate(raw.uploadedAfter),
    uploadedBefore: isoDate(raw.uploadedBefore),
  }
  const limit = Math.min(Math.max(Math.floor(Number(raw.limit) || DEFAULT_LIST_LIMIT), 1), MAX_LIST_LIMIT)
  const offset = decodeCursor(raw.cursor)
  const [docs, arts] = await Promise.all([
    source === 'updates' ? Promise.resolve([]) : loadDocuments(admin, ctx, opts),
    source === 'documents' ? Promise.resolve([]) : loadArtifacts(admin, ctx, opts),
  ])
  const all = [...docs, ...arts].sort((a, b) =>
    String(b.uploaded_at ?? '').localeCompare(String(a.uploaded_at ?? '')) || a.filename.localeCompare(b.filename))
  const page = all.slice(offset, offset + limit)
  const hasMore = offset + limit < all.length
  return { documents: page, total: all.length, hasMore, nextCursor: hasMore ? encodeCursor(offset + limit) : null }
}

// ---------------------------------------------------------------------------------------------
// Reading one file
// ---------------------------------------------------------------------------------------------

/** "1-3", "2", "1,4-5" → the page numbers, or null for anything else. */
export function parsePageRange(raw: unknown): number[] | null {
  if (typeof raw !== 'string' || !raw.trim()) return null
  const pages = new Set<number>()
  for (const part of raw.split(',')) {
    const m = part.trim().match(/^(\d+)(?:\s*-\s*(\d+))?$/)
    if (!m) return null
    const from = Number(m[1])
    const to = m[2] ? Number(m[2]) : from
    if (from < 1 || to < from || to - from > 5_000) return null
    for (let p = from; p <= to; p++) pages.add(p)
  }
  return Array.from(pages).sort((a, b) => a - b)
}

/**
 * The text of the pages asked for, from text that marks its pages "[Page N]" (the PDF parser's
 * labels). Null when the text has no page labels, so the caller can say pages do not apply.
 */
export function selectPages(text: string, pages: number[]): { text: string; found: number[] } | null {
  const marker = /^\[Page (\d+)(?: \(OCR\))?\]\s*$/gm
  const starts: { page: number; index: number }[] = []
  for (let m = marker.exec(text); m; m = marker.exec(text)) starts.push({ page: Number(m[1]), index: m.index })
  if (starts.length === 0) return null
  const wanted = new Set(pages)
  const parts: string[] = []
  const found: number[] = []
  starts.forEach((s, i) => {
    if (!wanted.has(s.page)) return
    parts.push(text.slice(s.index, i + 1 < starts.length ? starts[i + 1].index : text.length).trim())
    found.push(s.page)
  })
  return { text: parts.join('\n\n'), found }
}

export interface ReadOptions {
  pages?: string
  downloadUrl?: boolean
  /** Character offset to continue a truncated read from. */
  offset?: number
}

export interface ReadResult extends HoldingDocumentRow {
  text: string
  truncated: boolean
  /** Pass as `offset` to read on, when truncated. */
  nextOffset?: number
  totalChars: number
  pages?: number[]
  note?: string
  downloadUrl?: string | null
  downloadUrlExpiresAt?: string
}

async function signedUrl(admin: Admin, bucket: string, path: string, filename: string): Promise<string | null> {
  const downloadName = filename.replace(/[^\w.\-]/g, '_').slice(0, 200) || 'file'
  const { data, error } = await (admin as any).storage.from(bucket).createSignedUrl(path, DOWNLOAD_URL_TTL_SECONDS, { download: downloadName })
  return error || !data ? null : data.signedUrl
}

/**
 * One of the holding's files: its metadata as listed, its extracted text (the same text search
 * and summaries use; for an uploaded PDF, whose text the app leaves to the model, read from the
 * file now), and a short-lived link to the original.
 */
export async function readHoldingDocument(
  admin: Admin,
  ctx: { fundId: string; companyId: string },
  documentId: string,
  opts: ReadOptions = {},
): Promise<ReadResult> {
  const db = admin as any
  const id = String(documentId ?? '').trim()
  if (!id) throw new Error('Name the document (its id from list_company_documents).')
  const uuid = /^[0-9a-f-]{36}$/i.test(id)
  if (!uuid) throw new Error(`No document ${id} on this holding. Use an id from list_company_documents.`)

  // Which kind it is: read as the list reads it, so the metadata matches.
  const [docRow] = await loadDocumentRows(admin, ctx, { id })
  let row: HoldingDocumentRow
  let text = ''
  let bucket: string | null = null
  let storagePath: string | null = null
  let note: string | undefined

  if (docRow) {
    const emails = docRow.uploaded_by ? await uploaderEmails(admin, [docRow.uploaded_by]) : new Map<string, string>()
    row = mapDocumentRow(docRow, docRow.uploaded_by ? emails.get(docRow.uploaded_by) ?? null : null)
    if (row.scan_status !== 'removed') {
      const { data: kept } = await db.from('company_documents').select('extracted_text').eq('id', id).maybeSingle()
      text = kept?.extracted_text ?? ''
      storagePath = docRow.storage_path ?? null
      bucket = COMPANY_DOCUMENT_BUCKET
      // An uploaded PDF keeps no text (the model reads it natively): read its text layer now.
      if (!text && storagePath) {
        const { data: file } = await db.storage.from(COMPANY_DOCUMENT_BUCKET).download(storagePath)
        if (file) {
          const fp = await fingerprintFile(Buffer.from(await file.arrayBuffer()), docRow.filename, docRow.file_type)
          text = fp.text
        }
        if (!text) note = 'No text could be read from this file (an image or a scan without a text layer). Use the download link to view it.'
      }
    } else {
      note = 'The virus scan removed this file when it was uploaded. Nothing was kept.'
    }
  } else {
    const [art] = await loadArtifactRows(admin, ctx, { id })
    if (!art) throw new Error(`No document ${id} on this holding. Use an id from list_company_documents.`)
    row = mapArtifactRow(art)
    if (row.scan_status === 'removed') {
      note = 'The safety scan refused this attachment. No text or file is available.'
    } else {
      const { data: kept } = await db.from('company_update_artifacts').select('extracted_text').eq('id', id).maybeSingle()
      text = kept?.extracted_text ?? ''
      // The same check the artifact route makes: the bytes are this update's email's.
      const emailId = art.company_updates?.source_email_id
      if (art.storage_path && emailId && String(art.storage_path).startsWith(`${emailId}/`)) {
        storagePath = art.storage_path
        bucket = EMAIL_ATTACHMENT_BUCKET
      }
      if (!text) note = row.text_status === 'pending'
        ? 'Its text is still being read (OCR is queued). Try again later, or use the download link.'
        : 'No text could be read from this attachment. Use the download link to view it.'
    }
  }

  let pages: number[] | undefined
  const wanted = parsePageRange(opts.pages)
  if (opts.pages !== undefined && opts.pages !== '' && !wanted) throw new Error('pages must look like "1-3", "2" or "1,4-6".')
  if (wanted && text) {
    const picked = selectPages(text, wanted)
    if (picked) {
      text = picked.text
      pages = picked.found
      if (picked.found.length === 0) note = `This file has no page ${wanted.join(', ')}.`
    } else {
      note = 'This file\'s text is not divided into pages, so the whole text was returned.'
    }
  }

  const totalChars = text.length
  const offset = Math.min(Math.max(Math.floor(Number(opts.offset) || 0), 0), totalChars)
  const slice = text.slice(offset, offset + MAX_READ_CHARS)
  const truncated = offset + slice.length < totalChars

  const out: ReadResult = {
    ...row,
    text: slice,
    truncated,
    ...(truncated ? { nextOffset: offset + slice.length } : {}),
    totalChars,
    ...(pages ? { pages } : {}),
    ...(note ? { note } : {}),
  }
  // Offered by default; never for a removed file or one kept as text only (no bytes to fetch).
  if (opts.downloadUrl !== false) {
    const url = bucket && storagePath && row.scan_status !== 'removed' ? await signedUrl(admin, bucket, storagePath, row.filename) : null
    out.downloadUrl = url
    if (url) out.downloadUrlExpiresAt = new Date(Date.now() + DOWNLOAD_URL_TTL_SECONDS * 1000).toISOString()
  }
  return out
}
