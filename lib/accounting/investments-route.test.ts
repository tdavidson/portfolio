import { describe, it, expect, vi } from 'vitest'
import * as helpers from '@/lib/api-helpers'
import { NextRequest } from 'next/server'

vi.mock('@/lib/supabase/server', () => ({ createClient: async () => ({ auth: { getUser: async () => ({ data: { user: { id: 'u' } } }) } }) }))
vi.mock('@/lib/supabase/admin', () => ({ createAdminClient: () => ({}) }))
vi.mock('@/lib/api-helpers', async (orig) => ({ ...(await orig<any>()), assertWriteAccess: vi.fn(async () => ({ fundId: 'f', userId: 'u', role: 'admin' })) }))
vi.mock('@/lib/accounting/http-vehicle', () => ({ resolveGroupOr400: async () => 'Fund I' }))
vi.mock('@/lib/accounting/investment-backfill', () => ({ backfillDerivedEntries: vi.fn(async () => ({ toDerive: 0 })), backfillAllVehicles: vi.fn(async () => [{ vehicle: 'Fund I', result: { toDerive: 0 } }]) }))
vi.mock('@/lib/accounting/vehicle-visibility', () => ({ visibleVehicleNames: vi.fn(async () => null) }))
import { POST } from '@/app/api/accounting/investments/route'

import { backfillAllVehicles } from '@/lib/accounting/investment-backfill'
const post = (body: object) => POST(new NextRequest('http://localhost/api/accounting/investments', { method: 'POST', body: JSON.stringify(body) }))

describe('POST /api/accounting/investments', () => {
  it('runs the backfill', async () => {
    expect((await post({ action: 'backfill' })).status).toBe(200)
  })
  it('backfills every vehicle for an admin', async () => {
    const res = await post({ action: 'backfill', all: true, dryRun: true })
    expect(res.status).toBe(200)
    expect(backfillAllVehicles).toHaveBeenCalledWith(expect.anything(), 'f', 'u', null, { dryRun: true })
    expect((await res.json()).vehicles).toEqual([{ vehicle: 'Fund I', result: { toDerive: 0 } }])
  })
  it('refuses the all-vehicles backfill to a member', async () => {
    vi.mocked(helpers.assertWriteAccess).mockResolvedValueOnce({ fundId: 'f', userId: 'u', role: 'member' } as any)
    expect((await post({ action: 'backfill', all: true })).status).toBe(403)
  })
  it('refuses every retired action, and no action at all, instead of bootstrapping', async () => {
    for (const action of ['preview', 'bootstrap', 'previewHistory', 'replayHistory', 'mark', 'fx', undefined]) {
      expect((await post({ action })).status).toBe(400)
    }
  })
})
