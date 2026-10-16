import { beforeEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_FEATURE_VISIBILITY, type FeatureVisibilityMap } from '@/lib/types/features'
import type { AccessContext } from '@/lib/access/effective'

/**
 * The agent tools (MCP, the REST agent, the Analyst) reach a management company's books by NAME,
 * through resolveVehicleWithAccess — so an agent can post a manco's bank transactions, but only
 * for a credential whose owner holds `management_company` at the tool's own level.
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

import { getTool, resolveVehicleForTool } from '@/lib/accounting/agent-tools'
import { VehicleAccessError } from '@/lib/accounting/http-vehicle'

const ON: FeatureVisibilityMap = { ...DEFAULT_FEATURE_VISIBILITY, accounting: 'everyone', management_company: 'everyone' }

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

const admin = {} as any
const post = getTool('post_bank_transaction')!
const list = getTool('list_bank_transactions')!

beforeEach(() => {
  mocks.resolveVehicle.mockReset()
  mocks.vehicleKindByName.mockReset()
})

describe('resolveVehicleForTool — management companies', () => {
  it('resolves a named manco for an owner who holds management_company at the tool\'s level', async () => {
    mocks.resolveVehicle.mockResolvedValue('Northwind Holdings LLC')
    mocks.vehicleKindByName.mockResolvedValue('manco')
    const a = access({ grants: { accounting: 'write', management_company: 'write' } })
    await expect(resolveVehicleForTool(post, admin, 'f1', 'northwind holdings llc', a)).resolves.toBe('Northwind Holdings LLC')
    expect(mocks.resolveVehicle).toHaveBeenCalledWith(admin, 'f1', 'northwind holdings llc', { includeManagementCompanies: true, access: a })
  })

  it('refuses a manco to an accounting-only owner', async () => {
    mocks.resolveVehicle.mockResolvedValue('Northwind Holdings LLC')
    mocks.vehicleKindByName.mockResolvedValue('manco')
    await expect(resolveVehicleForTool(list, admin, 'f1', 'Northwind Holdings LLC', access())).rejects.toBeInstanceOf(VehicleAccessError)
  })

  it('refuses a write tool on a manco when the owner holds it read-only', async () => {
    mocks.resolveVehicle.mockResolvedValue('Northwind Holdings LLC')
    mocks.vehicleKindByName.mockResolvedValue('manco')
    const a = access({ grants: { accounting: 'write', management_company: 'read' } })
    await expect(resolveVehicleForTool(post, admin, 'f1', 'Northwind Holdings LLC', a)).rejects.toBeInstanceOf(VehicleAccessError)
    await expect(resolveVehicleForTool(list, admin, 'f1', 'Northwind Holdings LLC', a)).resolves.toBe('Northwind Holdings LLC')
  })

  it('lets a named fund vehicle through on accounting alone', async () => {
    mocks.resolveVehicle.mockResolvedValue('Fund I')
    mocks.vehicleKindByName.mockResolvedValue('fund')
    await expect(resolveVehicleForTool(post, admin, 'f1', 'Fund I', access())).resolves.toBe('Fund I')
  })

  it('never defaults to a manco when no vehicle is named', async () => {
    mocks.resolveVehicle.mockResolvedValue('Fund I')
    const a = access()
    await expect(resolveVehicleForTool(post, admin, 'f1', undefined, a)).resolves.toBe('Fund I')
    expect(mocks.resolveVehicle).toHaveBeenCalledWith(admin, 'f1', undefined, { access: a })
  })
})
