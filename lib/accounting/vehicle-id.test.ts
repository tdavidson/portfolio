import { describe, expect, it } from 'vitest'
import { loadVehicleIdMap, vehicleIdByName } from './vehicle-id'

/** A query builder whose every link returns itself and whose terminal resolves to `result`. */
const stub = (result: { data: unknown; error: unknown }) => {
  const q: any = new Proxy({}, { get: (_t, prop) => (prop === 'then' ? (res: any) => res(result) : () => q) })
  return { from: () => q } as any
}

describe('vehicle id lookups', () => {
  it('throw on a failed fund_vehicles read instead of reporting "no vehicle"', async () => {
    const admin = stub({ data: null, error: { message: 'boom' } })
    await expect(vehicleIdByName(admin, 'f', 'Fund I')).rejects.toThrow(/fund_vehicles read failed: boom/)
    await expect(loadVehicleIdMap(admin, 'f')).rejects.toThrow(/fund_vehicles read failed: boom/)
  })

  it('still returns null for a name the registry does not have', async () => {
    expect(await vehicleIdByName(stub({ data: null, error: null }), 'f', 'Nope')).toBeNull()
  })
})
