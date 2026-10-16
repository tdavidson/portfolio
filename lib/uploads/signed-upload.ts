// Uploading a file from an assistant without passing it through the chat.
//
// A file sent as base64 in a tool call travels through the model's context and the JSON-RPC body,
// which caps it at a few megabytes and spends the conversation on bytes. Instead an upload-URL tool
// mints a Supabase Storage signed upload URL (createSignedUploadUrl) at a path the SERVER chose, the
// assistant's own environment (Claude Code, Claude desktop: anything that can read the person's
// folder and run curl) PUTs the file straight to storage, and a second tool registers the path, so
// the app takes the file in exactly as it does a browser upload: the same scan, extraction and row.
//
// Two shapes of target:
//   * a file whose final home is a path the browser would also upload to (a data room, a company's
//     documents, an LP document, an email's attachments): the URL points there and the register
//     tool runs the route's own registration;
//   * a file the app takes in as BYTES (a deck on a new inbound deal, a file in a company update),
//     where the pipeline stores it itself: the URL points at a per-fund staging folder, and the tool
//     that consumes it reads the bytes back (readStagedUploads) and removes the staged copy.

import crypto from 'crypto'
import type { SupabaseClient } from '@supabase/supabase-js'
import { fileExt, sanitizeFilename } from '@/lib/deals/submission-validation'

/** Supabase signed upload URLs are valid for two hours (storage-js createSignedUploadUrl). */
export const SIGNED_UPLOAD_TTL_SECONDS = 2 * 60 * 60

const CONTENT_TYPES: Record<string, string> = {
  pdf: 'application/pdf',
  doc: 'application/msword',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xls: 'application/vnd.ms-excel',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  ppt: 'application/vnd.ms-powerpoint',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  csv: 'text/csv',
  txt: 'text/plain',
  md: 'text/markdown',
  json: 'application/json',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  mp3: 'audio/mpeg',
  m4a: 'audio/mp4',
  wav: 'audio/wav',
  mp4: 'video/mp4',
  mov: 'video/quicktime',
  zip: 'application/zip',
}

/** The content type a file's name implies, or the generic one. */
export function contentTypeFor(fileName: string): string {
  return CONTENT_TYPES[fileExt(fileName)] ?? 'application/octet-stream'
}

/** A file name as the assistant gave it, trimmed and made safe for a storage key. */
export function uploadFileName(v: unknown): string {
  const raw = typeof v === 'string' ? v.trim() : ''
  if (!raw) throw new Error('fileName is required (the file\'s name, with its extension).')
  return sanitizeFilename(raw.split(/[\\/]/).pop() || raw)
}

/** Refuse a declared size over the limit before minting anything. */
export function checkDeclaredSize(sizeBytes: unknown, maxBytes: number): void {
  const n = Number(sizeBytes)
  if (Number.isFinite(n) && n > maxBytes) throw new Error(`That file is ${mb(n)}; the limit here is ${mb(maxBytes)}.`)
}

export const mb = (bytes: number) => `${Math.round((bytes / (1024 * 1024)) * 10) / 10} MB`

export interface SignedUpload {
  /** PUT the file's bytes here. */
  uploadUrl: string
  method: 'PUT'
  /** Send exactly these headers with the PUT. */
  headers: Record<string, string>
  /** The command, with the file's path on the person's machine to fill in. */
  curl: string
  storagePath: string
  maxBytes: number
  expiresInSeconds: number
  expiresAt: string
  /** What to call once the PUT returns 200. */
  next: string
  /** Stated once, in every result, so an assistant never asks the person to paste a file. */
  howTo: string
}

/** Mint a signed upload URL at a path the server chose, in the result shape every upload tool returns. */
export async function mintSignedUpload(
  admin: SupabaseClient,
  opts: { bucket: string; storagePath: string; fileName: string; contentType?: unknown; maxBytes: number; next: string },
): Promise<SignedUpload> {
  const { data, error } = await (admin as any).storage.from(opts.bucket).createSignedUploadUrl(opts.storagePath)
  if (error || !data?.signedUrl) throw new Error('Could not start the upload. Try again in a moment.')
  return signedUploadResult({ ...opts, signedUrl: data.signedUrl as string })
}

/** The result shape for a URL already minted (by a route's own function). */
export function signedUploadResult(
  opts: { signedUrl: string; storagePath: string; fileName: string; contentType?: unknown; maxBytes: number; next: string },
): SignedUpload {
  const contentType = typeof opts.contentType === 'string' && opts.contentType.trim() ? opts.contentType.trim() : contentTypeFor(opts.fileName)
  const headers = { 'Content-Type': contentType, 'x-upsert': 'false' }
  return {
    uploadUrl: opts.signedUrl,
    method: 'PUT',
    headers,
    curl: `curl -sS -X PUT -H "Content-Type: ${contentType}" -H "x-upsert: false" --data-binary @"<path to ${opts.fileName}>" "${opts.signedUrl}"`,
    storagePath: opts.storagePath,
    maxBytes: opts.maxBytes,
    expiresInSeconds: SIGNED_UPLOAD_TTL_SECONDS,
    expiresAt: new Date(Date.now() + SIGNED_UPLOAD_TTL_SECONDS * 1000).toISOString(),
    next: opts.next,
    howTo: UPLOAD_HOW_TO,
  }
}

/**
 * The instruction every upload-URL tool's description carries (and every result repeats): the file
 * goes from the person's folder to storage, never through the chat.
 */
export const UPLOAD_HOW_TO =
  'Never ask the person to paste or attach the file in chat. Ask them to save it in a folder (for example their ' +
  'data-room folder) and tell you its path; then, from your own environment, PUT it to uploadUrl exactly as in `curl` ' +
  '(curl -X PUT -H "Content-Type: <type>" -H "x-upsert: false" --data-binary @"<path>" "<uploadUrl>"), and when it ' +
  'returns 200 call the register tool with storagePath. The URL works once and expires in 2 hours. If you cannot ' +
  'read files or run curl, say so: the person can upload it in the app instead.'

// ── Staging: files the app takes in as bytes ─────────────────────────────────────────────────────

/** Staged files live in the private email-attachments bucket (25 MB per object), under the fund. */
export const STAGING_BUCKET = 'email-attachments'

export type StagingPurpose = 'deal' | 'update'

export function stagingPath(fundId: string, purpose: StagingPurpose, fileName: string): string {
  return `agent-staging/${fundId}/${purpose}/${crypto.randomUUID()}_${fileName}`
}

export interface StagedUploadRef { storage_path?: unknown; filename?: unknown; content_type?: unknown }

export interface StagedFile { name: string; type: string; bytes: Buffer; storagePath: string }

/**
 * Read back files an assistant PUT to staging URLs this fund minted for this purpose. Refuses a
 * path outside that folder (another fund's, or another purpose's), a missing upload, and one over
 * the limit. The caller removes the staged copies with removeStaged once it has stored its own.
 */
export async function readStagedUploads(
  admin: SupabaseClient,
  fundId: string,
  purpose: StagingPurpose,
  refs: unknown,
  limits: { maxFiles: number; maxBytes: number },
): Promise<StagedFile[]> {
  if (refs == null) return []
  if (!Array.isArray(refs)) throw new Error('uploaded_files must be a list of { storage_path, filename }.')
  if (refs.length > limits.maxFiles) throw new Error(`At most ${limits.maxFiles} files.`)
  const prefix = `agent-staging/${fundId}/${purpose}/`
  const out: StagedFile[] = []
  for (const ref of refs as StagedUploadRef[]) {
    const path = typeof ref?.storage_path === 'string' ? ref.storage_path : ''
    if (!path.startsWith(prefix) || path.includes('..')) {
      throw new Error(`${path || 'That upload'} is not one of this fund's uploads for this. Use the storagePath the upload-URL tool returned.`)
    }
    const { data: blob, error } = await (admin as any).storage.from(STAGING_BUCKET).download(path)
    if (error || !blob) throw new Error(`Nothing has been uploaded to ${path} yet. PUT the file to the upload URL first.`)
    const bytes = Buffer.from(await blob.arrayBuffer())
    if (bytes.length === 0) throw new Error(`${path} is empty.`)
    if (bytes.length > limits.maxBytes) {
      await removeStaged(admin, [path])
      throw new Error(`${path.split('/').pop()} is over ${mb(limits.maxBytes)}.`)
    }
    const stored = path.slice(prefix.length).replace(/^[0-9a-f-]{36}_/, '')
    const name = sanitizeFilename(typeof ref.filename === 'string' && ref.filename.trim() ? ref.filename.trim() : stored)
    const type = typeof ref.content_type === 'string' && ref.content_type.trim() ? ref.content_type.trim() : contentTypeFor(name)
    out.push({ name, type, bytes, storagePath: path })
  }
  return out
}

export async function removeStaged(admin: SupabaseClient, paths: string[]): Promise<void> {
  if (paths.length === 0) return
  try {
    await (admin as any).storage.from(STAGING_BUCKET).remove(paths)
  } catch {
    // Best effort: a staged copy left behind is never read again.
  }
}
