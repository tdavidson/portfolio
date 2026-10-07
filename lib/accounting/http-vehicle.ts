import { NextResponse } from 'next/server'
import type { SupabaseClient } from '@supabase/supabase-js'
import { resolveVehicle } from './vehicle-resolver'
import { listVehicles as resolveVehicleList } from './load'
import { assertVehicleDomain, assertMancoVehicle, type VehicleGate } from './vehicle-domain'
import { assertVehicleVisible, visibleVehicleNames } from './vehicle-visibility'

/**
 * Resolve the vehicle (portfolio_group) for a request AND check the caller may have it: the
 * explicit value, or the fund's sole vehicle. Returns a NextResponse when it's ambiguous/missing
 * (400) or when the vehicle belongs to a domain this caller doesn't hold (403).
 *
 * The access check lives here rather than in each route because this is the one line every
 * accounting route already has. `/api/accounting/*` is gated on `accounting` by the middleware,
 * which is the right answer for a fund vehicle and the wrong one for a management company — a
 * manco's ledger is in the same tables, so that grant would serve the firm's payroll to anyone who
 * can reconcile a bank account. `assertVehicleDomain` is what makes the `management_company`
 * domain mean something; see lib/accounting/vehicle-domain.ts for the full rule.
 *
 * It takes the whole gate, not just `fundId`, because the check needs to know who is asking and at
 * what level — and a signature that can't be called without them is the only version a new route
 * cannot get wrong.
 */
export async function resolveGroupOr400(
  admin: SupabaseClient,
  gate: VehicleGate,
  requested?: string | null
): Promise<string | NextResponse> {
  let group: string
  // No entity named: the "sole vehicle" default counts only the entities this caller can see. A
  // member granted one fund of several gets that one — and one granted none is told so, rather than
  // shown a list of entities they cannot see.
  if (!requested) {
    const visible = await visibleVehicleNames(admin, gate)
    if (visible !== null) {
      const funds = await resolveVehicleList(admin, gate.fundId)
      const mine = visible.filter(name => funds.includes(name))
      if (mine.length === 1) requested = mine[0]
      else if (mine.length === 0) return NextResponse.json({ error: "You don't have access to any entity yet." }, { status: 403 })
      else return NextResponse.json({ error: `Specify a vehicle — you have several: ${mine.join(', ')}` }, { status: 400 })
    }
  }
  try {
    // Opt in to management companies, then check the grant immediately below. These are the only
    // two callers that opt in; see the note on resolveVehicle for why the default is to exclude them.
    group = await resolveVehicle(admin, gate.fundId, requested ?? undefined, { includeManagementCompanies: true })
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 400 })
  }
  const hidden = await assertVehicleVisible(admin, gate, group)
  if (hidden) return hidden
  const denied = await assertVehicleDomain(admin, gate, group)
  if (denied) return denied
  return group
}

/**
 * The same, for the management-company module's own routes (`/api/manco/*`): resolve the vehicle
 * and require that it IS a management company.
 *
 * Those routes are gated on `management_company`, so the caller holds the right grant — but a
 * grant says nothing about which vehicle they named, and without this a manco route would read a
 * fund's books for someone who was never given the `accounting` grant. Same hole, other direction.
 *
 * A manco is never the fund's "sole vehicle" in any interesting case, so `requested` is required
 * here rather than defaulted: silently resolving to whatever single vehicle exists would, on a
 * fund that has no manco at all, produce a confusing 400 about the wrong vehicle.
 */
export async function resolveMancoGroupOr400(
  admin: SupabaseClient,
  gate: VehicleGate,
  requested?: string | null
): Promise<string | NextResponse> {
  const group = (requested ?? '').trim()
  if (!group) {
    return NextResponse.json({ error: 'A management company is required (group=…)' }, { status: 400 })
  }
  const wrong = await assertMancoVehicle(admin, gate.fundId, group)
  if (wrong) return wrong
  const hidden = await assertVehicleVisible(admin, gate, group)
  if (hidden) return hidden
  return group
}
