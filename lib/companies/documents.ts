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

export const COMPANY_DOCUMENT_BUCKET = 'company-documents'
/** The company page refuses a file over 20 MB. */
export const MAX_COMPANY_DOCUMENT_BYTES = 20 * 1024 * 1024
/** Over 10 MB the page asks for text only: a file that yields text is kept as its text alone. */
export const COMPANY_TEXT_ONLY_THRESHOLD = 10 * 1024 * 1024

/** The key the browser builds, `${fundId}/${companyId}/${uuid}-${name}`. */
export function companyDocumentPath(fundId: string, companyId: string, fileName: string): string {
  return `${fundId}/${companyId}/${crypto.randomUUID()}-${fileName}`
}

export interface CompanyDocumentInput {
  storagePath: string
  filename: string
  fileType: string
  fileSize?: number | null
  textOnly?: boolean
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
): Promise<Outcome<{ success: true; textOnly: boolean }>> {
  const { storagePath, filename, fileType, fileSize, textOnly } = input
  if (!storagePath || !filename || !fileType) return fail(400, 'Missing required fields')

  // Tenant scoping: the key is `${fundId}/${companyId}/...`. Without this check a fund member could
  // pass another tenant's storage path (the bucket is shared and this uses the service-role client),
  // reading its text or deleting it via the remove() calls below.
  if (!String(storagePath).startsWith(`${ctx.fundId}/${companyId}/`) || String(storagePath).includes('..')) {
    return fail(400, 'Invalid storage path')
  }

  const db = admin as any
  const { data: fileData, error: downloadError } = await db.storage.from(COMPANY_DOCUMENT_BUCKET).download(storagePath)
  if (downloadError || !fileData) return fail(500, 'Failed to download file from storage')
  const buffer = Buffer.from(await fileData.arrayBuffer())

  // Scan for security threats before processing; an unsafe file is deleted.
  const scanResult = await scanFileAsync(buffer, filename, fileType)
  if (!scanResult.safe) {
    await db.storage.from(COMPANY_DOCUMENT_BUCKET).remove([storagePath])
    return fail(400, `File rejected: ${scanResult.reason}`)
  }

  // For textOnly PDFs/images, skip the expensive base64 conversion since they don't produce
  // extractedText. They stay in storage for native viewing.
  const ext = filename.split('.').pop()?.toLowerCase() ?? ''
  const isPdfOrImage =
    fileType === 'application/pdf' || ext === 'pdf' ||
    fileType.startsWith('image/') || ['jpg', 'jpeg', 'png', 'gif', 'webp'].includes(ext)

  const row = {
    company_id: companyId,
    fund_id: ctx.fundId,
    filename,
    file_type: fileType,
    file_size: fileSize ?? buffer.length,
    uploaded_by: ctx.userId,
  }

  if (textOnly && isPdfOrImage) {
    const { error } = await db.from('company_documents').insert({ ...row, storage_path: storagePath, extracted_text: null, has_native_content: true })
    if (error) return dbFail(error, 'companies-id-documents')
    logActivity(admin as any, ctx.fundId, ctx.userId, 'company.document_upload', { companyId })
    return done({ success: true, textOnly: false })
  }

  const result = await extractFromBuffer(buffer, filename, fileType)

  // In textOnly mode, decide whether the original can be discarded: a file that yields text
  // (DOCX/PPTX/XLSX/CSV) is stored as text only; one that relies on native content stays.
  const canDiscardFile = !!textOnly && !!result.extractedText
  const { error } = await db.from('company_documents').insert({
    ...row,
    storage_path: canDiscardFile ? null : storagePath,
    extracted_text: result.extractedText || null,
    has_native_content: canDiscardFile ? false : !!result.base64Content,
  })
  if (error) return dbFail(error, 'companies-id-documents')

  if (canDiscardFile) await db.storage.from(COMPANY_DOCUMENT_BUCKET).remove([storagePath])
  logActivity(admin as any, ctx.fundId, ctx.userId, 'company.document_upload', { companyId })
  return done({ success: true, textOnly: canDiscardFile })
}
