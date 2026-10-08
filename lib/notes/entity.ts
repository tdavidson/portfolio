import type { SupabaseClient } from '@supabase/supabase-js'
import type { EntityScope } from '@/lib/access/entity-scope'
import { canSeeVehicle, filterByCompany, visibleVehicleIds } from '@/lib/access/scope'

// Every note belongs to an entity (company_notes.vehicle_id). There are no fund-wide notes: a note
// is written FOR one of the fund's entities, and only people who can see that entity read it — on a
// company two entities share, Fund I's notes are Fund I's. A note with no entity (written before
// entities existed, and not attributable by the backfill) is for unscoped callers until assigned.
// The same rule is in RLS (20261007100600_notes_entity.sql).

type NoteScope = Pick<EntityScope, 'access' | 'companyIds'>

/** May this caller read this note? */
export function noteVisible(note: { vehicle_id?: string | null; company_id: string | null }, scope: NoteScope): boolean {
  if (scope.access.vehicles.all) return true
  if (!note.vehicle_id || !canSeeVehicle(scope.access, note.vehicle_id)) return false
  return !note.company_id || scope.companyIds === null || scope.companyIds.includes(note.company_id)
}

/**
 * The same rule on a PostgREST query over company_notes. Applied only for a scoped caller —
 * vehicle_id exists once the notes migration has run, and before it every caller is unscoped.
 */
export function scopeNotesQuery<Q extends { in: Function; is: Function; or: Function }>(query: Q, scope: NoteScope): Q {
  const ids = visibleVehicleIds(scope.access)
  if (ids === null) return query
  return filterByCompany(query.in('vehicle_id', ids) as Q, scope.companyIds, { keepUnlinked: true })
}

export interface NoteEntity { id: string; name: string }

/**
 * The entities a new note may be for: the writer's active entities (never the management company,
 * which holds no portfolio); for a note about a company, those of theirs that hold it — or, for a
 * company no entity holds yet, any of theirs (only an unscoped writer can see such a company).
 */
export async function noteEntityCandidates(
  admin: SupabaseClient,
  scope: NoteScope,
  companyId: string | null,
): Promise<NoteEntity[]> {
  const [{ data: vehicles }, links] = await Promise.all([
    (admin as any).from('fund_vehicles').select('id, name, kind, active').eq('fund_id', scope.access.fundId).order('name'),
    companyId
      ? (admin as any).from('company_vehicles').select('vehicle_id').eq('fund_id', scope.access.fundId).eq('company_id', companyId)
      : Promise.resolve({ data: null }),
  ])
  const mine = ((vehicles as any[]) ?? []).filter(v => v.kind !== 'manco' && canSeeVehicle(scope.access, v.id))
  const holding = links.data ? new Set(((links.data as any[]) ?? []).map(l => l.vehicle_id as string)) : null
  // About a company: the writer's entities that hold it — inactive ones included, since a company
  // held only by a wound-down entity still has notes written about it.
  const holders = holding ? mine.filter(v => holding.has(v.id)) : []
  // About no company, or a company no entity holds yet: the writer's active entities — offered for
  // an unassigned company only to an unscoped writer (only they can see it at all).
  const pick = holding && (holders.length > 0 || !scope.access.vehicles.all)
    ? holders
    : mine.filter(v => v.active)
  return pick.map(v => ({ id: v.id as string, name: v.name as string }))
}

/**
 * The entity a new note is written for: the one named, which must be a candidate; else the only
 * candidate; else the writer is asked to choose.
 */
export async function resolveNoteEntity(
  admin: SupabaseClient,
  scope: NoteScope,
  companyId: string | null,
  requested: string | null | undefined,
): Promise<{ vehicleId: string } | { error: string; status: number }> {
  const candidates = await noteEntityCandidates(admin, scope, companyId)
  if (requested) {
    return candidates.some(c => c.id === requested)
      ? { vehicleId: requested }
      : { error: "You can't write a note for that entity here.", status: 400 }
  }
  if (candidates.length === 1) return { vehicleId: candidates[0].id }
  if (candidates.length === 0) {
    return { error: companyId ? 'None of your entities holds this company.' : "You don't have access to any entity yet.", status: 400 }
  }
  return { error: 'Choose which entity this note is for.', status: 400 }
}
