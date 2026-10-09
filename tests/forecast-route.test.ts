import { beforeEach, describe, expect, it, vi } from 'vitest'
import { NextRequest, NextResponse } from 'next/server'

const mocks = vi.hoisted(() => ({
  getUser: vi.fn(),
  assertReadAccess: vi.fn(),
  assertWriteAccess: vi.fn(),
  resolveGroupOr400: vi.fn(),
  savePlan: vi.fn(),
  getSeries: vi.fn(),
}))

vi.mock('@/lib/supabase/server', () => ({ createClient: () => ({ auth: { getUser: mocks.getUser } }) }))
vi.mock('@/lib/supabase/admin', () => ({ createAdminClient: () => ({}) }))
vi.mock('@/lib/api-helpers', () => ({ assertReadAccess: mocks.assertReadAccess, assertWriteAccess: mocks.assertWriteAccess }))
vi.mock('@/lib/accounting/http-vehicle', () => ({ resolveGroupOr400: mocks.resolveGroupOr400 }))
vi.mock('@/lib/access/effective', () => ({ loadAccessContext: async () => ({ vehicles: { all: true, ids: [] } }) }))
vi.mock('@/lib/forecast/service', async orig => ({
  ...(await orig<typeof import('@/lib/forecast/service')>()),
  savePlan: mocks.savePlan,
  getSeries: mocks.getSeries,
}))

import { PATCH } from '@/app/api/accounting/forecast/[id]/route'
import { GET as SERIES } from '@/app/api/accounting/forecast/series/route'
import { ForecastError } from '@/lib/forecast/service'

const gate = { fundId: 'f1', userId: 'u1', role: 'member', need: 'write' }

beforeEach(() => {
  vi.clearAllMocks()
  mocks.getUser.mockResolvedValue({ data: { user: { id: 'u1' } } })
  mocks.assertReadAccess.mockResolvedValue({ ...gate, need: 'read' })
  mocks.assertWriteAccess.mockResolvedValue(gate)
  mocks.resolveGroupOr400.mockResolvedValue('Hemrock Management')
})

const patch = (body: unknown) =>
  PATCH(
    new NextRequest('http://x/api/accounting/forecast/p1?group=Hemrock%20Management', { method: 'PATCH', body: JSON.stringify(body) }),
    { params: Promise.resolve({ id: 'p1' }) },
  )

describe('forecast routes', () => {
  it('passes the revision through and answers 409 on a stale one', async () => {
    mocks.savePlan.mockRejectedValue(new ForecastError('The plan changed since you loaded it', 409))
    const res = await patch({ expectedRevision: 3, overrides: [{ accountId: 'a', month: '2026-09', amount: 5 }] })
    expect(res.status).toBe(409)
    expect(mocks.savePlan.mock.calls[0][1]).toMatchObject({ vehicle: 'Hemrock Management', planId: 'p1', expectedRevision: 3 })
  })

  it('uses the write gate for writes and stops at its refusal', async () => {
    mocks.assertWriteAccess.mockResolvedValue(NextResponse.json({ error: 'demo' }, { status: 403 }))
    const res = await patch({ expectedRevision: 0 })
    expect(res.status).toBe(403)
    expect(mocks.savePlan).not.toHaveBeenCalled()
  })

  it('refuses before the service when the vehicle check fails', async () => {
    mocks.resolveGroupOr400.mockResolvedValue(NextResponse.json({ error: 'manco' }, { status: 403 }))
    const res = await SERIES(new NextRequest('http://x/api/accounting/forecast/series?group=M&start=2026-01&end=2026-12'))
    expect(res.status).toBe(403)
    expect(mocks.getSeries).not.toHaveBeenCalled()
    expect(mocks.assertReadAccess).toHaveBeenCalled()
    expect(mocks.assertWriteAccess).not.toHaveBeenCalled()
  })

  it('401s without a session', async () => {
    mocks.getUser.mockResolvedValue({ data: { user: null } })
    expect((await patch({})).status).toBe(401)
  })

  it('hides unexpected errors behind a 500', async () => {
    mocks.getSeries.mockRejectedValue(new Error('relation "secret" does not exist'))
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const res = await SERIES(new NextRequest('http://x/api/accounting/forecast/series?group=M&start=2026-01&end=2026-12'))
    expect(res.status).toBe(500)
    expect(await res.json()).toEqual({ error: 'Failed' })
  })
})
