import { describe, it, expect } from 'vitest'
import { resolveHoldingVehicle } from './fof-register'

/** fund_vehicles + the holding's existing activity (events/navs/accounts), by table. */
function admin(tables: Record<string, any[]>) {
  const from = (table: string) => {
    const f: Record<string, any> = {}
    const chain: any = {
      select: () => chain,
      eq: (k: string, v: any) => { f[k] = v; return chain },
      not: () => chain,
      rows: () => (tables[table] ?? []).filter(r => Object.entries(f).every(([k, v]) => r[k] === v)),
      maybeSingle: async () => ({ data: chain.rows()[0] ?? null, error: null }),
      then: (res: any) => res({ data: chain.rows(), error: null }),
    }
    return chain
  }
  return { from } as any
}

const world = (activity: string[]) => admin({
  fund_vehicles: [{ id: 'v1', fund_id: 'f1' }, { id: 'v2', fund_id: 'f1' }],
  fund_capital_events: activity.map(v => ({ fund_id: 'f1', company_id: 'h1', vehicle_id: v })),
  fund_nav_statements: [],
  chart_of_accounts: [],
})
const member = { vehicles: { all: false, ids: ['v1'] } }
const everyone = { vehicles: { all: true, ids: [] } }

describe('resolveHoldingVehicle — a fund holding\'s entity, for the caller', () => {
  it('refuses a member an entity they were not granted', async () => {
    expect(await resolveHoldingVehicle(world([]), 'f1', 'h1', 'v2', member)).toEqual({ error: "You don't have access to that entity." })
  })

  it('accepts a member\'s own entity', async () => {
    expect(await resolveHoldingVehicle(world([]), 'f1', 'h1', 'v1', member)).toEqual({ vehicleId: 'v1' })
  })

  it('infers only among the member\'s entities — never another fund\'s commitment to the same holding', async () => {
    expect(await resolveHoldingVehicle(world(['v1', 'v2']), 'f1', 'h1', undefined, member)).toEqual({ vehicleId: 'v1' })
    expect(await resolveHoldingVehicle(world(['v2']), 'f1', 'h1', undefined, member)).toMatchObject({ error: expect.stringMatching(/Choose/) })
  })

  it('leaves an admin\'s inference unchanged', async () => {
    expect(await resolveHoldingVehicle(world(['v1', 'v2']), 'f1', 'h1', undefined, everyone)).toMatchObject({ error: expect.stringMatching(/more than one/) })
  })
})
