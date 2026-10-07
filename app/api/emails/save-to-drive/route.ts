import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { assertWriteAccess } from '@/lib/api-helpers'
import { dbError } from '@/lib/api-error'
import { rateLimit } from '@/lib/rate-limit'
import { decrypt } from '@/lib/crypto'
import { getAccessToken as getGoogleAccessToken, findOrCreateFolder as findOrCreateGoogleFolder, uploadFile as uploadGoogleFile } from '@/lib/google/drive'
import { getGoogleCredentials } from '@/lib/google/credentials'
import { hydrateAttachments } from '@/lib/parsing/extractAttachmentText'
import { loadEntityScopeForUser } from '@/lib/access/entity-scope'
import { filterByCompany } from '@/lib/access/scope'

// POST — save one or more emails to file storage (Google Drive)
export async function POST(req: NextRequest) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  // Rate limit: 30 requests per 5 minutes per user
  const limited = await rateLimit({ key: `save-drive:${user.id}`, limit: 30, windowSeconds: 300 })
  if (limited) return limited

  const admin = createAdminClient()

  const writeCheck = await assertWriteAccess(admin, user.id)
  if (writeCheck instanceof NextResponse) return writeCheck

  const { data: membership } = await admin
    .from('fund_members')
    .select('fund_id')
    .eq('user_id', user.id)
    .maybeSingle()

  if (!membership) return NextResponse.json({ error: 'No fund found' }, { status: 403 })

  const body = await req.json()
  const emailIds: string[] = body.emailIds ?? (body.emailId ? [body.emailId] : [])

  if (emailIds.length === 0) {
    return NextResponse.json({ error: 'No email IDs provided' }, { status: 400 })
  }

  // Check file storage provider
  const { data: settings } = await admin
    .from('fund_settings')
    .select('file_storage_provider, google_refresh_token_encrypted, encryption_key_encrypted, google_drive_folder_id')
    .eq('fund_id', membership.fund_id)
    .single()

  const provider = settings?.file_storage_provider
  if (!provider) {
    return NextResponse.json({ error: 'No file storage provider configured' }, { status: 400 })
  }

  const kek = process.env.ENCRYPTION_KEY
  if (!kek) return NextResponse.json({ error: 'Server misconfiguration' }, { status: 500 })
  if (!settings?.encryption_key_encrypted) {
    return NextResponse.json({ error: 'Encryption not configured' }, { status: 500 })
  }

  let dek: string
  try {
    dek = decrypt(settings.encryption_key_encrypted, kek)
  } catch (err) {
    console.error('[save-to-drive] Failed to decrypt encryption key:', err)
    return NextResponse.json({ error: 'Failed to decrypt credentials' }, { status: 500 })
  }

  // Set up provider-specific upload functions
  let uploadEmail: (companyName: string, dateStr: string, subject: string, emailBody: string, companyInfo: { google_drive_folder_id: string | null } | null) => Promise<void>
  let uploadAttachment: (companyName: string, name: string, content: Buffer, companyInfo: { google_drive_folder_id: string | null } | null) => Promise<void>

  try {
    if (provider === 'google_drive') {
      if (!settings.google_refresh_token_encrypted || !settings.google_drive_folder_id) {
        return NextResponse.json({ error: 'Google Drive not connected or no folder selected' }, { status: 400 })
      }
      const refreshToken = decrypt(settings.google_refresh_token_encrypted, dek)
      const creds = await getGoogleCredentials(admin, membership.fund_id)
      if (!creds?.clientId || !creds?.clientSecret) {
        return NextResponse.json({ error: 'Google OAuth credentials not configured' }, { status: 400 })
      }
      const accessToken = await getGoogleAccessToken(refreshToken, creds.clientId, creds.clientSecret)
      const rootFolderId = settings.google_drive_folder_id

      uploadEmail = async (companyName, dateStr, subject, emailBody, companyInfo) => {
        const folderId = companyInfo?.google_drive_folder_id || await findOrCreateGoogleFolder(accessToken, rootFolderId, companyName)
        await uploadGoogleFile(accessToken, folderId, `${dateStr}_${subject}.txt`, emailBody, 'text/plain')
      }
      uploadAttachment = async (companyName, name, content, companyInfo) => {
        const safeName = name.replace(/[\/\\:*?"<>|]/g, '_').replace(/\.\./g, '_')
        const folderId = companyInfo?.google_drive_folder_id || await findOrCreateGoogleFolder(accessToken, rootFolderId, companyName)
        await uploadGoogleFile(accessToken, folderId, safeName, content, 'application/octet-stream')
      }
    } else {
      return NextResponse.json({ error: `Unknown storage provider: ${provider}` }, { status: 400 })
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Unknown error'
    console.error('[save-to-drive] Provider setup failed:', msg)
    return NextResponse.json({ error: 'Storage connection failed. Check your credentials in Settings.' }, { status: 500 })
  }

  // Fetch the emails with their company info
  // Only emails about companies the caller can see.
  const scope = await loadEntityScopeForUser(admin, user.id)
  const { data: emails, error: emailsError } = await filterByCompany(admin
    .from('inbound_emails')
    .select('id, subject, company_id, raw_payload, received_at')
    .eq('fund_id', membership.fund_id)
    .in('id', emailIds), scope ? scope.companyIds : [])

  if (emailsError) {
    return dbError(emailsError, 'emails-save-to-drive')
  }

  if (!emails || emails.length === 0) {
    return NextResponse.json({ error: 'No matching emails found' }, { status: 404 })
  }

  // Get company info for subfolder creation
  const companyIds = Array.from(new Set(emails.map(e => e.company_id).filter(Boolean))) as string[]
  const companiesMap: Record<string, { name: string; google_drive_folder_id: string | null }> = {}

  if (companyIds.length > 0) {
    const { data: companies } = await admin
      .from('companies')
      .select('id, name, google_drive_folder_id')
      .in('id', companyIds)

    for (const c of companies ?? []) {
      companiesMap[c.id] = { name: c.name, google_drive_folder_id: c.google_drive_folder_id }
    }
  }

  // Save each email
  let saved = 0
  let failed = 0
  const errors: string[] = []

  for (const email of emails) {
    try {
      const rawPayload = email.raw_payload as Record<string, unknown> | null
      if (!rawPayload) {
        errors.push(`${email.id}: no payload stored`)
        failed++
        continue
      }

      // Hydrate attachments from Storage (downloads Content from email-attachments bucket)
      const payload = await hydrateAttachments(rawPayload as import('@/lib/parsing/extractAttachmentText').PostmarkPayload)

      const companyInfo = email.company_id ? companiesMap[email.company_id] : null
      const companyName = companyInfo?.name ?? (email.company_id ? 'Unknown Company' : 'Unidentified')

      const dateStr = new Date(email.received_at ?? new Date().toISOString()).toISOString().slice(0, 10)
      const subject = (((payload as Record<string, unknown>).Subject as string) ?? '')
        .replace(/[^a-zA-Z0-9 _-]/g, '')
        .slice(0, 60) || 'Report'
      const emailBody = (payload.TextBody as string) || (payload.HtmlBody as string) || '(no body)'

      await uploadEmail(companyName, dateStr, subject, emailBody, companyInfo)

      const attachments = (payload.Attachments as Array<{
        Name: string
        ContentType: string
        Content?: string
      }>) ?? []

      let attachmentsSaved = 0
      let attachmentErrors = 0
      for (const att of attachments) {
        if (!att.Content) {
          console.warn(`[save-to-drive] Attachment "${att.Name}" has no Content, skipping`)
          continue
        }
        try {
          const content = Buffer.from(att.Content, 'base64')
          console.log(`[save-to-drive] Uploading attachment "${att.Name}" (${content.length} bytes)`)
          await uploadAttachment(companyName, att.Name, content, companyInfo)
          attachmentsSaved++
        } catch (attErr) {
          attachmentErrors++
          const msg = attErr instanceof Error ? attErr.message : 'Unknown error'
          console.error(`[save-to-drive] Attachment "${att.Name}" failed:`, msg)
          errors.push(`Attachment "${att.Name}": ${msg}`)
        }
      }

      saved++
      if (attachmentErrors > 0) {
        errors.push(`${attachmentErrors} of ${attachments.length} attachment(s) failed to upload`)
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Unknown error'
      errors.push(`${email.id}: ${msg}`)
      failed++
    }
  }

  return NextResponse.json({ saved, failed, errors: errors.length > 0 ? errors : undefined })
}
