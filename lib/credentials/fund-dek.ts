import type { SupabaseClient } from '@supabase/supabase-js'
import { encrypt, decrypt } from '@/lib/crypto'

/**
 * A fund's data-encryption key (DEK), for secrets stored per user or per fund.
 *
 * Storage follows the repo's envelope-encryption pattern (see 20260227000002_funds.sql): a secret
 * is encrypted with the fund's DEK, and the DEK is itself encrypted with the master KEK in
 * process.env.ENCRYPTION_KEY.
 */

/**
 * Fetch the fund's DEK, minting one if the fund doesn't have it yet. Mirrors the "reuse existing
 * DEK or create one" logic in app/api/settings/route.ts, so a fund that has never stored a secret
 * can still connect a per-user integration.
 */
export async function getOrCreateFundDek(admin: SupabaseClient, fundId: string): Promise<string> {
  const kek = process.env.ENCRYPTION_KEY
  if (!kek) throw new Error('ENCRYPTION_KEY is not configured')

  const { data } = await admin
    .from('fund_settings')
    .select('encryption_key_encrypted')
    .eq('fund_id', fundId)
    .maybeSingle()

  const existing = (data as any)?.encryption_key_encrypted as string | null | undefined
  if (existing) return decrypt(existing, kek)

  // Mint a fresh 256-bit DEK and persist it wrapped under the KEK.
  const { randomBytes } = await import('crypto')
  const dek = randomBytes(32).toString('hex')
  const { error } = await admin
    .from('fund_settings')
    .update({ encryption_key_encrypted: encrypt(dek, kek) } as any)
    .eq('fund_id', fundId)
  if (error) throw new Error(`Failed to store encryption key: ${error.message}`)
  return dek
}

/** The fund's DEK, or null when the fund has none or ENCRYPTION_KEY is unset. */
export async function getFundDek(admin: SupabaseClient, fundId: string): Promise<string | null> {
  const kek = process.env.ENCRYPTION_KEY
  if (!kek) return null
  const { data } = await admin
    .from('fund_settings')
    .select('encryption_key_encrypted')
    .eq('fund_id', fundId)
    .maybeSingle()
  const enc = (data as any)?.encryption_key_encrypted as string | null | undefined
  if (!enc) return null
  return decrypt(enc, kek)
}
