// A document uploaded to a portfolio company (the company page's Documents section), shared by the
// web route (app/api/companies/[id]/documents POST) and the agent tools (lib/agent/upload-tools.ts):
// the file is already in the company-documents bucket, and this scans it, extracts its text and
// records the row, so one uploaded from chat is treated exactly like one dropped in the browser.

import crypto from 'crypto'
import type { SupabaseClient } from '@supabase/supabase-js'
import { extractFromBuffer } from '@/lib/parsing/extractAttachmentText'
import { scanFileAsync } from '@/lib/security/scan-file'
import { logActivity } from '@/lib/activity'
import { dbFail, done, fail, type Outcome } from '@/lib/service-outcome'
import { fingerprintFile, type Fingerprint } from './document-fingerprint'

export const COMPANY_DOCUMENT_BUCKET = 'company-documents'
/** The company page refuses a file over 20 MB. */
export const MAX_COMPANY_DOCUMENT_BYTES = 20 * 1024 * 1024
/** Over 10 MB the page asks for text only: a file that yields text is kept as its text alone. */
export const COMPANY_TEXT_ONLY_THRESHOLD = 10 * 1024 * 1024

/** The key the browser builds, `${fundId}/${companyId}/${uuid}-${name}`. */
export function companyDocumentPath(fundId: string, companyId: string, fileName: string): string {
  return `${fundId}/${companyId}/${crypto.randomUUID()}-${fileName}`
}

/** Whether a storage key is inside this holding's folder (the bucket is shared across funds). */
export function isCompanyDocumentPath(fundId: string, companyId: string, storagePath: string): boolean {
  return String(storagePath).startsWith(`${fundId}/${companyId}/`) && !String(storagePath).includes('..')
}

/**
 * The hashes of a file uploaded to this holding's folder but not yet registered, for the duplicate
 * check before it is staged or added. Null when the path is not this holding's or nothing is there.
 */
export async function fingerprintUploadedDocument(
  admin: SupabaseClient,
  ctx: { fundId: string; companyId: string },
  input: { storagePath: string; filename: string; fileType?: string | null },
): Promise<Fingerprint | null> {
  if (!input.storagePath || !isCompanyDocumentPath(ctx.fundId, ctx.companyId, input.storagePath)) return null
  const { data, error } = await (admin as any).storage.from(COMPANY_DOCUMENT_BUCKET).download(input.storagePath)
  if (error || !data) return null
  return fingerprintFile(Buffer.from(await data.arrayBuffer()), input.filename, input.fileType ?? null)
}

export interface CompanyDocumentInput {
  storagePath: string
  filename: string
  fileType: string
  fileSize?: number | null
  textOnly?: boolean
  /** Which door it came through: web, mcp or api. Shown by list_company_documents. */
  via?: 'web' | 'mcp' | 'api'
  /** The file's hashes when the caller already computed them (the duplicate check did). */
  fingerprint?: Fingerprint
}

export interface RegisteredDocument {
  success: true
  textOnly: boolean
  documentId: string | null
  sha256: string
  textSha256: string | null
}

/** Columns added by migration 20261121160000_holding_document_hashes.sql. */
const HASH_COLUMNS = ['sha256', 'text_sha256', 'page_count', 'hashed_at', 'uploaded_via', 'scan_status']

/**
 * Insert a document row. Until migration 20261121160000 is applied its columns are missing
 * (Postgres' undefined column, 42703): the row is then written without them, so the deploy and the
 * migration may land in either order. The backfill hashes it once the columns exist.
 */
async function insertDocument(db: any, row: Record<string, unknown>): Promise<{ data: { id: string } | null; error: any }> {
  const insert = (r: Record<string, unknown>) => db.from('company_documents').insert(r).select('id').maybeSingle()
  const first = await insert(row)
  if (first.error?.code !== '42703') return first
  return insert(Object.fromEntries(Object.entries(row).filter(([k]) => !HASH_COLUMNS.includes(k))))
}

/**
 * Register a file already in this company's storage folder. The caller has checked the company is
 * the fund's and the person may write it.
 */
export async function registerCompanyDocument(
  admin: SupabaseClient,
  ctx: { fundId: string; userId: string },
  companyId: string,
  input: CompanyDocumentInput,
): Promise<Outcome<RegisteredDocument>> {
  const { storagePath, filename, fileType, fileSize, textOnly } = input
  if (!storagePath || !filename || !fileType) return fail(400, 'Missing required fields')

  // Tenant scoping: the key is `${fundId}/${companyId}/...`. Without this check a fund member could
  // pass another tenant's storage path (the bucket is shared and this uses the service-role client),
  // reading its text or deleting it via the remove() calls below.
  if (!isCompanyDocumentPath(ctx.fundId, companyId, storagePath)) {
    return fail(400, 'Invalid storage path')
  }

  const db = admin as any
  const { data: fileData, error: downloadError } = await db.storage.from(COMPANY_DOCUMENT_BUCKET).download(storagePath)
  if (downloadError || !fileData) return fail(500, 'Failed to download file from storage')
  const buffer = Buffer.from(await fileData.arrayBuffer())

  const row = {
    company_id: companyId,
    fund_id: ctx.fundId,
    filename,
    file_type: fileType,
    file_size: fileSize ?? buffer.length,
    uploaded_by: ctx.userId,
    uploaded_via: input.via ?? 'web',
  }

  // Scan for security threats before processing; an unsafe file is deleted. Its row stays, marked
  // removed with no file or text, so the holding's list shows the file was tried.
  const scanResult = await scanFileAsync(buffer, filename, fileType)
  if (!scanResult.safe) {
    await db.storage.from(COMPANY_DOCUMENT_BUCKET).remove([storagePath])
    // Without the scan_status column (migration not applied) the row would read as a clean file: skip it.
    const removed = await db.from('company_documents').insert({
      ...row, storage_path: null, extracted_text: null, has_native_content: false,
      scan_status: 'removed', hashed_at: new Date().toISOString(),
    })
    if (removed.error && removed.error.code !== '42703') console.error('[company-documents] removed-file row not recorded:', removed.error.message)
    return fail(400, `File rejected: ${scanResult.reason}`)
  }

  // The hashes the duplicate check compares (lib/companies/document-hashes.ts).
  const fp = input.fingerprint ?? await fingerprintFile(buffer, filename, fileType)
  const hashes = {
    sha256: fp.sha256, text_sha256: fp.textSha256, page_count: fp.pageCount, hashed_at: new Date().toISOString(),
  }

  // For textOnly PDFs/images, skip the expensive base64 conversion since they don't produce
  // extractedText. They stay in storage for native viewing.
  const ext = filename.split('.').pop()?.toLowerCase() ?? ''
  const isPdfOrImage =
    fileType === 'application/pdf' || ext === 'pdf' ||
    fileType.startsWith('image/') || ['jpg', 'jpeg', 'png', 'gif', 'webp'].includes(ext)

  if (textOnly && isPdfOrImage) {
    const { data: inserted, error } = await insertDocument(db,
      { ...row, ...hashes, storage_path: storagePath, extracted_text: null, has_native_content: true })
    if (error) return dbFail(error, 'companies-id-documents')
    logActivity(admin as any, ctx.fundId, ctx.userId, 'company.document_upload', { companyId })
    return done({ success: true, textOnly: false, documentId: inserted?.id ?? null, sha256: fp.sha256, textSha256: fp.textSha256 })
  }

  const result = await extractFromBuffer(buffer, filename, fileType)

  // In textOnly mode, decide whether the original can be discarded: a file that yields text
  // (DOCX/PPTX/XLSX/CSV) is stored as text only; one that relies on native content stays.
  const canDiscardFile = !!textOnly && !!result.extractedText
  const { data: inserted, error } = await insertDocument(db, {
    ...row,
    // Kept even when only the text is: it is still the hash of what was uploaded, so a re-upload matches.
    ...hashes,
    storage_path: canDiscardFile ? null : storagePath,
    extracted_text: result.extractedText || null,
    has_native_content: canDiscardFile ? false : !!result.base64Content,
  })
  if (error) return dbFail(error, 'companies-id-documents')

  if (canDiscardFile) await db.storage.from(COMPANY_DOCUMENT_BUCKET).remove([storagePath])
  logActivity(admin as any, ctx.fundId, ctx.userId, 'company.document_upload', { companyId })
  return done({ success: true, textOnly: canDiscardFile, documentId: inserted?.id ?? null, sha256: fp.sha256, textSha256: fp.textSha256 })
}
