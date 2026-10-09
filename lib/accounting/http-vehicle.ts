import { NextResponse } from 'next/server'
import type { SupabaseClient } from '@supabase/supabase-js'
import { resolveVehicle, VehicleResolutionError } from './vehicle-resolver'
import { listVehicles as resolveVehicleList } from './load'
import { assertVehicleDomain, assertMancoVehicle, vehicleKindByName, type VehicleGate } from './vehicle-domain'
import { hasAccess, type AccessContext } from '@/lib/access/effective'
import { isManagementCompany } from '@/lib/vehicle-kinds'
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

/**
 * The service-layer twin of `resolveGroupOr400`, for callers that already hold the caller's
 * AccessContext and run outside a route (the budgeting service, its MCP tools and Analyst
 * actions — one code path for all of them). Resolves a fund vehicle OR a management company among
 * the caller's own entities, and refuses the manco unless they hold `management_company` at
 * `need`. Throws rather than returning a response; the caller maps the error.
 *
 * Lives here so the opt-in and its check stay in the one file tests/manco-vehicle-domain.test.ts
 * watches, in the same function, check before return.
 */
export class VehicleAccessError extends Error {
  readonly status = 403
}

export async function resolveVehicleWithAccess(
  admin: SupabaseClient,
  access: AccessContext,
  requested: string,
  need: 'read' | 'write',
): Promise<{ name: string; kind: string | null }> {
  if (!requested?.trim()) throw new VehicleResolutionError('A vehicle is required')
  const name = await resolveVehicle(admin, access.fundId, requested, { includeManagementCompanies: true, access })
  const kind = await vehicleKindByName(admin, access.fundId, name)
  if (isManagementCompany(kind) && !hasAccess(access, 'management_company', need)) {
    throw new VehicleAccessError(
      `"${name}" is a management company. Its books are gated separately from the funds' — ` +
        `ask an admin for ${need} access to Management company.`,
    )
  }
  return { name, kind }
}
