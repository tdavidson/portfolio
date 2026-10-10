import { loadOwnership } from './load'
import { loadPositions, type LpPosition } from './lp-positions'
// Allocation configuration: what the close splits P&L on, how each partner's
// commitment has changed over time, and which partners bear which categories.
//
// The pure functions here are the ones worth testing; the loaders are thin.

import type { SupabaseClient } from '@supabase/supabase-js'
import { vehicleIdByName, type VehicleIdMap } from './vehicle-id'
import { roundCents } from './ledger'

export type AllocationBasis = 'commitment' | 'capital_balance'

/**
 * How this vehicle's books were started.
 *   full_history — rebuilt from inception; opening balances are DERIVED from the
 *                  reconstructed history, so entering them would double-count capital.
 *   cutover      — books begin at a date with an explicit opening-balance entry.
 */

export type AllocationCategory =
  | 'management_fee'
  | 'partnership_expense'
  | 'organizational_expense'
  | 'realized_gain'
  | 'valuation'
  /** Currency translation. Its own line on the roll-forward; allocated on the valuation terms. */
  | 'fx_revaluation'
  | 'income'
  | 'carried_interest'

export interface PartnerTerms {
  lpEntityId: string
  category: AllocationCategory
  participates: boolean
  weightOverride: number | null
  rateOverride: number | null
}

export interface CommitmentEvent {
  lpEntityId: string
  effectiveDate: string
  amount: number
  kind: string
}

// ---------------------------------------------------------------------------
// Pure logic
// ---------------------------------------------------------------------------

/**
 * Each partner's commitment as of a date — the sum of their signed deltas up to it.
 * A commitment TRANSFER is two events (−X, +X) so the fund's total is unchanged;
 * this falls out of the model rather than needing a special case.
 */
export function commitmentsAsOf(events: CommitmentEvent[], asOf?: string | null): Map<string, number> {
  const out = new Map<string, number>()
  for (const e of events) {
    if (asOf && e.effectiveDate > asOf) continue
    out.set(e.lpEntityId, roundCents((out.get(e.lpEntityId) ?? 0) + e.amount))
  }
  return out
}

/**
 * The standard commitment fallback ladder for a LEDGER-side read: effective-dated
 * commitment_events as of the report date, or — when a vehicle has no event history yet — the
 * legacy per-partner `lp_investments` commitment scalar (`owners`). The events-or-scalar core of
 * `resolveCommitmentMap` — call THAT from readers so the positions case is handled uniformly too.
 */
export function commitmentsFrom(
  events: CommitmentEvent[],
  owners: { lpEntityId: string; commitment: number }[],
  asOf?: string | null,
): Map<string, number> {
  const fromEvents = commitmentsAsOf(events, asOf)
  const withHistory = new Set(events.map(e => e.lpEntityId))
  const resolved = new Map(owners.filter(o => !withHistory.has(o.lpEntityId)).map(o => [o.lpEntityId, o.commitment]))
  for (const [id, amount] of fromEvents) resolved.set(id, amount)
  return resolved
}

/**
 * The ONE canonical commitment resolution, used by EVERY reader (allocation, capital accounts,
 * capital calls, the LP-statement memo, the close) so they can't drift. Priority:
 *   1. positions — a tracking (non-ledger) vehicle's dated positions win, so a pasted position
 *      update takes effect (this is the only reason capital-calls was ever "source-aware");
 *   2. commitment_events — the effective-dated log (what allocation and the close use);
 *   3. lp_investments.commitment — the legacy scalar, when there are no events.
 *
 * The old split (capital-accounts/calls read the scalar, allocation read the events) meant a
 * partner with a $X event but a $0 scalar showed $X on one page and $0 on the other. This ends it.
 */
export function resolveCommitmentMap(input: {
  /** The vehicle's capital source ('ledger' | 'events'); positions only win when NOT 'ledger'. */
  source?: string | null
  owners: { lpEntityId: string; commitment: number }[]
  events?: CommitmentEvent[]
  positions?: Map<string, number> | null
  asOf?: string | null
}): Map<string, number> {
  const base = commitmentsFrom(input.events ?? [], input.owners, input.asOf)
  if (input.positions && input.positions.size > 0) {
    const merged = new Map(base)
    for (const [id, c] of Array.from(input.positions.entries())) merged.set(id, c)
    return merged
  }
  return base
}

/** A reported commitment is an anchor; later commitment events are signed changes. */
export function resolveDatedCommitments(events: CommitmentEvent[], owners: { lpEntityId: string; commitment: number }[], positions: LpPosition[], asOf?: string | null): Map<string, number> {
  const result = commitmentsFrom(events, owners, asOf)
  const latest = new Map<string, LpPosition>()
  for (const p of positions) {
    if (p.commitment == null || (asOf && p.asOfDate > asOf)) continue
    const previous = latest.get(p.lpEntityId)
    if (!previous || p.asOfDate > previous.asOfDate) latest.set(p.lpEntityId, p)
  }
  for (const [id, p] of latest) {
    const changes = events.filter(e => e.lpEntityId === id && e.effectiveDate > p.asOfDate && (!asOf || e.effectiveDate <= asOf))
    result.set(id, roundCents(p.commitment! + changes.reduce((sum, e) => sum + e.amount, 0)))
  }
  return result
}

export async function loadResolvedCommitments(admin: SupabaseClient, fundId: string, group: string, asOf?: string | null) {
  const [events, owners, positions] = await Promise.all([
    loadCommitmentEvents(admin, fundId, group), loadOwnership(admin, fundId, group), loadPositions(admin, fundId, group, asOf ?? undefined),
  ])
  return resolveDatedCommitments(events, owners, positions, asOf)
}

export interface WeightInput {
  lpEntityId: string
  /** Committed capital, or capital-account balance — whichever the basis says. */
  basisAmount: number
}

/**
 * The weights the close uses to split ONE category across partners.
 *
 * A partner who doesn't participate gets no weight at all, so their share
 * redistributes across everyone else — a GP entity excluded from the management fee
 * doesn't shrink the fee, it shifts it onto the LPs, which is the point.
 *
 * A `weightOverride` replaces the basis amount for that partner only (a negotiated
 * share), leaving everyone else on the basis.
 */
export function allocationWeights(
  partners: WeightInput[],
  terms: PartnerTerms[],
  category: AllocationCategory
): { lpEntityId: string; commitment: number }[] {
  // Currency translation is a change in the value of the same holdings, so a partner's terms for
  // unrealized gains govern it; there are no separate FX terms to set.
  const termCategory: AllocationCategory = category === 'fx_revaluation' ? 'valuation' : category
  const byPartner = new Map<string, PartnerTerms>()
  for (const t of terms) {
    if (t.category === termCategory) byPartner.set(t.lpEntityId, t)
  }

  // A CARRY PARTICIPANT NEED NOT BE AN INVESTOR.
  //
  // Carry points and committed capital are different things: a partner can hold 15% of the
  // carry while committing nothing at all (a founding partner, an advisor with points). This
  // used to map only over `partners` — which is built from commitments — so anyone with a
  // weight override and no commitment simply never entered the list, and their points silently
  // redistributed to everyone else.
  //
  // An explicit `weightOverride` IS the partner's participation. Include them.
  const all: WeightInput[] = [...partners]
  const known = new Set(partners.map(p => p.lpEntityId))
  for (const t of Array.from(byPartner.values())) {
    if (!known.has(t.lpEntityId) && t.participates && t.weightOverride != null && t.weightOverride > 0) {
      all.push({ lpEntityId: t.lpEntityId, basisAmount: 0 })
    }
  }

  return all
    .map(p => {
      const t = byPartner.get(p.lpEntityId)
      if (t && !t.participates) return { lpEntityId: p.lpEntityId, commitment: 0 }
      const weight = t?.weightOverride ?? p.basisAmount
      return { lpEntityId: p.lpEntityId, commitment: Math.max(0, weight) }
    })
    .filter(w => w.commitment > 0)
}

// ---------------------------------------------------------------------------
// Loaders
// ---------------------------------------------------------------------------

/** The vehicle's allocation basis. Defaults to commitment when unset. */
export async function loadAllocationBasis(
  admin: SupabaseClient,
  fundId: string,
  group: string
): Promise<AllocationBasis> {
  const vehicleId = await vehicleIdByName(admin, fundId, group)
  const { data } = await admin
    .from('vehicle_accounting_settings' as any)
    .select('allocation_basis')
    .eq('fund_id', fundId)
    .eq('vehicle_id', vehicleId)
    .maybeSingle()
  const basis = (data as any)?.allocation_basis
  return basis === 'capital_balance' ? 'capital_balance' : 'commitment'
}

export async function saveAllocationBasis(
  admin: SupabaseClient,
  fundId: string,
  group: string,
  basis: AllocationBasis
): Promise<{ ok: true } | { error: string }> {
  const vehicleId = await vehicleIdByName(admin, fundId, group)
  const { error } = await admin
    .from('vehicle_accounting_settings' as any)
    .upsert(
      { fund_id: fundId, vehicle_id: vehicleId, allocation_basis: basis, updated_at: new Date().toISOString() },
      { onConflict: 'fund_id,vehicle_id' }
    )
  if (error) return { error: error.message }
  return { ok: true }
}

export async function loadPartnerTerms(
  admin: SupabaseClient,
  fundId: string,
  group: string,
  idMap?: VehicleIdMap
): Promise<PartnerTerms[]> {
  const vehicleId = await vehicleIdByName(admin, fundId, group, idMap)
  const { data } = await admin
    .from('partner_allocation_terms' as any)
    .select('lp_entity_id, category, participates, weight_override, rate_override')
    .eq('fund_id', fundId)
    .eq('vehicle_id', vehicleId)
  return ((data as any[]) ?? []).map(t => ({
    lpEntityId: t.lp_entity_id,
    category: t.category,
    participates: t.participates !== false,
    weightOverride: t.weight_override == null ? null : Number(t.weight_override),
    rateOverride: t.rate_override == null ? null : Number(t.rate_override),
  }))
}

export async function savePartnerTerm(
  admin: SupabaseClient,
  fundId: string,
  group: string,
  term: { lpEntityId: string; category: AllocationCategory; participates: boolean; weightOverride?: number | null; rateOverride?: number | null; memo?: string | null }
): Promise<{ ok: true } | { error: string }> {
  const vehicleId = await vehicleIdByName(admin, fundId, group)
  const { error } = await admin
    .from('partner_allocation_terms' as any)
    .upsert(
      {
        fund_id: fundId,
        vehicle_id: vehicleId,
        lp_entity_id: term.lpEntityId,
        category: term.category,
        participates: term.participates,
        weight_override: term.weightOverride ?? null,
        rate_override: term.rateOverride ?? null,
        memo: term.memo ?? null,
        updated_at: new Date().toISOString(),
      },
      { onConflict: 'fund_id,vehicle_id,lp_entity_id,category' }
    )
  if (error) return { error: error.message }
  return { ok: true }
}

function toCommitmentEvent(e: any): CommitmentEvent {
  return { lpEntityId: e.lp_entity_id, effectiveDate: e.effective_date, amount: Number(e.amount), kind: e.kind }
}

/** Every commitment event for the vehicle, oldest first. Pass `events` (a preloaded slice) to
 *  skip the query. */
export async function loadCommitmentEvents(
  admin: SupabaseClient,
  fundId: string,
  group: string,
  idMap?: VehicleIdMap,
  events?: CommitmentEvent[]
): Promise<CommitmentEvent[]> {
  if (events) return events
  const vehicleId = await vehicleIdByName(admin, fundId, group, idMap)
  const { data } = await admin
    .from('commitment_events' as any)
    .select('lp_entity_id, effective_date, amount, kind')
    .eq('fund_id', fundId)
    .eq('vehicle_id', vehicleId)
    .order('effective_date', { ascending: true })
  return ((data as any[]) ?? []).map(toCommitmentEvent)
}

/**
 * Batch-load commitment events for MANY vehicles: one `vehicle_id IN (...)` query, grouped by
 * vehicle_id, each group oldest-first (the global order-by preserves per-vehicle order on push).
 */
export async function loadCommitmentEventsBatch(
  admin: SupabaseClient,
  fundId: string,
  vehicleIds: string[]
): Promise<Map<string, CommitmentEvent[]>> {
  const out = new Map<string, CommitmentEvent[]>()
  if (vehicleIds.length === 0) return out
  for (const id of vehicleIds) out.set(id, [])
  const { data } = await admin
    .from('commitment_events' as any)
    .select('lp_entity_id, effective_date, amount, kind, vehicle_id')
    .eq('fund_id', fundId)
    .in('vehicle_id', vehicleIds)
    .order('effective_date', { ascending: true })
  for (const e of ((data as any[]) ?? [])) out.get(e.vehicle_id)?.push(toCommitmentEvent(e))
  return out
}

/**
 * Record a commitment change. A transfer writes BOTH legs in one call, sharing a
 * transfer_id, so the fund's total commitment can't drift.
 */
export async function recordCommitmentChange(
  admin: SupabaseClient,
  fundId: string,
  group: string,
  userId: string | null,
  input: {
    lpEntityId: string
    effectiveDate: string
    amount: number
    /** Present = a transfer of commitment TO this partner FROM the counterparty. */
    counterpartyEntityId?: string | null
    memo?: string | null
  }
): Promise<{ ok: true } | { error: string }> {
  const { lpEntityId, effectiveDate, amount, counterpartyEntityId, memo } = input
  if (!lpEntityId || !effectiveDate) return { error: 'Partner and effective date are required' }
  if (!Number.isFinite(amount) || amount === 0) return { error: 'Amount must be a non-zero number' }

  const vehicleId = await vehicleIdByName(admin, fundId, group)
  const base = { fund_id: fundId, vehicle_id: vehicleId, effective_date: effectiveDate, memo: memo ?? null, created_by: userId }

  if (counterpartyEntityId) {
    if (counterpartyEntityId === lpEntityId) return { error: 'Cannot transfer commitment to the same partner' }
    if (amount <= 0) return { error: 'A transfer amount must be positive' }
    const transferId = crypto.randomUUID()
    const { error } = await admin.from('commitment_events' as any).insert([
      { ...base, lp_entity_id: counterpartyEntityId, amount: -amount, kind: 'transfer_out', counterparty_entity_id: lpEntityId, transfer_id: transferId },
      { ...base, lp_entity_id: lpEntityId, amount, kind: 'transfer_in', counterparty_entity_id: counterpartyEntityId, transfer_id: transferId },
    ])
    if (error) return { error: error.message }
    return { ok: true }
  }

  const { error } = await admin.from('commitment_events' as any).insert({
    ...base,
    lp_entity_id: lpEntityId,
    amount,
    kind: amount > 0 ? 'increase' : 'decrease',
  })
  if (error) return { error: error.message }
  return { ok: true }
}
