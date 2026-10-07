import { beforeEach, describe, expect, it, vi } from 'vitest'
import { NextRequest } from 'next/server'
import { DEFAULT_ASSUMPTIONS } from '@/lib/accounting/construction'

const mocks = vi.hoisted(() => ({
  getUser: vi.fn(),
  assertReadAccess: vi.fn(),
  assertWriteAccess: vi.fn(),
  resolveGroupOr400: vi.fn(),
  getConstructionModel: vi.fn(),
  updateConstructionAssumptions: vi.fn(),
  admin: {},
}))

vi.mock('@/lib/supabase/server', () => ({
  createClient: () => ({ auth: { getUser: mocks.getUser } }),
}))
vi.mock('@/lib/supabase/admin', () => ({ createAdminClient: () => mocks.admin }))
vi.mock('@/lib/api-helpers', () => ({
  assertReadAccess: mocks.assertReadAccess,
  assertWriteAccess: mocks.assertWriteAccess,
}))
vi.mock('@/lib/accounting/http-vehicle', () => ({ resolveGroupOr400: mocks.resolveGroupOr400 }))
vi.mock('@/lib/access/effective', () => ({ loadAccessContext: async () => ({ vehicles: { all: true, ids: [] } }) }))
vi.mock('@/lib/accounting/construction-service', () => ({
  getConstructionModel: mocks.getConstructionModel,
  updateConstructionAssumptions: mocks.updateConstructionAssumptions,
}))

import { GET, PUT } from '@/app/api/accounting/construction/route'

const canonical = {
  vehicle: 'Fund II',
  vehicleId: 'vehicle-2',
  actuals: { ledgerAvailable: false, committedCapital: 10_000_000 },
  assumptions: DEFAULT_ASSUMPTIONS,
  forecast: { capital: {}, returns: {}, warnings: [] },
  positions: [],
  warnings: [],
  vintageYear: 2024,
  ledgerAvailable: false,
  asOf: '2026-09-02T12:00:00.000Z',
}

describe('legacy construction route', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.getUser.mockResolvedValue({ data: { user: { id: 'user-1' } } })
    mocks.assertReadAccess.mockResolvedValue({ fundId: 'fund-1', role: 'member' })
    mocks.assertWriteAccess.mockResolvedValue({ fundId: 'fund-1', role: 'member' })
    mocks.resolveGroupOr400.mockResolvedValue('Fund II')
    mocks.getConstructionModel.mockResolvedValue(canonical)
    mocks.updateConstructionAssumptions.mockResolvedValue(canonical)
  })

  it('delegates GET to the service and preserves the legacy response shape', async () => {
    const response = await GET(new NextRequest('https://reporting.test/api/accounting/construction?group=Fund%20II'))

    expect(mocks.getConstructionModel).toHaveBeenCalledWith(
      { admin: mocks.admin, fundId: 'fund-1', access: expect.anything() },
      { vehicle: 'Fund II' },
    )
    expect(await response.json()).toEqual({
      group: 'Fund II',
      vehicleId: 'vehicle-2',
      actuals: canonical.actuals,
      assumptions: DEFAULT_ASSUMPTIONS,
    })
  })

  it('delegates PUT and returns only the saved assumptions', async () => {
    const body = { ...DEFAULT_ASSUMPTIONS, feeAnnualRate: 0.015 }
    const response = await PUT(new NextRequest(
      'https://reporting.test/api/accounting/construction?group=Fund%20II',
      { method: 'PUT', body: JSON.stringify(body), headers: { 'content-type': 'application/json' } },
    ))

    expect(mocks.updateConstructionAssumptions).toHaveBeenCalledWith(
      { admin: mocks.admin, fundId: 'fund-1', access: expect.anything() },
      { vehicle: 'Fund II', assumptions: body },
    )
    expect(await response.json()).toEqual({ assumptions: DEFAULT_ASSUMPTIONS })
  })
})
