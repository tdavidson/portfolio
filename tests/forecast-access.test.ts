import { beforeEach, describe, expect, it, vi } from 'vitest'
import { readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { DEFAULT_FEATURE_VISIBILITY, type FeatureVisibilityMap } from '@/lib/types/features'
import type { AccessContext } from '@/lib/access/effective'

/**
 * Budget & forecast: who may read and write a plan, checked in the SERVICE so the route, MCP and the
 * Analyst share one answer (acceptance #12, #14). The route boundary is pinned by route-domains.
 */

const mocks = vi.hoisted(() => ({
  resolveVehicle: vi.fn(),
  vehicleKindByName: vi.fn(),
}))

vi.mock('@/lib/accounting/vehicle-resolver', async orig => ({
  ...(await orig<typeof import('@/lib/accounting/vehicle-resolver')>()),
  resolveVehicle: mocks.resolveVehicle,
}))
vi.mock('@/lib/accounting/vehicle-domain', async orig => ({
  ...(await orig<typeof import('@/lib/accounting/vehicle-domain')>()),
  vehicleKindByName: mocks.vehicleKindByName,
}))

import { listPlans, savePlan, ForecastError } from '@/lib/forecast/service'
import { resolveVehicleWithAccess, VehicleAccessError } from '@/lib/accounting/http-vehicle'

const ON: FeatureVisibilityMap = { ...DEFAULT_FEATURE_VISIBILITY, accounting: 'everyone', budgeting: 'everyone', management_company: 'everyone' }

const access = (over: Partial<AccessContext> = {}): AccessContext => ({
  fundId: 'f1',
  userId: 'u1',
  role: 'member',
  vehicles: { all: true, ids: [] },
  features: ON,
  grants: { accounting: 'write' },
  defaults: {},
  ...over,
})

/** An admin client that fails the test if anything reaches the database. */
const untouchable = new Proxy({}, { get: () => { throw new Error('the database was reached before authorization') } }) as any

const ctx = (a: AccessContext) => ({ admin: untouchable, fundId: 'f1', userId: 'u1', access: a })

const status = async (p: Promise<unknown>) => {
  try {
    await p
    return 200
  } catch (e) {
    if (e instanceof ForecastError) return e.status
    throw e
  }
}

beforeEach(() => {
  mocks.resolveVehicle.mockReset()
  mocks.vehicleKindByName.mockReset()
})

describe('forecast service authorization', () => {
  it('refuses everyone when the budgeting switch is off, admins included', async () => {
    const off = { ...ON, budgeting: 'off' } as FeatureVisibilityMap
    expect(await status(listPlans(ctx(access({ features: off })), { vehicle: 'Fund I' }))).toBe(403)
    expect(await status(listPlans(ctx(access({ features: off, role: 'admin' })), { vehicle: 'Fund I' }))).toBe(403)
  })

  it('refuses a member without the accounting grant', async () => {
    expect(await status(listPlans(ctx(access({ grants: {} })), { vehicle: 'Fund I' }))).toBe(403)
  })

  it('refuses a write to a read-only member before loading anything', async () => {
    const reader = access({ grants: { accounting: 'read' } })
    expect(await status(savePlan(ctx(reader), { vehicle: 'Fund I', planId: 'p', expectedRevision: 0 }))).toBe(403)
  })

  it('refuses a vehicle outside the caller\'s entities as unknown', async () => {
    const { VehicleResolutionError } = await import('@/lib/accounting/vehicle-resolver')
    mocks.resolveVehicle.mockRejectedValue(new VehicleResolutionError('Unknown vehicle "Fund II"'))
    const scoped = access({ vehicles: { all: false, ids: ['v1'] } })
    const admin = {} as any
    expect(await status(listPlans({ admin, fundId: 'f1', userId: 'u1', access: scoped }, { vehicle: 'Fund II' }))).toBe(400)
    expect(mocks.resolveVehicle).toHaveBeenCalledWith(admin, 'f1', 'Fund II', expect.objectContaining({ access: scoped }))
  })
})

describe('resolveVehicleWithAccess — a management company needs its own grant', () => {
  it('refuses a manco to an accounting-only member, at the level asked', async () => {
    mocks.resolveVehicle.mockResolvedValue('Hemrock Management')
    mocks.vehicleKindByName.mockResolvedValue('manco')
    await expect(resolveVehicleWithAccess({} as any, access(), 'Hemrock Management', 'read')).rejects.toBeInstanceOf(VehicleAccessError)
    const readOnly = access({ grants: { accounting: 'write', management_company: 'read' } })
    await expect(resolveVehicleWithAccess({} as any, readOnly, 'Hemrock Management', 'write')).rejects.toBeInstanceOf(VehicleAccessError)
    await expect(resolveVehicleWithAccess({} as any, readOnly, 'Hemrock Management', 'read')).resolves.toEqual({ name: 'Hemrock Management', kind: 'manco' })
  })

  it('lets a fund vehicle through on accounting alone', async () => {
    mocks.resolveVehicle.mockResolvedValue('Fund I')
    mocks.vehicleKindByName.mockResolvedValue('fund')
    await expect(resolveVehicleWithAccess({} as any, access(), 'Fund I', 'write')).resolves.toEqual({ name: 'Fund I', kind: 'fund' })
  })
})

describe('forecasts never reach the ledger (acceptance #12)', () => {
  it('no budgeting source names a journal table or a ledger writer', () => {
    const dir = path.join(process.cwd(), 'lib', 'forecast')
    const offenders = readdirSync(dir)
      .filter(f => f.endsWith('.ts') && !f.endsWith('.test.ts'))
      .filter(f => /journal_entries|journal_postings|persistEntry|from\(['"]journal/.test(readFileSync(path.join(dir, f), 'utf8')))
    expect(offenders).toEqual([])
  })

  it('the migration writes only forecast_* tables', () => {
    const sql = readFileSync(path.join(process.cwd(), 'supabase/migrations/20261009500000_forecast_planning.sql'), 'utf8')
    const code = sql.split('\n').filter(l => !l.trim().startsWith('--')).join('\n')
    expect(code).not.toMatch(/journal_/)
    expect(code).not.toMatch(/\bbook\b/)
  })
})
