import { loadGateAccess } from '@/lib/access/request-context'
import { NextResponse } from 'next/server'
import type { SupabaseClient } from '@supabase/supabase-js'
import { hasAccess } from '@/lib/access/effective'
import { isManagementCompany, type VehicleKind } from '@/lib/vehicle-kinds'
import type { Domain } from '@/lib/access/domains'

/**
 * WHICH GRANT A REQUEST FOR A VEHICLE'S BOOKS NEEDS — decided by the vehicle, not by the route.
 *
 * Every other gate in this app answers "may this caller call this route?" and the answer is the
 * same for every row the route can reach. Accounting is the one place that isn't true. A
 * management company's ledger is stored in the same `journal_entries`, `journal_postings` and
 * `chart_of_accounts` tables as every fund's, distinguished only by `vehicle_id` — so
 * `/api/accounting/journal?group=<the manco>` is, to the middleware, the same request as
 * `?group=<Fund II>`. It resolves `accounting`, sees a grant, and hands back the firm's payroll.
 *
 * That is the hole this closes. `resolveGroupOr400` — which all 90-odd accounting call sites
 * already use to work out WHICH vehicle they are serving — now also decides whether this caller
 * may serve it. One choke point, no per-route decision to forget.
 *
 * THE RULE, stated in full:
 *
 *   - An ordinary vehicle (fund / SPV / direct / associate / other) needs `accounting`, which the
 *     middleware has already checked by the time a handler runs. Nothing extra happens, and
 *     nothing extra is loaded — the common path costs one column of one row.
 *   - A management company needs `management_company` AS WELL, at the same level the route
 *     declared. The conjunction is deliberate, and it errs safe: `accounting` alone can never
 *     reach a manco, which is the whole point of splitting the domain.
 *
 * The cost of the conjunction is that a manco-only bookkeeper cannot use the shared ledger pages
 * (journal, bank, QuickBooks) — those sit behind `/api/accounting/*`, which the middleware gates on
 * `accounting` before any of this runs. The manco module's OWN routes (`/api/manco/*`) are gated on
 * `management_company` alone and cover the dashboard, the chart, the statements and intercompany,
 * so that person has a working section; they need the fund-accounting grant only to hand-author
 * journal entries. Widening that means either moving the manco ledger into its own tables or
 * teaching the middleware to read the vehicle out of a request body — neither is worth doing to
 * save a grant, and the failure mode of getting it wrong is disclosing compensation.
 */

// The vocabulary itself lives in a dependency-free module so the pickers can import it too;
// re-exported here so a server caller has one import rather than two.
export {
  VEHICLE_KINDS, MANCO_KIND, isManagementCompany as isMancoKind, type VehicleKind,
} from '@/lib/vehicle-kinds'

/** The domain that owns a vehicle's books. */
export function domainForVehicleKind(kind: string | null | undefined): Domain {
  return isManagementCompany(kind) ? 'management_company' : 'accounting'
}

/**
 * A vehicle's kind, by name or legacy alias. Null when the fund has no such vehicle — which is not
 * an error here: a legacy portfolio_group string with no registry row still keys real ledger rows,
 * and it is an ordinary vehicle by definition (a management company can only exist by being set up
 * as one).
 */
export async function vehicleKindByName(
  admin: SupabaseClient,
  fundId: string,
  name: string,
): Promise<VehicleKind | null> {
  const { data } = await (admin as any)
    .from('fund_vehicles').select('kind').eq('fund_id', fundId).eq('name', name).maybeSingle()
  if (data) return (data.kind as VehicleKind) ?? null
  const { data: alias } = await (admin as any)
    .from('fund_vehicles').select('kind').eq('fund_id', fundId).contains('aliases', [name]).maybeSingle()
  return ((alias?.kind as VehicleKind) ?? null)
}

/** What a gate helper (assertReadAccess / assertWriteAccess / resolveFund) hands back. */
export interface VehicleGate {
  fundId: string
  userId: string
  role: string
  /** The level the route declared by choosing its gate helper. */
  need: 'read' | 'write'
}

/**
 * Refuse a management company to a caller who holds only `accounting`. Returns null to allow.
 *
 * The extra access-context load happens ONLY for a management company — an ordinary vehicle
 * short-circuits on the kind lookup, so the hot path (every other accounting request in the app)
 * pays one extra column, not an extra round trip.
 *
 * The refusal is 403 with a message that names the grant, not a 404: pretending the vehicle does
 * not exist would be a worse lie than the one this replaces, since the caller can see the name in
 * their own vehicle list.
 */
export async function assertVehicleDomain(
  admin: SupabaseClient,
  gate: VehicleGate,
  group: string,
): Promise<NextResponse | null> {
  const kind = await vehicleKindByName(admin, gate.fundId, group)
  if (!isManagementCompany(kind)) return null

  const ctx = await loadGateAccess(admin, gate)
  if (hasAccess(ctx, 'management_company', gate.need)) return null

  return NextResponse.json(
    {
      error:
        `"${group}" is a management company. Its books are gated separately from the funds' — ` +
        `ask an admin for ${gate.need} access to Management company.`,
    },
    { status: 403 },
  )
}

/**
 * The inverse, for the manco module's own routes: this vehicle must BE a management company.
 *
 * `/api/manco/*` is gated on `management_company` in ROUTE_DOMAINS, so a caller who reached the
 * handler holds that grant — but the grant says nothing about which vehicle they named, and
 * without this check `?group=<Fund II>` would read a fund's books through a manco route, i.e. the
 * same hole in the other direction.
 */
export async function assertMancoVehicle(
  admin: SupabaseClient,
  fundId: string,
  group: string,
): Promise<NextResponse | null> {
  const kind = await vehicleKindByName(admin, fundId, group)
  if (isManagementCompany(kind)) return null
  return NextResponse.json(
    { error: `"${group}" is not a management company. Fund vehicles are managed under Funds.` },
    { status: 400 },
  )
}
