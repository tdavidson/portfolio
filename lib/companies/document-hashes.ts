// The hashes behind a holding's duplicate check (lib/companies/document-fingerprint.ts says what
// they are), and the backfill that fills them for files stored before they existed.
//
// The backfill is deliberately slow and steady: a bounded batch of rows per run, one row at a time,
// each read and written on its own, so it never puts the database under load (the worker,
// app/api/cron/document-hashes, starts its next run itself while rows remain). Checking one
// holding also hashes that holding's own missing rows first, so a duplicate check is right the
// first time it runs, before the backfill reaches that holding.

import type { SupabaseClient } from '@supabase/supabase-js'
import { COMPANY_DOCUMENT_BUCKET } from './documents'
import { fingerprintFile, sha256Hex, textSha256 } from './document-fingerprint'

export const EMAIL_ATTACHMENT_BUCKET = 'email-attachments'

type Admin = SupabaseClient

export interface DuplicateMatch {
  id: string
  source: 'document' | 'update'
  update_id: string | null
  filename: string
  uploaded_at: string | null
  /** Which hash matched: the stored bytes, or the normalised text. */
  matched_on: 'sha256' | 'text_sha256'
}

async function download(admin: Admin, bucket: string, path: string): Promise<Buffer | null> {
  try {
    const { data, error } = await (admin as any).storage.from(bucket).download(path)
    if (error || !data) return null
    return Buffer.from(await data.arrayBuffer())
  } catch {
    return null
  }
}

/** Hash one uploaded document from its stored bytes (or, when only text was kept, its text). */
export async function hashCompanyDocument(admin: Admin, row: {
  id: string; filename: string; file_type: string | null; storage_path: string | null; scan_status?: string | null
}): Promise<{ sha256: string | null; text_sha256: string | null }> {
  const db = admin as any
  const now = new Date().toISOString()
  let sha256: string | null = null
  let text: string | null = null
  let pageCount: number | null = null
  if (row.scan_status !== 'removed' && row.storage_path) {
    const bytes = await download(admin, COMPANY_DOCUMENT_BUCKET, row.storage_path)
    if (bytes) {
      const fp = await fingerprintFile(bytes, row.filename, row.file_type)
      sha256 = fp.sha256
      text = fp.text
      pageCount = fp.pageCount
    }
  }
  if (!text && row.scan_status !== 'removed') {
    // Kept as text only (over 10 MB), or the stored file could not be read: the kept text still compares.
    const { data } = await db.from('company_documents').select('extracted_text').eq('id', row.id).maybeSingle()
    text = (data as { extracted_text?: string | null } | null)?.extracted_text ?? null
  }
  const text_sha256 = textSha256(text)
  await db.from('company_documents')
    .update({ sha256, text_sha256, page_count: pageCount, hashed_at: now })
    .eq('id', row.id)
  return { sha256, text_sha256 }
}

/** Hash one update attachment: its text is already in the row; its bytes only when no hash was kept. */
export async function hashUpdateArtifact(admin: Admin, row: {
  id: string; content_sha256: string | null; storage_path: string | null
}): Promise<{ sha256: string | null; text_sha256: string | null }> {
  const db = admin as any
  const { data } = await db.from('company_update_artifacts').select('extracted_text').eq('id', row.id).maybeSingle()
  const text_sha256 = textSha256((data as { extracted_text?: string | null } | null)?.extracted_text ?? null)
  let sha256 = row.content_sha256
  if (!sha256 && row.storage_path) {
    const bytes = await download(admin, EMAIL_ATTACHMENT_BUCKET, row.storage_path)
    if (bytes) sha256 = sha256Hex(bytes)
  }
  const patch: Record<string, unknown> = { text_sha256, hashed_at: new Date().toISOString() }
  if (sha256 && sha256 !== row.content_sha256) patch.content_sha256 = sha256
  await db.from('company_update_artifacts').update(patch).eq('id', row.id)
  return { sha256, text_sha256 }
}

export interface BackfillOptions {
  /** Only this fund / holding. Omit for every fund (the worker). */
  fundId?: string
  companyId?: string
  maxDocuments?: number
  maxArtifacts?: number
  /** Stop starting new rows after this long. */
  timeBudgetMs?: number
}

export interface BackfillOutcome {
  documents: number
  artifacts: number
  /** True when unhashed rows may remain (the batch was full or the budget ran out). */
  more: boolean
}

/**
 * Hash a bounded batch of rows that have no hashes yet, oldest first, one at a time. Safe to run
 * twice at once: a row hashed twice gets the same values.
 */
export async function backfillDocumentHashes(admin: Admin, opts: BackfillOptions = {}): Promise<BackfillOutcome> {
  const db = admin as any
  const started = Date.now()
  const budget = opts.timeBudgetMs ?? 240_000
  const maxDocs = opts.maxDocuments ?? 25
  const maxArts = opts.maxArtifacts ?? 200
  const scoped = (q: any) => {
    let out = q.is('hashed_at', null)
    if (opts.fundId) out = out.eq('fund_id', opts.fundId)
    if (opts.companyId) out = out.eq('company_id', opts.companyId)
    return out
  }
  const out: BackfillOutcome = { documents: 0, artifacts: 0, more: false }

  if (maxDocs > 0) {
    const { data: docs, error } = await scoped(db.from('company_documents')
      .select('id, filename, file_type, storage_path, scan_status'))
      .order('created_at', { ascending: true }).limit(maxDocs)
    if (error) throw new Error(`Documents to hash could not be read: ${error.message}`)
    for (const row of (docs ?? []) as any[]) {
      if (Date.now() - started > budget) { out.more = true; break }
      await hashCompanyDocument(admin, row)
      out.documents++
    }
    if ((docs ?? []).length === maxDocs) out.more = true
  }

  if (maxArts > 0 && Date.now() - started <= budget) {
    const { data: arts, error } = await scoped(db.from('company_update_artifacts')
      .select('id, content_sha256, storage_path'))
      .order('created_at', { ascending: true }).limit(maxArts)
    if (error) throw new Error(`Update files to hash could not be read: ${error.message}`)
    for (const row of (arts ?? []) as any[]) {
      if (Date.now() - started > budget) { out.more = true; break }
      await hashUpdateArtifact(admin, row)
      out.artifacts++
    }
    if ((arts ?? []).length === maxArts) out.more = true
  } else if (maxArts > 0) {
    out.more = true
  }
  return out
}

/**
 * A file already on this holding with the same bytes or the same text, or null. The holding's own
 * unhashed rows are hashed first (a bounded number), so the answer does not wait for the backfill.
 */
export async function findDuplicateDocument(
  admin: Admin,
  ctx: { fundId: string; companyId: string },
  hashes: { sha256: string | null; textSha256: string | null },
  opts: { excludeDocumentId?: string } = {},
): Promise<DuplicateMatch | null> {
  if (!hashes.sha256 && !hashes.textSha256) return null
  await backfillDocumentHashes(admin, { fundId: ctx.fundId, companyId: ctx.companyId, maxDocuments: 20, maxArtifacts: 100, timeBudgetMs: 30_000 })
  const db = admin as any
  const either = (byteCol: string) => [
    hashes.sha256 ? `${byteCol}.eq.${hashes.sha256}` : null,
    hashes.textSha256 ? `text_sha256.eq.${hashes.textSha256}` : null,
  ].filter(Boolean).join(',')

  const [docs, arts] = await Promise.all([
    db.from('company_documents').select('id, filename, created_at, sha256, text_sha256')
      .eq('fund_id', ctx.fundId).eq('company_id', ctx.companyId).neq('scan_status', 'removed')
      .or(either('sha256')).order('created_at', { ascending: true }).limit(10),
    db.from('company_update_artifacts')
      .select('id, update_id, filename, created_at, content_sha256, text_sha256, company_updates(received_at)')
      .eq('fund_id', ctx.fundId).eq('company_id', ctx.companyId)
      .or(either('content_sha256')).order('created_at', { ascending: true }).limit(10),
  ])
  if (docs.error) throw new Error(`Duplicate check failed: ${docs.error.message}`)
  if (arts.error) throw new Error(`Duplicate check failed: ${arts.error.message}`)

  const candidates: DuplicateMatch[] = [
    ...((docs.data ?? []) as any[])
      .filter(d => d.id !== opts.excludeDocumentId)
      .map(d => ({
        id: d.id, source: 'document' as const, update_id: null, filename: d.filename, uploaded_at: d.created_at ?? null,
        matched_on: (hashes.sha256 && d.sha256 === hashes.sha256 ? 'sha256' : 'text_sha256') as DuplicateMatch['matched_on'],
      })),
    ...((arts.data ?? []) as any[]).map(a => ({
      id: a.id, source: 'update' as const, update_id: a.update_id, filename: a.filename,
      uploaded_at: a.company_updates?.received_at ?? a.created_at ?? null,
      matched_on: (hashes.sha256 && a.content_sha256 === hashes.sha256 ? 'sha256' : 'text_sha256') as DuplicateMatch['matched_on'],
    })),
  ]
  if (candidates.length === 0) return null
  // A byte match is the stronger claim; among equals, the first file on record.
  candidates.sort((a, b) =>
    (a.matched_on === 'sha256' ? 0 : 1) - (b.matched_on === 'sha256' ? 0 : 1)
    || String(a.uploaded_at ?? '').localeCompare(String(b.uploaded_at ?? '')))
  return candidates[0]
}
