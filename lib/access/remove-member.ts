// Removing a team member, shared by DELETE /api/settings/members/[id] and the `remove_member` agent
// tool. The caller has established that the person acting is an admin of the fund (the route's own
// check; the tool is admin-only, lib/access/admin-only.ts). What is checked here is the member:
// in this fund, not the person acting, and not an admin.
//
// Not undoable as such: re-adding them is a new invitation, and they start with no entity grants.

import type { SupabaseClient } from '@supabase/supabase-js'
import { expireTag } from '@/lib/cache/tags'
import { dbFail, done, fail, type Outcome } from '@/lib/service-outcome'

export async function removeMember(
  admin: SupabaseClient, who: { fundId: string; userId: string }, memberId: string,
): Promise<Outcome<{ ok: true; userId: string }>> {
  // Get the member to remove — must be in the same fund
  const { data: target } = await (admin as any)
    .from('fund_members')
    .select('id, user_id, role')
    .eq('id', memberId)
    .eq('fund_id', who.fundId)
    .single()

  if (!target) return fail(404, 'Member not found')
  // Prevent removing yourself
  if (target.user_id === who.userId) return fail(400, 'You cannot remove yourself')
  // Prevent removing other admins
  if (target.role === 'admin') return fail(400, 'Cannot remove an admin')

  const { error } = await (admin as any).from('fund_members').delete().eq('id', memberId)
  if (error) return dbFail(error, 'settings-members')

  // Their entity grants go with the membership: someone re-added later starts with none, rather
  // than quietly regaining entities an admin granted them before.
  await (admin as any).from('fund_member_vehicles').delete()
    .eq('fund_id', who.fundId).eq('user_id', target.user_id)

  expireTag('membership')
  return done({ ok: true, userId: target.user_id as string })
}
