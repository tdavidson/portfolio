import { describe, expect, it } from 'vitest'
import { resolveHoldingVehicle } from '@/lib/portfolio/fof-register'

/**
 * A fund holding's entity lives on its register rows and nowhere else. Before this, both write
 * paths defaulted it to null and the form never sent one — so a notice could never be confirmed
 * (`confirmFundCapitalEvent` refuses an event with no vehicle) and the schedule of investments
 * had nothing to scope by, which is why every entity listed every entity's holdings.
 */
function admin(opts: { vehicles?: string[]; events?: (string | null)[]; navs?: (string | null)[] } = {}) {
  const calls: string[] = []
  const rows = (table: string) => {
    if (table === 'fund_capital_events') return (opts.events ?? []).map(vehicle_id => ({ vehicle_id }))
    if (table === 'fund_nav_statements') return (opts.navs ?? []).map(vehicle_id => ({ vehicle_id }))
    return []
  }
  return {
    calls,
    client: {
      from(table: string) {
        calls.push(table)
        const chain: any = {
          select: () => chain,
          eq: () => chain,
          not: () => chain,
          maybeSingle: async () => ({
            data: table === 'fund_vehicles' && (opts.vehicles ?? []).length > 0 ? { id: (opts.vehicles ?? [])[0] } : null,
          }),
          then: (res: (v: unknown) => unknown, rej: (r: unknown) => unknown) =>
            Promise.resolve({ data: rows(table) }).then(res, rej),
        }
        return chain
      },
    } as any,
  }
}

describe('resolveHoldingVehicle', () => {
  it('validates an explicitly named entity against this fund', async () => {
    const a = admin({ vehicles: ['v1'] })
    expect(await resolveHoldingVehicle(a.client, 'fund', 'holding', 'v1', { vehicles: { all: true, ids: [] } })).toEqual({ vehicleId: 'v1' })
    expect(a.calls).toContain('fund_vehicles')
  })

  it('refuses an entity from another fund', async () => {
    const a = admin({ vehicles: [] })
    expect(await resolveHoldingVehicle(a.client, 'fund', 'holding', 'someone-elses', { vehicles: { all: true, ids: [] } }))
      .toEqual({ error: 'That entity is not in this fund.' })
  })

  it('infers the entity the holding already uses, so only the first notice has to say', async () => {
    const a = admin({ events: ['v1', 'v1'], navs: ['v1'] })
    expect(await resolveHoldingVehicle(a.client, 'fund', 'holding', undefined, { vehicles: { all: true, ids: [] } })).toEqual({ vehicleId: 'v1' })
  })

  it('infers it from a NAV statement when there are no notices yet', async () => {
    const a = admin({ navs: ['v2'] })
    expect(await resolveHoldingVehicle(a.client, 'fund', 'holding', undefined, { vehicles: { all: true, ids: [] } })).toEqual({ vehicleId: 'v2' })
  })

  it('asks when the holding has no entity yet, rather than writing null', async () => {
    const a = admin({})
    const result = await resolveHoldingVehicle(a.client, 'fund', 'holding', undefined, { vehicles: { all: true, ids: [] } })
    expect(result).toHaveProperty('error')
    expect((result as { error: string }).error).toMatch(/Choose which entity/)
  })

  it('asks when the register names more than one entity, rather than picking', async () => {
    const a = admin({ events: ['v1'], navs: ['v2'] })
    const result = await resolveHoldingVehicle(a.client, 'fund', 'holding', undefined, { vehicles: { all: true, ids: [] } })
    expect((result as { error: string }).error).toMatch(/more than one entity/)
  })

  it('ignores an empty string as if nothing was named', async () => {
    const a = admin({ events: ['v1'] })
    expect(await resolveHoldingVehicle(a.client, 'fund', 'holding', '', { vehicles: { all: true, ids: [] } })).toEqual({ vehicleId: 'v1' })
  })
})
