// The investments ceiling on accounting writes that create or delete investment transactions
// (security scan M2). The one-writer design lets an accounting write reach the tracker on purpose:
// posting adopts an entry's investment lines as transactions, and voiding, unposting, editing or
// reversing an owned entry deletes them (adoption.ts, ownership.ts). A fund that limits
// `investments` (say, to admins) must not have that limit walked around through the journal — so
// those writes also need portfolio write on the investments feature.
//
// EXCEPT where the fund has investments switched off or hidden: then nobody has it, admins
// included, and the tracker is not in use. The ledger still wins there (adoption.ts header): the
// rows are written and stay hidden. Refusing would make every entry on an investment account
// unpostable in a fund that keeps its books without the tracker.

import type { SupabaseClient } from '@supabase/supabase-js'
import { hasAccess, loadAccessContext, type AccessContext } from '@/lib/access/effective'
import { DEFAULT_FEATURE_VISIBILITY } from '@/lib/types/features'

export const NEEDS_INVESTMENTS_WRITE =
  'This entry records investment transactions, so changing it changes the holding too. That needs write access to investments.'

export function mayTouchInvestments(access: AccessContext): boolean {
  const level = access.features?.investments ?? DEFAULT_FEATURE_VISIBILITY.investments
  if (level === 'off' || level === 'hidden') return true
  return hasAccess(access, 'portfolio', 'write', 'investments')
}

/** For a route that has only its gate: one access_context read. */
export async function loadMayTouchInvestments(
  admin: SupabaseClient, gate: { fundId: string; role: string }, userId: string,
): Promise<boolean> {
  return mayTouchInvestments(await loadAccessContext(admin, gate.fundId, userId, gate.role))
}
