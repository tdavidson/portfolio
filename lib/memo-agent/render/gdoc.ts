import { createAdminClient } from '@/lib/supabase/admin'
import { decrypt } from '@/lib/crypto'
import { getGoogleCredentials } from '@/lib/google/credentials'
import { exportFile, getAccessToken, uploadFile } from '@/lib/google/drive'

type Admin = ReturnType<typeof createAdminClient>

const DOCX_MIME = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'

/**
 * Resolve a Google Drive access token + the fund's default folder. Throws if
 * Drive isn't connected for the fund.
 */
async function resolveDriveAccess(admin: Admin, fundId: string): Promise<{ accessToken: string; defaultFolderId: string | null }> {
  const { data: settings } = await admin
    .from('fund_settings')
    .select('google_refresh_token_encrypted, encryption_key_encrypted, google_drive_folder_id')
    .eq('fund_id', fundId)
    .maybeSingle()
  const refreshEnc = (settings as any)?.google_refresh_token_encrypted as string | null
  const dekEnc = (settings as any)?.encryption_key_encrypted as string | null
  const defaultFolderId = (settings as any)?.google_drive_folder_id as string | null
  if (!refreshEnc || !dekEnc) throw new Error('Google Drive not connected for this fund.')

  const kek = process.env.ENCRYPTION_KEY
  if (!kek) throw new Error('ENCRYPTION_KEY not set')

  const dek = decrypt(dekEnc, kek)
  const refreshToken = decrypt(refreshEnc, dek)
  const creds = await getGoogleCredentials(admin, fundId)
  if (!creds?.clientId || !creds?.clientSecret) throw new Error('Google OAuth credentials missing')

  const accessToken = await getAccessToken(refreshToken, creds.clientId, creds.clientSecret)
  return { accessToken, defaultFolderId }
}

/**
 * Upload a Word doc Buffer to Google Drive. Drive auto-converts .docx to a
 * native Google Doc on upload, so partners get a sharable Doc URL.
 */
export async function uploadDocxToDrive(params: {
  admin: Admin
  fundId: string
  filename: string
  buffer: Buffer
  /**
   * Target Drive folder ID. When provided (e.g. the deal's own data-room
   * folder), the upload goes there instead of the fund's default
   * google_drive_folder_id (the portfolio-reports folder).
   */
  folderIdOverride?: string | null
}): Promise<{ webViewLink: string | null; fileId: string | null }> {
  const { admin, fundId, filename, buffer, folderIdOverride } = params

  const { accessToken, defaultFolderId } = await resolveDriveAccess(admin, fundId)
  const folderId = folderIdOverride || defaultFolderId
  if (!folderId) throw new Error('No Google Drive folder available. Set a data-room folder on the deal, or a default folder in Settings → Storage.')

  const fileId = await uploadFile(accessToken, folderId, filename, buffer, DOCX_MIME, { convert: true })
  return {
    fileId,
    webViewLink: fileId ? `https://docs.google.com/document/d/${fileId}/edit` : null,
  }
}

/**
 * Upload a plain-text transcript to a Google Drive folder, converted to a
 * native Google Doc so it's readable in the Drive UI. Used to mirror call
 * transcripts into the deal's data-room folder alongside the recordings.
 */
export async function uploadTranscriptToDrive(params: {
  admin: Admin
  fundId: string
  filename: string
  text: string
  folderId: string
}): Promise<{ webViewLink: string | null; fileId: string | null }> {
  const { admin, fundId, filename, text, folderId } = params

  const { accessToken } = await resolveDriveAccess(admin, fundId)
  const fileId = await uploadFile(
    accessToken,
    folderId,
    filename,
    Buffer.from(text, 'utf8'),
    'text/plain',
    { convert: true },  // plain text → native Google Doc
  )
  return {
    fileId,
    webViewLink: fileId ? `https://docs.google.com/document/d/${fileId}/edit` : null,
  }
}

/**
 * A Word memo as a PDF, converted by Google Drive so the PDF keeps the Word file's design exactly
 * (its fonts, styles, header and footer). The temporary Google Doc is deleted afterwards. Needs the
 * fund's Google Drive connection.
 */
export async function docxToPdfViaDrive(params: { admin: Admin; fundId: string; filename: string; buffer: Buffer }): Promise<Buffer> {
  const { accessToken, defaultFolderId } = await resolveDriveAccess(params.admin, params.fundId)
  if (!defaultFolderId) throw new Error('A PDF is converted through Google Drive, and no default Drive folder is set (Settings → Storage).')
  const fileId = await uploadFile(accessToken, defaultFolderId, params.filename, params.buffer, DOCX_MIME, { convert: true })
  if (!fileId) throw new Error('Google Drive did not accept the memo for conversion.')
  try {
    return await exportFile(accessToken, fileId, 'application/pdf')
  } finally {
    await fetch(`https://www.googleapis.com/drive/v3/files/${encodeURIComponent(fileId)}?supportsAllDrives=true`, {
      method: 'DELETE', headers: { Authorization: `Bearer ${accessToken}` },
    }).catch(() => {})
  }
}
