import type { SupabaseClient } from '@supabase/supabase-js'

/**
 * The fund members who can see a company — for fan-out (note notifications, digests), where the
 * question is asked about many people at once rather than about the caller. The same rule as
 * `access_context` and `company_ids_readable`: an admin, or a member granted every entity, sees
 * everything; anyone else sees a company linked to one of their granted entities.
 *
 * Null when the entity migration has not run (no grants table): every member, the behaviour
 * before entity access existed.
 */
export async function membersWhoCanSeeCompany(
  admin: SupabaseClient,
  fundId: string,
  companyId: string,
): Promise<Set<string> | null> {
  const [members, vehicles, grants, links] = await Promise.all([
    (admin as any).from('fund_members').select('user_id, role').eq('fund_id', fundId),
    (admin as any).from('fund_vehicles').select('id').eq('fund_id', fundId),
    (admin as any).from('fund_member_vehicles').select('user_id, vehicle_id').eq('fund_id', fundId),
    (admin as any).from('company_vehicles').select('vehicle_id').eq('company_id', companyId),
  ])
  // No grants table yet: the migration has not run, so everyone, as before.
  if (grants.error || links.error) return null
  // Anything else unreadable fails CLOSED: an empty entity list would make every member look
  // unscoped and send the note to all of them.
  if (members.error || vehicles.error) return new Set()

  const allVehicles = new Set<string>(((vehicles.data as any[]) ?? []).map(v => v.id))
  const holding = new Set<string>(((links.data as any[]) ?? []).map(l => l.vehicle_id))
  const granted = new Map<string, Set<string>>()
  for (const g of (grants.data as any[]) ?? []) {
    if (!granted.has(g.user_id)) granted.set(g.user_id, new Set())
    granted.get(g.user_id)!.add(g.vehicle_id)
  }

  const out = new Set<string>()
  for (const m of (members.data as any[]) ?? []) {
    const mine = granted.get(m.user_id) ?? new Set<string>()
    const unscoped = m.role === 'admin' || Array.from(allVehicles).every(v => mine.has(v))
    if (unscoped || Array.from(mine).some(v => holding.has(v))) out.add(m.user_id)
  }
  return out
}
