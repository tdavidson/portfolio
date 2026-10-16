import type { SupabaseClient } from '@supabase/supabase-js'

interface GoogleCredentials {
  clientId: string
  clientSecret: string
}

/**
 * Get Google OAuth credentials for a fund: from Settings, else GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET.
 */
export async function getGoogleCredentials(
  admin: SupabaseClient,
  fundId: string
): Promise<GoogleCredentials | null> {
  const { data: settings } = await admin
    .from('fund_settings')
    .select('google_client_id, google_client_secret_encrypted, encryption_key_encrypted')
    .eq('fund_id', fundId)
    .single()

  if (settings?.google_client_id && settings?.google_client_secret_encrypted && settings?.encryption_key_encrypted) {
    const kek = process.env.ENCRYPTION_KEY
    if (kek) {
      const { decrypt } = await import('@/lib/crypto')
      const dek = decrypt(settings.encryption_key_encrypted, kek)
      const clientSecret = decrypt(settings.google_client_secret_encrypted, dek)
      return {
        clientId: settings.google_client_id,
        clientSecret,
      }
    }
  }

  // None saved in Settings: the deployment's environment (lib/credentials/env.ts). A client id saved
  // in Settings still pairs with an environment secret, so either half can come from either place.
  const { envCredential } = await import('@/lib/credentials/env')
  const clientId = settings?.google_client_id || envCredential('google_client_id')
  const clientSecret = envCredential('google_client_secret')
  if (clientId && clientSecret) return { clientId, clientSecret }

  return null
}
