import { describe, it, expect, vi } from 'vitest'
import { NextRequest } from 'next/server'

vi.mock('@/lib/supabase/server', () => ({ createClient: async () => ({ auth: { getUser: async () => ({ data: { user: { id: 'u' } } }) } }) }))
vi.mock('@/lib/supabase/admin', () => ({ createAdminClient: () => ({}) }))
vi.mock('@/lib/api-helpers', async (orig) => ({ ...(await orig<any>()), assertWriteAccess: async () => ({ fundId: 'f', userId: 'u', role: 'admin' }) }))
vi.mock('@/lib/accounting/http-vehicle', () => ({ resolveGroupOr400: async () => 'Fund I' }))
vi.mock('@/lib/accounting/investment-backfill', () => ({ backfillDerivedEntries: vi.fn(async () => ({ toDerive: 0 })) }))
import { POST } from '@/app/api/accounting/investments/route'

const post = (body: object) => POST(new NextRequest('http://localhost/api/accounting/investments', { method: 'POST', body: JSON.stringify(body) }))

describe('POST /api/accounting/investments', () => {
  it('runs the backfill', async () => {
    expect((await post({ action: 'backfill' })).status).toBe(200)
  })
  it('refuses every retired action, and no action at all, instead of bootstrapping', async () => {
    for (const action of ['preview', 'bootstrap', 'previewHistory', 'replayHistory', 'mark', 'fx', undefined]) {
      expect((await post({ action })).status).toBe(400)
    }
  })
})
