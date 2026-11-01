import type { ActionDeps } from './types'
import type { WriteAction } from './registry'
import { resolveVehicle } from '@/lib/accounting/vehicle-resolver'
import { resolveVehicleWithAccess } from '@/lib/accounting/http-vehicle'
import { vehicleIdByName } from '@/lib/accounting/vehicle-id'
import { entityCap } from '@/lib/access/scope'
import { entityCapRefusal } from '@/lib/accounting/vehicle-visibility'

/**
 * The entity a staged action acts on, resolved once with the stager's access and pinned: the
 * stored args carry the resolved name, and the row carries its id. Throws when the action needs an
 * entity and the stager has none to give it.
 */
export async function stagedTarget(
  deps: ActionDeps,
  action: Pick<WriteAction, 'entity' | 'managementCompanies'>,
  input: any,
): Promise<{ input: any; vehicleId: string | null }> {
  if (action.entity === 'none') return { input, vehicleId: null }
  const requested = typeof input?.vehicle === 'string' && input.vehicle.trim() ? input.vehicle : undefined
  if (action.entity === 'optional' && !requested) return { input, vehicleId: null }
  // A management company is reachable only through the grant-checking resolver, and only by name.
  const name = action.managementCompanies && requested
    ? (await resolveVehicleWithAccess(deps.admin, deps.access, requested, 'read')).name
    : await resolveVehicle(deps.admin, deps.fundId, requested, { access: deps.access })
  const vehicleId = await vehicleIdByName(deps.admin, deps.fundId, name)
  // Staging is a proposal: a propose-level member may ask, a read-level one may not.
  if (entityCap(deps.access, vehicleId) === 'read') throw new Error(entityCapRefusal(name, 'read'))
  return { input: { ...input, vehicle: name }, vehicleId }
}
