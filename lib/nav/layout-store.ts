import { createAdminClient } from '@/lib/supabase/admin'
import { parseNavLayout, type NavLayout } from './layout'

/**
 * The signed-in member's nav layout. A failed read — including the column not existing yet,
 * before the migration is applied — falls back to the default rather than breaking the shell.
 */
export async function loadNavLayout(userId: string, fundId: string): Promise<NavLayout> {
  const admin = createAdminClient()
  const { data, error } = await admin
    .from('fund_members')
    .select('nav_layout')
    .eq('user_id', userId)
    .eq('fund_id', fundId)
    .maybeSingle()
  if (error) return parseNavLayout(null)
  return parseNavLayout(data?.nav_layout)
}

/** Saves the member's own choice. Returns false when nothing was written. */
export async function saveNavLayout(userId: string, layout: NavLayout): Promise<boolean> {
  const admin = createAdminClient()
  const { data, error } = await admin
    .from('fund_members')
    .update({ nav_layout: layout })
    .eq('user_id', userId)
    .select('user_id')
  return !error && (data?.length ?? 0) > 0
}
