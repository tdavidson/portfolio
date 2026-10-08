import { describe, it, expect, vi } from 'vitest'
import { NextRequest } from 'next/server'
import { memoryAdmin } from '@/tests/helpers/memory-admin'

const s = vi.hoisted(() => ({ m: null as any }))
vi.mock('@/lib/supabase/server', () => ({ createClient: async () => ({ auth: { getUser: async () => ({ data: { user: { id: 'u' } } }) } }) }))
vi.mock('@/lib/supabase/admin', () => ({ createAdminClient: () => s.m.admin }))
vi.mock('@/lib/api-helpers', async (orig) => ({ ...(await orig<any>()), assertReadAccess: async () => ({ fundId: 'f', userId: 'u', role: 'member', need: 'read' }) }))
vi.mock('@/lib/accounting/http-vehicle', () => ({ resolveGroupOr400: async (_a: any, _g: any, g: string | null) => g ?? 'Fund I' }))
import { GET } from '@/app/api/accounting/crypto-wallets/route'

const inv = (id: string, company_id: string, portfolio_group: string) =>
  ({ id, fund_id: 'f', company_id, transaction_type: 'investment', portfolio_group, transaction_date: '2026-01-01', investment_cost: 100, shares_acquired: 1, round_name: null })

const companies = [
  { id: 'k1', fund_id: 'f', name: 'Ether', holding_type: 'crypto', status: 'active' },
  { id: 'k2', fund_id: 'f', name: 'Bitcoin', holding_type: 'crypto', status: 'active' },
]
const ids = async (group: string) => {
  const res = await GET(new NextRequest(`http://x/api/accounting/crypto-wallets?group=${encodeURIComponent(group)}&asOf=2026-03-31`))
  expect(res.status).toBe(200)
  return (await res.json()).wallets.map((w: any) => w.id)
}

describe('GET /api/accounting/crypto-wallets', () => {
  it('lists only the wallets of the entity it was asked about', async () => {
    s.m = memoryAdmin({
      crypto_wallets: [
        { id: 'w1', fund_id: 'f', company_id: 'k1', chain: 'ethereum', address: '0x1', portfolio_group: 'Fund I', active: true },
        { id: 'w2', fund_id: 'f', company_id: 'k1', chain: 'ethereum', address: '0x2', portfolio_group: 'Fund II', active: true },
        { id: 'w3', fund_id: 'f', company_id: 'k2', chain: 'bitcoin', address: 'bc1', portfolio_group: null, active: true },
      ],
      crypto_wallet_balances: [],
      investment_transactions: [inv('t1', 'k1', 'Fund I'), inv('t2', 'k1', 'Fund II'), inv('t3', 'k2', 'Fund II')],
      companies,
    })
    expect(await ids('Fund I')).toEqual(['w1'])
  })

  it('does not attribute an untagged wallet on a shared holding to a scoped entity (C-R15)', async () => {
    s.m = memoryAdmin({
      crypto_wallets: [{ id: 'w1', fund_id: 'f', company_id: 'k1', chain: 'ethereum', address: '0x1', portfolio_group: null, active: true }],
      crypto_wallet_balances: [],
      investment_transactions: [inv('t1', 'k1', 'Fund I'), inv('t2', 'k1', 'Fund II')],
      companies,
    })
    expect(await ids('Fund I')).toEqual([])
    expect(await ids('Fund II')).toEqual([])
  })

  it('still shows an untagged wallet to the sole holder', async () => {
    s.m = memoryAdmin({
      crypto_wallets: [{ id: 'w1', fund_id: 'f', company_id: 'k1', chain: 'ethereum', address: '0x1', portfolio_group: null, active: true }],
      crypto_wallet_balances: [],
      investment_transactions: [inv('t1', 'k1', 'Fund I')],
      companies,
    })
    expect(await ids('Fund I')).toEqual(['w1'])
  })
})
