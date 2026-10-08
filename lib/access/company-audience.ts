import type { SupabaseClient } from '@supabase/supabase-js'

// Who can see something — for fan-out (note notifications, digests), where the question is asked
// about many people at once rather than about the caller. The same rule as `access_context` and the
// RLS helpers: an admin, or a member holding "All entities", sees everything; anyone else sees what
// their granted entities reach.

interface Audience {
  members: Array<{ userId: string; unscoped: boolean; granted: Set<string> }>
  /** The entities holding the company asked about (empty when none was asked). */
  holding: Set<string>
}

/**
 * Null when the entity migration has not run (no grants table): every member, as before. 'closed'
 * when something else cannot be read — an empty entity list would make every member look unscoped.
 */
async function loadAudience(admin: SupabaseClient, fundId: string, companyId: string | null): Promise<Audience | null | 'closed'> {
  const [members, grants, links] = await Promise.all([
    (admin as any).from('fund_members').select('user_id, role, all_entities').eq('fund_id', fundId),
    (admin as any).from('fund_member_vehicles').select('user_id, vehicle_id').eq('fund_id', fundId),
    companyId
      ? (admin as any).from('company_vehicles').select('vehicle_id').eq('company_id', companyId)
      : Promise.resolve({ data: [], error: null }),
  ])
  if (grants.error || links.error) return null
  if (members.error) return 'closed'

  const granted = new Map<string, Set<string>>()
  for (const g of (grants.data as any[]) ?? []) {
    if (!granted.has(g.user_id)) granted.set(g.user_id, new Set())
    granted.get(g.user_id)!.add(g.vehicle_id)
  }
  return {
    members: ((members.data as any[]) ?? []).map(m => {
      const mine = granted.get(m.user_id) ?? new Set<string>()
      return { userId: m.user_id as string, unscoped: m.role === 'admin' || m.all_entities === true, granted: mine }
    }),
    holding: new Set(((links.data as any[]) ?? []).map(l => l.vehicle_id as string)),
  }
}

/** The fund members who can see a company. Null = everyone (before the entity migration). */
export async function membersWhoCanSeeCompany(
  admin: SupabaseClient,
  fundId: string,
  companyId: string,
): Promise<Set<string> | null> {
  const a = await loadAudience(admin, fundId, companyId)
  if (a === null) return null
  if (a === 'closed') return new Set()
  return new Set(a.members
    .filter(m => m.unscoped || Array.from(m.granted).some(v => a.holding.has(v)))
    .map(m => m.userId))
}

/**
 * The fund members who can read a note: those who see its entity and, for a note about a company,
 * the company as well. A note with no entity (legacy, unattributed) reaches unscoped members only.
 */
export async function membersWhoCanSeeNote(
  admin: SupabaseClient,
  fundId: string,
  note: { vehicleId: string | null; companyId: string | null },
): Promise<Set<string> | null> {
  const a = await loadAudience(admin, fundId, note.companyId)
  if (a === null) return null
  if (a === 'closed') return new Set()
  return new Set(a.members
    .filter(m => m.unscoped || (
      !!note.vehicleId && m.granted.has(note.vehicleId)
      && (!note.companyId || Array.from(m.granted).some(v => a.holding.has(v)))
    ))
    .map(m => m.userId))
}
