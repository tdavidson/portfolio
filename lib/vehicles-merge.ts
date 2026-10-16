// Merging one vehicle into another, shared by PATCH /api/vehicles (with mergeIntoId) and the
// `merge_vehicles` agent tool.
//
// Collapse a vehicle into another (e.g. a backfilled "<X> SPV" duplicate of the real "<X> SPV LP").
// Distinct from a rename — the source row is deleted, not renamed, and the target keeps its own
// name while absorbing the source's data + aliases. There is no un-merge: the source's rows are
// re-pointed and its row is gone.

import type { SupabaseClient } from '@supabase/supabase-js'
import type { AccessContext } from '@/lib/access/effective'
import { canSeeVehicle, entityIdentityChangeDenial } from '@/lib/access/scope'
import { dbFail, done, fail, type Outcome } from '@/lib/service-outcome'
import { retagPortfolioGroup } from './vehicles'

/** Tables whose rows name a vehicle by id and move to the merge target. */
export const MERGE_MOVED_TABLES = ['company_notes', 'inbound_deals', 'diligence_deals', 'pending_actions'] as const

export async function mergeVehicles(
  admin: SupabaseClient,
  who: { fundId: string; userId: string; access: Pick<AccessContext, 'vehicles'> },
  fromId: string,
  intoId: string,
): Promise<Outcome<Record<string, unknown>>> {
  const { fundId, access } = who
  // Merging needs both entities to be the caller's, and is an identity change outright.
  if (!canSeeVehicle(access, fromId) || !canSeeVehicle(access, intoId)) return fail(404, 'Vehicle not found')
  const mergeDenied = entityIdentityChangeDenial(access, { mergeIntoId: intoId })
  if (mergeDenied) return fail(403, mergeDenied)
  if (fromId === intoId) return fail(400, 'Cannot merge a vehicle into itself')

  const db = admin as any
  const { data: fromRow } = await db.from('fund_vehicles').select('id, name, aliases').eq('id', fromId).eq('fund_id', fundId).maybeSingle()
  if (!fromRow) return fail(404, 'Vehicle not found')
  const { data: intoRow } = await db.from('fund_vehicles').select('id, name, aliases').eq('id', intoId).eq('fund_id', fundId).maybeSingle()
  if (!intoRow) return fail(404, 'Target vehicle not found')

  // Rows that name the source by ID move to the target first: notes (whose entity reference
  // blocks the delete), deals, diligence and staged actions (which would otherwise fall back to
  // admin-only), and members' grants (who would otherwise lose the merged entity).
  for (const table of MERGE_MOVED_TABLES) {
    const { error: moveErr } = await db.from(table).update({ vehicle_id: intoId }).eq('fund_id', fundId).eq('vehicle_id', fromId)
    // A table this install does not have (or a column not yet migrated) has nothing to move.
    if (moveErr && !/does not exist|schema cache/i.test(moveErr.message ?? '')) return dbFail(moveErr, `vehicles-merge-${table}`)
  }
  const { data: sourceGrants } = await db.from('fund_member_vehicles').select('user_id').eq('fund_id', fundId).eq('vehicle_id', fromId)
  if (((sourceGrants as any[]) ?? []).length > 0) {
    const { error: grantErr } = await db.from('fund_member_vehicles').upsert(
      ((sourceGrants as any[]) ?? []).map(g => ({ fund_id: fundId, user_id: g.user_id, vehicle_id: intoId, granted_by: who.userId })),
      { onConflict: 'fund_id,user_id,vehicle_id', ignoreDuplicates: true })
    if (grantErr) return dbFail(grantErr, 'vehicles-merge-grants')
  }

  // Rewrite every portfolio_group-keyed row from the source's name to the target's name.
  await retagPortfolioGroup(admin, fundId, fromRow.name, intoRow.name)

  // Delete the source BEFORE the target takes its name as an alias: a name denotes one entity
  // (fund_vehicles_names_unique), so while the source exists the alias would clash.
  const { error: deleteErr } = await db.from('fund_vehicles').delete().eq('id', fromId).eq('fund_id', fundId)
  if (deleteErr) return dbFail(deleteErr, 'vehicles')

  // The target absorbs the source's name and aliases as its own aliases, so any legacy string
  // (including the source's old name) still resolves to the target going forward.
  const mergedAliases = Array.from(new Set([
    ...((intoRow.aliases ?? []) as string[]),
    fromRow.name,
    ...((fromRow.aliases ?? []) as string[]),
  ].filter(Boolean)))

  const { data: updatedInto, error: updateErr } = await db
    .from('fund_vehicles')
    .update({ aliases: mergedAliases, updated_at: new Date().toISOString() })
    .eq('id', intoId).eq('fund_id', fundId)
    .select('id, name, kind, aliases, active')
    .single()
  if ((updateErr as any)?.code === '23505') return fail(409, 'Another entity already uses one of those names')
  if (updateErr) return dbFail(updateErr, 'vehicles')

  return done(updatedInto as Record<string, unknown>)
}
