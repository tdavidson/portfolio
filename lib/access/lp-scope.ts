// Entity access for LPs, in application code — the mirror of lp_entity_ids_readable() /
// lp_investor_ids_readable() (20261007100300_entity_rls_lp.sql). Most LP routes read with the
// service role, so RLS does not reach them; they filter with these.
//
// An LP entity is visible when it has a position in one of the caller's entities: a commitment, a
// position, capital events, call or distribution lines (keyed by vehicle_id), or a legacy
// lp_investments row tagged with one of their entities' names. An investor is visible when one of
// its LP entities is. Null = no filter (the caller sees every entity).

import type { SupabaseClient } from '@supabase/supabase-js'
import type { EntityScope } from './entity-scope'
import { visibleVehicleIds } from './scope'

const POSITION_TABLES = ['commitment_events', 'lp_positions', 'lp_capital_events', 'capital_call_lines', 'distribution_lines']

export async function visibleLpEntityIds(admin: SupabaseClient, scope: Pick<EntityScope, 'access' | 'vehicleNames'>): Promise<string[] | null> {
  const ids = visibleVehicleIds(scope.access)
  if (ids === null) return null
  if (ids.length === 0) return []
  const fundId = scope.access.fundId
  const reads = POSITION_TABLES.map(t =>
    (admin as any).from(t).select('lp_entity_id').eq('fund_id', fundId).in('vehicle_id', ids))
  if (scope.vehicleNames && scope.vehicleNames.length > 0) {
    reads.push((admin as any).from('lp_investments').select('entity_id').eq('fund_id', fundId).in('portfolio_group', scope.vehicleNames))
  }
  const results = await Promise.all(reads)
  const out = new Set<string>()
  for (const { data } of results) {
    for (const r of (data as any[]) ?? []) {
      const id = r.lp_entity_id ?? r.entity_id
      if (id) out.add(id)
    }
  }
  return Array.from(out)
}

export async function visibleLpInvestorIds(admin: SupabaseClient, scope: Pick<EntityScope, 'access' | 'vehicleNames'>): Promise<string[] | null> {
  const entities = await visibleLpEntityIds(admin, scope)
  if (entities === null) return null
  if (entities.length === 0) return []
  const { data } = await (admin as any).from('lp_entities').select('id, investor_id').eq('fund_id', scope.access.fundId).in('id', entities)
  return Array.from(new Set(((data as any[]) ?? []).map(e => e.investor_id).filter(Boolean)))
}

/**
 * Everything an LP route needs to scope itself, resolved once per request: the caller's entities,
 * their names (and aliases), and the LP entities and investors visible through them. Every list is
 * null when the caller sees every entity.
 */
export interface LpScope {
  scope: EntityScope
  entityIds: string[] | null
  investorIds: string[] | null
}

export async function loadLpScope(
  admin: SupabaseClient,
  who: { fundId: string; userId: string; role: string },
): Promise<LpScope> {
  const { loadEntityScope } = await import('./entity-scope')
  const scope = await loadEntityScope(admin, who)
  if (visibleVehicleIds(scope.access) === null) return { scope, entityIds: null, investorIds: null }
  const entityIds = await visibleLpEntityIds(admin, scope)
  const investorIds = entityIds && entityIds.length > 0
    ? Array.from(new Set((((await (admin as any).from('lp_entities').select('investor_id')
        .eq('fund_id', who.fundId).in('id', entityIds)).data as any[]) ?? []).map(e => e.investor_id).filter(Boolean)))
    : []
  return { scope, entityIds, investorIds }
}

/** Keep `id` when `visible` is null (no filter) or lists it. */
export const lpVisible = (visible: string[] | null, id: string | null | undefined) =>
  visible === null || (!!id && visible.includes(id))

/**
 * The live LP report (generateLiveReport, built fund-wide) cut to the caller's entities: their
 * rows, their vehicles' provenance, and names only for LPs that still appear. `visibleNames` null =
 * every entity.
 */
export function scopeLiveReport<R extends { rows: { entity_id: string; portfolio_group: string }[]; vehicles: { group: string }[]; entityNames: Map<string, string> }>(
  live: R, visibleNames: string[] | null,
): R {
  if (visibleNames === null) return live
  const rows = live.rows.filter(r => visibleNames.includes(r.portfolio_group))
  const kept = new Set(rows.map(r => r.entity_id))
  return {
    ...live,
    rows,
    vehicles: live.vehicles.filter(v => visibleNames.includes(v.group)),
    entityNames: new Map(Array.from(live.entityNames).filter(([id]) => kept.has(id))),
  }
}

/**
 * May the caller see this LP document? The lp_documents RLS rule, in code: a fund-wide document
 * goes to every LP so every member may see it; an investor document only when it is shared with an
 * investor the caller can see.
 */
export async function lpDocumentVisible(admin: SupabaseClient, fundId: string, documentId: string, lp: LpScope): Promise<boolean> {
  if (lp.investorIds === null) return true
  const { data: doc } = await (admin as any).from('lp_documents').select('id, scope').eq('id', documentId).eq('fund_id', fundId).maybeSingle()
  if (!doc) return false
  if ((doc as any).scope === 'fund') return true
  const { data: shares } = await (admin as any).from('lp_document_shares').select('lp_investor_id').eq('document_id', documentId)
  return ((shares as any[]) ?? []).some(s => lp.investorIds!.includes(s.lp_investor_id))
}
