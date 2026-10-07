import type { SupabaseClient } from '@supabase/supabase-js'
import { listVehicles, listMancoVehicles } from './load'
import type { AccessContext } from '@/lib/access/effective'

export class VehicleResolutionError extends Error {
  readonly code = 'INVALID_VEHICLE'
}

/**
 * Resolve a vehicle name against the fund's canonical vehicle list. An explicit name is matched
 * case-insensitively (while returning the stored spelling); an omitted name is only valid for a
 * single-vehicle fund.
 *
 * MANAGEMENT COMPANIES ARE EXCLUDED UNLESS ASKED FOR, and that default is a security boundary
 * rather than a tidiness one.
 *
 * This function is where every vehicle-scoped surface in the app turns a name into a ledger: the 57
 * accounting routes, the MCP tools, the Analyst's accounting context, the pending-action builders,
 * the construction service. All of them are gated on the `accounting` grant, and a management
 * company's books sit in the same tables as a fund's — so any of them, handed a manco's name, would
 * have served the firm's payroll to whoever could reconcile a bank account.
 *
 * Resolving against `listVehicles` (which omits mancos) means every one of those callers refuses a
 * management company by DEFAULT, without having been changed and without having to remember. Only a
 * caller that has actually checked the `management_company` grant opts in, by passing
 * `includeManagementCompanies` — and today there are exactly two, both in http-vehicle.ts, both of
 * which run the check immediately afterwards.
 *
 * The failure mode when a caller forgets is "unknown vehicle", not "here is the payroll".
 */
export async function resolveVehicle(
  admin: SupabaseClient,
  fundId: string,
  requested?: string,
  opts?: {
    /**
     * Include management companies in the candidate set. Set ONLY by a caller that then checks the
     * `management_company` grant — see `assertVehicleDomain`.
     */
    includeManagementCompanies?: boolean
    /**
     * The caller's access. Given, only their entities are candidates: a name they cannot see is
     * "unknown" (and the error lists only theirs), and the single-entity default counts only theirs.
     * Every caller acting for a user — agent tools, MCP, pending actions — passes it.
     */
    access?: Pick<AccessContext, 'vehicles'>
  },
): Promise<string> {
  let vehicles = await listVehicles(admin, fundId)
  let visibleNames: string[] | null = null
  if (opts?.access && !opts.access.vehicles.all) {
    const ids = opts.access.vehicles.ids
    const { data } = ids.length > 0
      ? await (admin as any).from('fund_vehicles').select('id, name, aliases').eq('fund_id', fundId).in('id', ids)
      : { data: [] }
    visibleNames = ((data as any[]) ?? []).map(v => v.name as string)
    vehicles = vehicles.filter(v => visibleNames!.includes(v))
  }

  if (requested) {
    // A management company is only ever reachable by NAME. It is deliberately absent from the
    // "which vehicle did you mean" default below, so that a single-fund firm that sets one up does
    // not suddenly have two candidates and start getting "specify a vehicle" from every page that
    // used to resolve on its own.
    const candidates = opts?.includeManagementCompanies
      ? vehicles.concat((await listMancoVehicles(admin, fundId)).map(m => m.name)
          .filter(n => visibleNames === null || visibleNames.includes(n)))
      : vehicles
    const match = candidates.find(vehicle => vehicle === requested)
      ?? candidates.find(vehicle => vehicle.trim().toLowerCase() === requested.trim().toLowerCase())
    if (!match) {
      throw new VehicleResolutionError(
        vehicles.length > 0
          ? `Unknown vehicle "${requested}". This fund has: ${vehicles.join(', ')}`
          : `Unknown vehicle "${requested}" — this fund has no vehicles yet.`,
      )
    }
    return match
  }

  if (vehicles.length === 1) return vehicles[0]
  if (vehicles.length === 0) throw new VehicleResolutionError('No vehicles found for this fund')
  throw new VehicleResolutionError(`Specify a vehicle — this fund has several: ${vehicles.join(', ')}`)
}
