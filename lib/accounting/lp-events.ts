// CRUD for `lp_capital_events` — the LP capital movements of a vehicle that has no books.
//
// SIGN CONVENTION, contained here on purpose.
// The table stores `amount` DEBIT-POSITIVE, identical to `journal_postings`, because that is
// what makes the row a drop-in `CapitalPosting` (see capital-source.ts). But debit-positive
// is a double-entry idea, and a user entering "Acme contributed $100k" should never have to
// know that it is stored as -100000.
//
// So the boundary flips it exactly once, in each direction:
//   capitalDelta  — what a human means. +100k contribution, -50k distribution.
//   amount        — what the ledger means. amount = -capitalDelta.
// Everything above this file speaks capitalDelta; everything below speaks amount. Nothing
// in the UI or the API should ever see a debit-positive number.

import type { SupabaseClient } from '@supabase/supabase-js'
import { vehicleIdByName } from './vehicle-id'
import { roundCents } from './ledger'

export interface LpCapitalEvent {
  id: string
  lpEntityId: string
  lpName: string
  eventDate: string
  sourceType: string
  /** Natural sign, from the LP's perspective: positive increases their capital. */
  capitalDelta: number
  memo: string | null
  createdAt: string
}

export interface LpCapitalEventInput {
  lpEntityId: string
  eventDate: string
  sourceType: string
  capitalDelta: number
  memo?: string | null
}

/** The source types an LP capital event may carry, and what each does to capital.
 *  Mirrors `bucketForSourceType` — anything not listed here would land in `unclassified`. */
export const LP_EVENT_TYPES = [
  { value: 'opening_balance', label: 'Opening balance', hint: 'Starting capital at cutover' },
  { value: 'capital_call', label: 'Capital call / contribution', hint: 'LP puts money in' },
  { value: 'distribution', label: 'Distribution', hint: 'LP takes money out' },
  { value: 'management_fee', label: 'Management fee', hint: 'Reduces capital' },
  { value: 'partnership_expense', label: 'Partnership expense', hint: 'Reduces capital' },
  { value: 'organizational_expense', label: 'Organizational expense', hint: 'Reduces capital' },
  { value: 'income', label: 'Operating income', hint: 'Interest, dividends' },
  { value: 'realized_gain', label: 'Realized gain / loss', hint: 'From an exit' },
  { value: 'valuation', label: 'Unrealized gain / loss', hint: 'A mark, not cash' },
  { value: 'fx_revaluation', label: 'FX translation', hint: 'Currency move, not performance' },
  { value: 'carried_interest', label: 'Carried interest', hint: 'Accrued to the GP' },
  { value: 'transfer', label: 'Transfer (assignment)', hint: 'LP-to-LP, not a sale: the new holder takes over the history' },
  { value: 'secondary_transfer', label: 'Transfer (secondary sale)', hint: 'LP-to-LP sale: an exit and a purchase at the value moved' },
  { value: 'manual', label: 'Other', hint: 'Shows on its own line — use sparingly' },
] as const

export const LP_EVENT_TYPE_VALUES: string[] = LP_EVENT_TYPES.map(t => t.value)

/** Types whose natural direction is a REDUCTION of capital. Used only to prefill the sign
 *  in the UI — the user can always override, because a fee can be rebated and a valuation
 *  can be a markdown. */
export const REDUCES_CAPITAL: string[] = [
  'distribution',
  'management_fee',
  'partnership_expense',
  'organizational_expense',
  'carried_interest',
]

export interface EventScope {
  fundId: string
  vehicleId: string
}

/**
 * Resolve a vehicle name to an id, refusing rather than writing an orphan.
 *
 * `vehicleIdByName` returns null for a name that isn't in the registry, and the wider
 * accounting code has a bug where that null gets written straight into a nullable
 * `vehicle_id`, producing rows no query can ever see again. `lp_capital_events.vehicle_id`
 * is NOT NULL precisely so that can't happen here — this turns the FK violation into a
 * clean error instead of a 500.
 */
export async function resolveScope(
  admin: SupabaseClient,
  fundId: string,
  group: string
): Promise<EventScope | { error: string }> {
  const vehicleId = await vehicleIdByName(admin, fundId, group)
  if (!vehicleId) return { error: `Unknown vehicle "${group}" — add it in Settings first.` }
  return { fundId, vehicleId }
}

/** Every LP entity id that belongs to this fund. Body-supplied ids MUST be checked against
 *  this — an unvalidated lp_entity_id is a cross-tenant write even when fund_id is right. */
export async function fundEntityIds(admin: SupabaseClient, fundId: string): Promise<Set<string>> {
  const { data } = await admin
    .from('lp_entities' as any)
    .select('id')
    .eq('fund_id', fundId)
  return new Set(((data as any[]) ?? []).map(r => r.id as string))
}

export async function listEvents(
  admin: SupabaseClient,
  scope: EventScope
): Promise<LpCapitalEvent[]> {
  const { data } = await admin
    .from('lp_capital_events' as any)
    .select('id, lp_entity_id, event_date, amount, source_type, memo, created_at, lp_entities!inner(entity_name)')
    .eq('fund_id', scope.fundId)
    .eq('vehicle_id', scope.vehicleId)
    .order('event_date', { ascending: false })
    .order('created_at', { ascending: false })

  return ((data as any[]) ?? []).map(r => ({
    id: r.id,
    lpEntityId: r.lp_entity_id,
    lpName: r.lp_entities?.entity_name ?? r.lp_entity_id,
    eventDate: r.event_date,
    sourceType: r.source_type,
    capitalDelta: roundCents(-Number(r.amount ?? 0)),
    memo: r.memo ?? null,
    createdAt: r.created_at,
  }))
}

function validate(e: LpCapitalEventInput, validEntities: Set<string>): string | null {
  if (!validEntities.has(e.lpEntityId)) return 'That LP does not belong to this fund.'
  if (!/^\d{4}-\d{2}-\d{2}$/.test(e.eventDate)) return `Invalid date "${e.eventDate}" — use YYYY-MM-DD.`
  if (!LP_EVENT_TYPE_VALUES.includes(e.sourceType)) return `Unknown event type "${e.sourceType}".`
  if (!Number.isFinite(e.capitalDelta)) return 'Amount must be a number.'
  if (e.capitalDelta === 0) return 'Amount cannot be zero.'
  return null
}

export async function createEvents(
  admin: SupabaseClient,
  scope: EventScope,
  events: LpCapitalEventInput[],
  userId: string | null
): Promise<{ created: number } | { error: string }> {
  if (events.length === 0) return { created: 0 }
  const valid = await fundEntityIds(admin, scope.fundId)

  for (const e of events) {
    const problem = validate(e, valid)
    if (problem) return { error: problem }
  }

  const { error } = await admin.from('lp_capital_events' as any).insert(
    events.map(e => ({
      fund_id: scope.fundId,
      vehicle_id: scope.vehicleId,
      lp_entity_id: e.lpEntityId,
      event_date: e.eventDate,
      // The one place the flip happens on the way in.
      amount: roundCents(-e.capitalDelta),
      source_type: e.sourceType,
      memo: e.memo?.trim() || null,
      created_by: userId,
    }))
  )
  if (error) return { error: error.message }
  return { created: events.length }
}

export async function updateEvent(
  admin: SupabaseClient,
  scope: EventScope,
  id: string,
  e: LpCapitalEventInput
): Promise<{ ok: true } | { error: string }> {
  const valid = await fundEntityIds(admin, scope.fundId)
  const problem = validate(e, valid)
  if (problem) return { error: problem }

  const { error } = await admin
    .from('lp_capital_events' as any)
    .update({
      lp_entity_id: e.lpEntityId,
      event_date: e.eventDate,
      amount: roundCents(-e.capitalDelta),
      source_type: e.sourceType,
      memo: e.memo?.trim() || null,
    })
    .eq('id', id)
    // Scoped so a stray id from another fund/vehicle updates nothing rather than something.
    .eq('fund_id', scope.fundId)
    .eq('vehicle_id', scope.vehicleId)
  if (error) return { error: error.message }
  return { ok: true }
}

export async function deleteEvent(
  admin: SupabaseClient,
  scope: EventScope,
  id: string
): Promise<{ ok: true } | { error: string }> {
  const { error } = await admin
    .from('lp_capital_events' as any)
    .delete()
    .eq('id', id)
    .eq('fund_id', scope.fundId)
    .eq('vehicle_id', scope.vehicleId)
  if (error) return { error: error.message }
  return { ok: true }
}
