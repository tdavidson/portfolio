import type { ActionDeps } from './types'
import type { WriteAction } from './registry'
import { resolveVehicle } from '@/lib/accounting/vehicle-resolver'
import { vehicleIdByName } from '@/lib/accounting/vehicle-id'

/**
 * The entity a staged action acts on, resolved once with the stager's access and pinned: the
 * stored args carry the resolved name, and the row carries its id. Throws when the action needs an
 * entity and the stager has none to give it.
 */
export async function stagedTarget(
  deps: ActionDeps,
  action: Pick<WriteAction, 'entity'>,
  input: any,
): Promise<{ input: any; vehicleId: string | null }> {
  if (action.entity === 'none') return { input, vehicleId: null }
  const requested = typeof input?.vehicle === 'string' && input.vehicle.trim() ? input.vehicle : undefined
  if (action.entity === 'optional' && !requested) return { input, vehicleId: null }
  const name = await resolveVehicle(deps.admin, deps.fundId, requested, { access: deps.access })
  const vehicleId = await vehicleIdByName(deps.admin, deps.fundId, name)
  return { input: { ...input, vehicle: name }, vehicleId }
}
