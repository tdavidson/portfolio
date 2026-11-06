// The fund's own Google Drive connection: an access token from its stored refresh token.

import type { SupabaseClient } from '@supabase/supabase-js'
import { decrypt } from '@/lib/crypto'
import { getGoogleCredentials } from '@/lib/google/credentials'
import { getAccessToken } from '@/lib/google/drive'
import { done, fail, type Outcome } from '@/lib/service-outcome'

export async function fundDriveToken(admin: SupabaseClient, fundId: string): Promise<Outcome<{ accessToken: string; folderId: string }>> {
  const { data: settings } = await (admin as any)
    .from('fund_settings')
    .select('google_refresh_token_encrypted, encryption_key_encrypted, google_drive_folder_id')
    .eq('fund_id', fundId)
    .maybeSingle()
  if (!settings?.google_refresh_token_encrypted || !settings?.encryption_key_encrypted) {
    return fail(400, 'Google Drive not connected')
  }
  const kek = process.env.ENCRYPTION_KEY
  if (!kek) return fail(500, 'Server misconfiguration')
  const dek = decrypt(settings.encryption_key_encrypted, kek)
  const refreshToken = decrypt(settings.google_refresh_token_encrypted, dek)
  const creds = await getGoogleCredentials(admin as any, fundId)
  if (!creds) return fail(400, 'Google OAuth credentials not configured')
  const accessToken = await getAccessToken(refreshToken, creds.clientId, creds.clientSecret)
  return done({ accessToken, folderId: settings.google_drive_folder_id || 'root' })
}
