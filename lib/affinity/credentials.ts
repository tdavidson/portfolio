import type { SupabaseClient } from '@supabase/supabase-js'
import { encrypt, decrypt } from '@/lib/crypto'
import { getOrCreateFundDek, getFundDek } from '@/lib/credentials/fund-dek'

/**
 * Affinity API keys are issued PER USER and scoped to that user's Affinity
 * permissions — so we store one key per user, not one per fund. The data a key
 * pulls still lands in the shared, fund-scoped data room; only the credential is
 * personal.
 *
 * The key is encrypted with the fund's DEK (lib/credentials/fund-dek.ts).
 */

/** Store (or replace) a user's Affinity API key. */
export async function saveAffinityKey(
  admin: SupabaseClient,
  params: {
    userId: string
    fundId: string
    apiKey: string
    affinityUserEmail?: string | null
    affinityUserName?: string | null
  }
): Promise<void> {
  const dek = await getOrCreateFundDek(admin, params.fundId)
  const { error } = await (admin as any)
    .from('affinity_credentials')
    .upsert({
      user_id: params.userId,
      fund_id: params.fundId,
      api_key_encrypted: encrypt(params.apiKey, dek),
      affinity_user_email: params.affinityUserEmail ?? null,
      affinity_user_name: params.affinityUserName ?? null,
      last_verified_at: new Date().toISOString(),
      last_error: null,
      updated_at: new Date().toISOString(),
    }, { onConflict: 'user_id' })
  if (error) throw new Error(`Failed to save Affinity key: ${error.message}`)
}

/**
 * Decrypt a user's Affinity API key. Returns null when the user has not
 * connected Affinity — callers treat that as "this capability is unavailable
 * for this user", not as an error.
 */
export async function getAffinityKey(
  admin: SupabaseClient,
  userId: string
): Promise<string | null> {
  const { data } = await (admin as any)
    .from('affinity_credentials')
    .select('api_key_encrypted, fund_id')
    .eq('user_id', userId)
    .maybeSingle()
  if (!data?.api_key_encrypted) return null

  const dek = await getFundDek(admin, (data as any).fund_id as string)
  if (!dek) return null

  try {
    return decrypt((data as any).api_key_encrypted as string, dek)
  } catch {
    // Key was encrypted under a DEK we can no longer reproduce (KEK rotated
    // without re-wrapping). Surface as "not connected" so the user reconnects.
    return null
  }
}

/**
 * The key the BACKGROUND SYNC for a deal should run as: the user who linked the
 * deal to Affinity. Their permissions decide what the sync can see, which is the
 * point — we never widen visibility beyond a real person's own access.
 */
export async function getAffinityKeyForDeal(
  admin: SupabaseClient,
  dealId: string
): Promise<{ apiKey: string; userId: string } | null> {
  const { data: deal } = await admin
    .from('diligence_deals')
    .select('affinity_linked_by')
    .eq('id', dealId)
    .maybeSingle()

  const userId = (deal as any)?.affinity_linked_by as string | null | undefined
  if (!userId) return null

  const apiKey = await getAffinityKey(admin, userId)
  if (!apiKey) return null
  return { apiKey, userId }
}

/** Record a failed call so the UI can prompt the user to reconnect. */
export async function markAffinityKeyError(
  admin: SupabaseClient,
  userId: string,
  message: string
): Promise<void> {
  await (admin as any)
    .from('affinity_credentials')
    .update({ last_error: message.slice(0, 500), updated_at: new Date().toISOString() })
    .eq('user_id', userId)
}

/** Clear the error flag after a call succeeds. */
export async function markAffinityKeyOk(
  admin: SupabaseClient,
  userId: string
): Promise<void> {
  await (admin as any)
    .from('affinity_credentials')
    .update({
      last_error: null,
      last_verified_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    })
    .eq('user_id', userId)
}

export async function deleteAffinityKey(
  admin: SupabaseClient,
  userId: string
): Promise<void> {
  await (admin as any).from('affinity_credentials').delete().eq('user_id', userId)
}
