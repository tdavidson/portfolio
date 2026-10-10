// A report shared with investors is locked: its figures and date cannot change and it cannot be
// deleted (supabase/migrations/20261010200002_lock_shared_lp_reports.sql enforces it). This is
// the routes' friendly half — a refusal that says why, before the database's.

import type { SupabaseClient } from '@supabase/supabase-js'

/** How many investors a report is shared with; 0 for none (or no report). */
export async function reportShareCount(admin: SupabaseClient, fundId: string, snapshotId: string | null | undefined): Promise<number> {
  if (!snapshotId) return 0
  const { count } = await (admin as any).from('lp_snapshot_shares').select('id', { count: 'exact', head: true })
    .eq('fund_id', fundId).eq('snapshot_id', snapshotId)
  return count ?? 0
}

export function lockedMessage(shares: number, what: string): string {
  return `This report is shared with ${shares} investor${shares === 1 ? '' : 's'}, so ${what} is locked. ` +
    'Unshare it first (the change is recorded), or publish a corrected report.'
}
