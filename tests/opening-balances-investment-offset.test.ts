import { beforeEach, describe, expect, it, vi } from 'vitest'
import { NextRequest } from 'next/server'

const { from, persistEntry } = vi.hoisted(() => ({ from: vi.fn(), persistEntry: vi.fn() }))
vi.mock('@/lib/accounting/persist', () => ({
  accountIdByCode: async () => new Map([['1000', 'cash'], ['1100', 'inv']]),
  ensureCapitalAccounts: async () => new Map([['lp1', 'cap1']]),
  persistEntry,
}))
vi.mock('@/lib/accounting/vehicle-id', () => ({ vehicleIdByName: async () => 'vehicle-1' }))
vi.mock('@/lib/accounting/provision-accounts', () => ({ ensureVehicleAccounts: vi.fn().mockResolvedValue(undefined) }))
vi.mock('@/lib/supabase/server', () => ({ createClient: async () => ({ auth: { getUser: async () => ({ data: { user: { id: 'user' } } }) } }) }))
vi.mock('@/lib/supabase/admin', () => ({ createAdminClient: () => ({ from, rpc: async () => ({ data: null, error: { message: 'stop' } }) }) }))
vi.mock('@/lib/api-helpers', () => ({ assertWriteAccess: async () => ({ fundId: 'tenant' }) }))
vi.mock('@/lib/accounting/http-vehicle', () => ({ resolveGroupOr400: async () => 'Fund I' }))

import { POST } from '@/app/api/accounting/opening-balances/route'

let offsetAccount: any
beforeEach(() => {
  persistEntry.mockReset().mockResolvedValue({ entryId: 'e1' })
  from.mockImplementation((table: string) => {
    const q: any = {
      select: () => q, eq: () => q, in: () => q,
      limit: async () => ({ data: [], error: null }),
      maybeSingle: async () => ({ data: table === 'chart_of_accounts' ? offsetAccount : null, error: null }),
    }
    return q
  })
})

const call = (offsetAccountCode: string) => POST(new NextRequest('http://x/api/accounting/opening-balances', {
  method: 'POST',
  body: JSON.stringify({ entryDate: '2026-01-01', offsetAccountCode, balances: [{ lpEntityId: 'lp1', amount: 100 }] }),
}))

describe('opening balances offset', () => {
  it('refuses an investment account as the offset and writes nothing', async () => {
    offsetAccount = { type: 'asset', subtype: 'investment', company_id: 'co' }
    const res = await call('1100')
    expect(res.status).toBe(400)
    expect((await res.json()).error).toMatch(/investment transactions/)
    expect(persistEntry).not.toHaveBeenCalled()
  })

  it('lets a cash offset through to the draft', async () => {
    offsetAccount = { type: 'asset', subtype: 'cash', company_id: null }
    await call('1000')
    expect(persistEntry).toHaveBeenCalledTimes(1)
  })
})
