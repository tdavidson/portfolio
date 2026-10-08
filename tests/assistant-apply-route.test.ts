import { describe, expect, it, vi } from 'vitest'
import { NextRequest } from 'next/server'

// The apply route's error path forwards what an edit deleted before it failed.
const h = vi.hoisted(() => ({ apply: vi.fn() }))
vi.mock('@/lib/supabase/server', () => ({ createClient: async () => ({ auth: { getUser: async () => ({ data: { user: { id: 'u' } } }) } }) }))
vi.mock('@/lib/supabase/admin', () => ({ createAdminClient: () => ({}) }))
vi.mock('@/lib/api-helpers', async (orig) => ({ ...(await orig<any>()), assertWriteAccess: async () => ({ fundId: 'f', userId: 'u', role: 'admin' }) }))
vi.mock('@/lib/accounting/http-vehicle', () => ({ resolveGroupOr400: async () => 'Fund I' }))
vi.mock('@/lib/accounting/assistant', () => ({ applyProposal: h.apply }))
import { POST } from '@/app/api/accounting/assistant/route'

const post = () => POST(new NextRequest('http://localhost/api/accounting/assistant', { method: 'POST', body: JSON.stringify({ action: 'apply', proposal: { entryId: 'e1' } }) }))

describe('POST /api/accounting/assistant apply', () => {
  it('forwards the removed transactions and unlinked register rows on error', async () => {
    h.apply.mockResolvedValueOnce({ error: 'insert failed', removedTransactions: [{ id: 't1' }], unlinkedRegisterRows: ['the call of 2026-03-01'] })
    const res = await post()
    expect(res.status).toBe(400)
    expect(await res.json()).toEqual({ error: 'insert failed', removedTransactions: [{ id: 't1' }], unlinkedRegisterRows: ['the call of 2026-03-01'] })
  })
  it('a plain error stays plain', async () => {
    h.apply.mockResolvedValueOnce({ error: 'no' })
    expect(await (await post()).json()).toEqual({ error: 'no' })
  })
})
