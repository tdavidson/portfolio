// Period close & locking. A closed fiscal period freezes the books for its date
// range: persistEntry refuses to post entries dated inside it (reopen to amend).
// Closing snapshots the ledger as plain-text double-entry — the immutable audit record.

import type { SupabaseClient } from '@supabase/supabase-js'
import { exportLedgerText } from './text-ledger-run'
import { vehicleIdByName } from './vehicle-id'

export interface PeriodRange {
  period_start: string
  period_end: string
}

/** True if `date` (ISO) falls within any of the given (closed) period ranges. */
export function dateInAnyClosedPeriod(periods: PeriodRange[], date: string): boolean {
  return periods.some(p => date >= p.period_start && date <= p.period_end)
}

/** The closed periods for a vehicle (for the persistEntry lock check). */
export async function closedPeriodRanges(admin: SupabaseClient, fundId: string, group: string): Promise<PeriodRange[]> {
  const vehicleId = await vehicleIdByName(admin, fundId, group)
  const { data } = await admin
    .from('fiscal_periods' as any)
    .select('period_start, period_end')
    .eq('fund_id', fundId)
    .eq('vehicle_id', vehicleId)
    .eq('status', 'closed')
  return ((data as any[]) ?? []).map(p => ({ period_start: p.period_start, period_end: p.period_end }))
}

export async function listPeriods(admin: SupabaseClient, fundId: string, group: string) {
  const vehicleId = await vehicleIdByName(admin, fundId, group)
  const { data } = await admin
    .from('fiscal_periods' as any)
    .select('id, period_start, period_end, label, status, closed_at')
    .eq('fund_id', fundId)
    .eq('vehicle_id', vehicleId)
    .order('period_end', { ascending: false })
  return data ?? []
}

/**
 * Close and lock a period: validate it doesn't overlap an existing closed period,
 * snapshot the ledger text as of the period end, and record the closed period.
 */
export async function closePeriod(
  admin: SupabaseClient,
  fundId: string,
  group: string,
  userId: string | null,
  periodStart: string,
  periodEnd: string,
  label?: string
): Promise<{ id: string } | { error: string }> {
  if (!periodStart || !periodEnd || periodStart > periodEnd) return { error: 'A valid period start and end are required' }

  const existing = await closedPeriodRanges(admin, fundId, group)
  if (existing.some(p => periodStart <= p.period_end && periodEnd >= p.period_start)) {
    return { error: 'This period overlaps an already-closed period' }
  }

  let snapshot: string
  try {
    snapshot = await exportLedgerText(admin, fundId, group, periodEnd)
  } catch (e) {
    return { error: `The ledger snapshot could not be taken, so the period was not closed: ${e instanceof Error ? e.message : String(e)}` }
  }
  const vehicleId = await vehicleIdByName(admin, fundId, group)
  const { data, error } = await admin
    .from('fiscal_periods' as any)
    .insert({
      fund_id: fundId,
      portfolio_group: group,
      vehicle_id: vehicleId,
      period_start: periodStart,
      period_end: periodEnd,
      label: label ?? null,
      status: 'closed',
      closed_at: new Date().toISOString(),
      closed_by: userId,
      snapshot_text: snapshot,
    })
    .select('id')
    .single()
  if (error) return { error: error.message }
  return { id: (data as any).id }
}

export async function reopenPeriod(admin: SupabaseClient, fundId: string, group: string, id: string): Promise<{ ok: true } | { error: string }> {
  const vehicleId = await vehicleIdByName(admin, fundId, group)
  const { error } = await admin
    .from('fiscal_periods' as any)
    .update({ status: 'open', closed_at: null })
    .eq('id', id)
    .eq('fund_id', fundId)
    .eq('vehicle_id', vehicleId)
  if (error) return { error: error.message }
  return { ok: true }
}
