import { beforeEach, expect, it, vi } from 'vitest'
import { NextRequest } from 'next/server'
const mocks = vi.hoisted(() => ({
  capital: vi.fn(), advances: vi.fn(), irr: vi.fn(),
}))
vi.mock('@/lib/supabase/server', () => ({ createClient: async () => ({ auth: { getUser: async () => ({ data: { user: { id: 'synthetic-user' } } }) } }) }))
vi.mock('@/lib/supabase/admin', () => ({ createAdminClient: () => ({}) }))
vi.mock('@/lib/api-helpers', () => ({ assertReadAccess: async () => ({ fundId: 'synthetic-fund' }) }))
vi.mock('@/lib/accounting/http-vehicle', () => ({ resolveGroupOr400: async () => 'Synthetic vehicle' }))
vi.mock('@/lib/accounting/load', () => ({ loadEntityNames: async () => new Map(), loadEntityClasses: async () => new Map() }))
vi.mock('@/lib/accounting/capital-source', () => ({ loadCapitalPostings: mocks.capital }))
vi.mock('@/lib/accounting/call-extras', () => ({ advanceBalances: mocks.advances }))
vi.mock('@/lib/accounting/reporting-irr', () => ({ reportingIrr: mocks.irr }))
vi.mock('@/lib/accounting/capital-calls', () => ({ lpCapitalSummary: async () => [], listCapitalCalls: async () => [] }))
vi.mock('@/lib/accounting/pooled-capital-check', () => ({ loadStrandedCapital: async () => ({ stranded: false }) }))
import { GET } from './route'

beforeEach(() => { vi.clearAllMocks(); mocks.advances.mockResolvedValue(new Map([['lp-a', 25]])); mocks.irr.mockReturnValue(null) })

it('starts advances before the capital history resolves and preserves each partner’s balances and IRR inputs', async () => {
  const postings = [
    { lpEntityId: 'lp-a', amount: -100, sourceType: 'capital_contribution', entryDate: '2026-01-01' },
    { lpEntityId: 'lp-b', amount: -300, sourceType: 'capital_contribution', entryDate: '2026-01-01' },
    { lpEntityId: 'lp-a', amount: -50, sourceType: 'capital_contribution', entryDate: '2026-02-01' },
  ]
  let finish!: (value: unknown) => void
  mocks.capital.mockReturnValue(new Promise(resolve => { finish = resolve }))
  const response = GET(new NextRequest('https://synthetic.invalid/api/accounting/capital-accounts?preset=itd'))
  await vi.waitFor(() => expect(mocks.advances).toHaveBeenCalledWith({}, 'synthetic-fund', 'Synthetic vehicle'))
  finish({ source: 'ledger', postings, evidenceByLp: new Map([['lp-a', { values: { nav: 150 } }], ['lp-b', { values: { nav: 300 } }]]) })
  const body = await (await response).json()
  expect(body.rows.map((r: { lpEntityId: string; itd: { ending: number }; advance: number }) => [r.lpEntityId, r.itd.ending, r.advance])).toEqual([['lp-a', 150, 25], ['lp-b', 300, 0]])
  expect(mocks.irr.mock.calls.map(call => call[0])).toEqual([[postings[0], postings[2]], [postings[1]]])
})
