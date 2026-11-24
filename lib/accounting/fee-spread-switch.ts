// Whether a vehicle spreads its management fee monthly, and the switch that turns it on or off.
//
// The spread is a recurring journal entry of kind management_fee_spread (recurring-entries.ts),
// one per vehicle. It is the only record of whether spreading is on: loadFeeSchedule reports it as
// the schedule's `monthlyAccrual`, and saving a fee schedule with `monthlyAccrual` set (the fee
// schedule's checkbox, set_fee_schedule over MCP) creates, resumes or pauses it here.
//
// Kept apart from recurring-entries.ts so the fee schedule can read it without importing the fee
// periods module that imports the fee schedule.

import type { SupabaseClient } from '@supabase/supabase-js'

export const FEE_SPREAD_KIND = 'management_fee_spread'
export const FEE_SPREAD_NAME = 'Management fee spread'

const firstOfMonth = (date: string) => `${date.slice(0, 7)}-01`

/** True when the vehicle has an active spread. False when the table or its columns are missing. */
export async function feeSpreadActive(admin: SupabaseClient, fundId: string, vehicleId: string): Promise<boolean> {
  try {
    const { data, error } = await (admin as any).from('accounting_schedules').select('id')
      .eq('fund_id', fundId).eq('vehicle_id', vehicleId).eq('kind', FEE_SPREAD_KIND).eq('active', true).limit(1)
    return !error && ((data as any[]) ?? []).length > 0
  } catch {
    return false
  }
}

/**
 * Turn the vehicle's spread on (create it, or resume a paused one) or off (pause it; its booked
 * entries stay). A new spread starts this month, in `mode` (remind unless given), so turning it on
 * never back-books past months unattended: earlier months are listed for a person to review.
 */
export async function setFeeSpread(
  admin: SupabaseClient, fundId: string, vehicleId: string, on: boolean,
  opts: { userId?: string | null; mode?: 'remind' | 'draft' | 'post'; today?: string } = {},
): Promise<{ ok: true; id: string | null } | { error: string }> {
  const today = opts.today ?? new Date().toISOString().slice(0, 10)
  const { data: rows, error } = await (admin as any).from('accounting_schedules').select('id, active, mode')
    .eq('fund_id', fundId).eq('vehicle_id', vehicleId).eq('kind', FEE_SPREAD_KIND).limit(1)
  if (error) return { error: `The monthly spread could not be read (${error.message}). Has migration 20261124060000 been applied?` }
  const existing = ((rows as any[]) ?? [])[0] as { id: string; active: boolean; mode: string } | undefined
  const now = new Date().toISOString()
  if (existing) {
    if (existing.active === on) return { ok: true, id: existing.id }
    const patch: Record<string, unknown> = { active: on, updated_at: now, updated_by: opts.userId ?? null }
    // Resuming re-arms the unattended run from today: the months it was paused are for a person.
    if (on && (existing.mode === 'draft' || existing.mode === 'post')) patch.auto_from = today
    const { error: upErr } = await (admin as any).from('accounting_schedules').update(patch).eq('id', existing.id).eq('fund_id', fundId)
    return upErr ? { error: upErr.message } : { ok: true, id: existing.id }
  }
  if (!on) return { ok: true, id: null }
  const mode = opts.mode ?? 'remind'
  const { data: created, error: insErr } = await (admin as any).from('accounting_schedules').insert({
    fund_id: fundId, vehicle_id: vehicleId, name: FEE_SPREAD_NAME, kind: FEE_SPREAD_KIND, template_key: FEE_SPREAD_KIND,
    memo: null, source_type: 'management_fee', frequency: 'monthly', day_of_month: 1, start_date: firstOfMonth(today),
    mode, auto_from: mode === 'remind' ? null : today, required_for_close: true, active: true,
    created_by: opts.userId ?? null, updated_by: opts.userId ?? null,
  }).select('id').single()
  if (insErr) return { error: insErr.message }
  return { ok: true, id: created.id as string }
}
