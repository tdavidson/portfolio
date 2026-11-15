// Whether intake showed an inbound email really came from its From address (SPF/DKIM/DMARC, see
// sender-auth.ts), kept on the email so a later run of the pipeline makes the same decision.
//
// Reprocessing reads the stored payload again. Without this it had only the From header to go on,
// so a spoof stored as an outsider's mail came back as the member's on the second run.

import type { SupabaseClient } from '@supabase/supabase-js'

/** Record that intake verified this email's sender. Unverified is the column's default. */
export async function recordSenderVerified(db: SupabaseClient, emailId: string, verified: boolean): Promise<void> {
  if (!verified) return
  const { error } = await (db as any).from('inbound_emails').update({ sender_verified: true }).eq('id', emailId)
  // Before 20261115090000 the column doesn't exist: the email is then simply treated as unverified
  // if it is ever reprocessed.
  if (error) console.warn(`[inbound-email] Could not record the sender check for ${emailId}: ${error.message}`)
}

/** What intake decided. False when it wasn't verified, wasn't recorded, or can't be read. */
export async function storedSenderVerified(db: SupabaseClient, emailId: string): Promise<boolean> {
  const { data, error } = await (db as any).from('inbound_emails').select('sender_verified').eq('id', emailId).maybeSingle()
  if (error) return false
  return (data as { sender_verified?: boolean } | null)?.sender_verified === true
}
