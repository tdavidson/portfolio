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

/** Distinct LP entity ids with a position in these entities (or tagged with these names). An error
 *  yields none — fail closed. */
async function lpEntityIdsFor(admin: SupabaseClient, vehicleIds: string[], names: string[]): Promise<string[]> {
  const { data, error } = await (admin as any).rpc('lp_entity_ids_for', { p_vehicle_ids: vehicleIds, p_names: names })
  return error ? [] : ((data as string[] | null) ?? [])
}

async function lpInvestorIdsFor(admin: SupabaseClient, entityIds: string[]): Promise<string[]> {
  if (entityIds.length === 0) return []
  const { data, error } = await (admin as any).rpc('lp_investor_ids_for', { p_entity_ids: entityIds })
  return error ? [] : ((data as string[] | null) ?? [])
}

export async function visibleLpEntityIds(admin: SupabaseClient, scope: Pick<EntityScope, 'access' | 'vehicleNames'>): Promise<string[] | null> {
  const ids = visibleVehicleIds(scope.access)
  if (ids === null) return null
  if (ids.length === 0) return []
  return lpEntityIdsFor(admin, ids, scope.vehicleNames === null ? [] : scope.vehicleNames)
}

export async function visibleLpInvestorIds(admin: SupabaseClient, scope: Pick<EntityScope, 'access' | 'vehicleNames'>): Promise<string[] | null> {
  const entities = await visibleLpEntityIds(admin, scope)
  if (entities === null) return null
  return lpInvestorIdsFor(admin, entities)
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
  const entityIds = (await visibleLpEntityIds(admin, scope)) ?? []
  return { scope, entityIds, investorIds: await lpInvestorIdsFor(admin, entityIds) }
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
 * REPORT CARDS ARE WHOLE. A card is one LP's document across every entity it holds, so it must
 * carry ALL of that LP's positions whoever produces it — a card cut to the producer's entities
 * would state the LP's commitment, NAV and multiples wrong, with nothing on it saying so. What the
 * entity grant decides is WHICH LPs: those with a position in an entity the caller can see.
 */
export function scopeReportCardRows<Row extends { entity_id: string; portfolio_group: string }>(
  rows: Row[], visibleNames: string[] | null, investorOf: (entityId: string) => string,
): Row[] {
  if (visibleNames === null) return rows
  const investors = new Set(rows.filter(r => visibleNames.includes(r.portfolio_group)).map(r => investorOf(r.entity_id)))
  return rows.filter(r => investors.has(investorOf(r.entity_id)))
}

/**
 * May the caller see this LP document? The lp_documents RLS rule, in code: a fund-wide document
 * goes to every LP so every member may see it; an investor document only when it is shared with an
 * investor the caller can see.
 */
export async function lpDocumentVisible(admin: SupabaseClient, fundId: string, documentId: string, lp: LpScope): Promise<boolean> {
  if (lp.investorIds === null) return true
  const { data: doc } = await (admin as any).from('lp_documents').select('id, scope, vehicle').eq('id', documentId).eq('fund_id', fundId).maybeSingle()
  if (!doc) return false
  if ((doc as any).scope === 'fund') return true
  // Tagged to an entity: that entity's, whoever it is shared with.
  const vehicle = (doc as any).vehicle as string | null
  const names = lp.scope ? lp.scope.vehicleNames : []
  if (vehicle && names !== null && !names.includes(vehicle)) return false
  const { data: shares } = await (admin as any).from('lp_document_shares').select('lp_investor_id').eq('document_id', documentId)
  return ((shares as any[]) ?? []).some(s => lp.investorIds!.includes(s.lp_investor_id))
}

/**
 * Which of these LP documents and letters the caller may see — the batch form of the document rule
 * above, plus letters (their entity's only). For rows ABOUT an item — a delivery of it, an LP's
 * visit to it — which belong to the item's entity, not just to the LP. Null = everything (unscoped).
 */
export async function visibleLpItems(
  admin: SupabaseClient,
  fundId: string,
  lp: LpScope,
  ids: { documents: string[]; letters: string[] },
): Promise<{ documents: Set<string>; letters: Set<string> } | null> {
  if (lp.investorIds === null) return null
  const names = lp.scope ? lp.scope.vehicleNames : []
  const [{ data: docs }, { data: shares }, { data: letters }] = await Promise.all([
    ids.documents.length
      ? (admin as any).from('lp_documents').select('id, scope, vehicle').eq('fund_id', fundId).in('id', ids.documents)
      : { data: [] },
    ids.documents.length
      ? (admin as any).from('lp_document_shares').select('document_id, lp_investor_id').in('document_id', ids.documents)
      : { data: [] },
    ids.letters.length
      ? (admin as any).from('lp_letters').select('id, portfolio_group').eq('fund_id', fundId).in('id', ids.letters)
      : { data: [] },
  ])
  const sharedWithMine = new Set(((shares as any[]) ?? [])
    .filter(s => lp.investorIds!.includes(s.lp_investor_id)).map(s => s.document_id as string))
  const documents = new Set(((docs as any[]) ?? []).filter(d =>
    d.scope === 'fund'
    || ((!d.vehicle || names === null || names.includes(d.vehicle)) && sharedWithMine.has(d.id)),
  ).map(d => d.id as string))
  const letterSet = new Set(((letters as any[]) ?? [])
    .filter(l => names === null || names.includes(l.portfolio_group)).map(l => l.id as string))
  return { documents, letters: letterSet }
}

/** The same, from just a user id — for routes that look up `fund_members` themselves. */
export async function loadLpScopeForUser(admin: SupabaseClient, userId: string): Promise<LpScope | null> {
  const { data: m } = await (admin as any).from('fund_members').select('fund_id, role').eq('user_id', userId).maybeSingle()
  if (!m) return null
  return loadLpScope(admin, { fundId: m.fund_id, userId, role: m.role })
}
