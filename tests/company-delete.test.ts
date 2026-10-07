import { beforeEach, describe, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import path from 'node:path'

const mocks = vi.hoisted(() => ({
  getUser: vi.fn(),
  assertWriteAccess: vi.fn(),
  logActivity: vi.fn(),
  removeStorage: vi.fn(),
  investmentCount: 0,
  postingCount: 0,
  company: {
    id: 'company-1',
    name: 'Acme',
    fund_id: 'fund-1',
    holding_type: 'company',
  } as { id: string; name: string; fund_id: string; holding_type: string } | null,
  operations: [] as Array<{ table: string; operation: string }>,
  /** The caller's entities, and the entities linked to the company. */
  vehicles: { all: true, ids: [] as string[] },
  links: [] as { vehicle_id: string }[],
}))

function query(table: string) {
  let operation = 'select'

  const result = () => {
    mocks.operations.push({ table, operation })
    if (table === 'companies' && operation === 'select') return { data: mocks.company, error: null }
    if (table === 'investment_transactions') return { data: null, count: mocks.investmentCount, error: null }
    if (table === 'chart_of_accounts' && operation === 'select') return { data: [{ id: 'account-1' }], error: null }
    if (table === 'journal_postings') return { data: null, count: mocks.postingCount, error: null }
    if (table === 'company_vehicles') return { data: mocks.links, error: null }
    if (table === 'company_documents') {
      return { data: [{ storage_path: 'fund-1/company-1/deck.pdf' }], error: null }
    }
    return { data: null, error: null }
  }

  const chain: any = {
    select: () => chain,
    eq: () => chain,
    in: () => chain,
    delete: () => { operation = 'delete'; return chain },
    maybeSingle: async () => result(),
    then: (resolve: (value: unknown) => unknown, reject: (reason: unknown) => unknown) =>
      Promise.resolve(result()).then(resolve, reject),
  }
  return chain
}

const admin = {
  from: vi.fn((table: string) => query(table)),
  storage: { from: vi.fn(() => ({ remove: mocks.removeStorage })) },
}

vi.mock('@/lib/supabase/server', () => ({
  createClient: async () => ({ auth: { getUser: mocks.getUser } }),
}))
vi.mock('@/lib/supabase/admin', () => ({ createAdminClient: () => admin }))
vi.mock('@/lib/api-helpers', () => ({ assertWriteAccess: mocks.assertWriteAccess }))
vi.mock('@/lib/activity', () => ({ logActivity: mocks.logActivity }))
vi.mock('@/lib/access/entity-scope', () => ({
  loadEntityScope: async () => ({ access: { vehicles: mocks.vehicles }, vehicleNames: null, companyIds: null }),
  loadEntityScopeForUser: async () => ({ access: { vehicles: mocks.vehicles }, vehicleNames: null, companyIds: null }),
}))

import { DELETE } from '@/app/api/companies/[id]/route'

const request = {} as any
const props = { params: Promise.resolve({ id: 'company-1' }) }

beforeEach(() => {
  vi.clearAllMocks()
  mocks.company = { id: 'company-1', name: 'Acme', fund_id: 'fund-1', holding_type: 'company' }
  mocks.investmentCount = 0
  mocks.postingCount = 0
  mocks.operations.length = 0
  mocks.vehicles = { all: true, ids: [] }
  mocks.links = []
  mocks.getUser.mockResolvedValue({ data: { user: { id: 'user-1' } } })
  mocks.assertWriteAccess.mockResolvedValue({ fundId: 'fund-1', role: 'member', userId: 'user-1', need: 'write' })
  mocks.removeStorage.mockResolvedValue({ error: null })
})

describe('DELETE /api/companies/[id]', () => {
  it('refuses a member deleting a company another entity they cannot see also holds', async () => {
    mocks.vehicles = { all: false, ids: ['v1'] }
    mocks.links = [{ vehicle_id: 'v1' }, { vehicle_id: 'v2' }]
    const res = await DELETE(request, props)
    expect(res.status).toBe(403)
    expect(mocks.operations.some(o => o.operation === 'delete')).toBe(false)
  })

  it('lets a member delete a company only their entities hold', async () => {
    mocks.vehicles = { all: false, ids: ['v1'] }
    mocks.links = [{ vehicle_id: 'v1' }]
    const res = await DELETE(request, props)
    expect(res.status).toBe(200)
  })

  it('permanently deletes a company, its empty chart accounts, and uploaded objects', async () => {
    const response = await DELETE(request, props)

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ ok: true })
    expect(mocks.operations).toContainEqual({ table: 'companies', operation: 'delete' })
    expect(mocks.operations).toContainEqual({ table: 'chart_of_accounts', operation: 'delete' })
    expect(mocks.removeStorage).toHaveBeenCalledWith(['fund-1/company-1/deck.pdf'])
    expect(mocks.logActivity).toHaveBeenCalledWith(
      admin,
      'fund-1',
      'user-1',
      'company.delete',
      { companyId: 'company-1', companyName: 'Acme' },
    )
  })

  it('refuses to bypass investment ledger cleanup', async () => {
    mocks.investmentCount = 2

    const response = await DELETE(request, props)

    expect(response.status).toBe(409)
    expect(await response.json()).toEqual({
      error: "Delete this company's 2 investment transactions first so its accounting entries can be retracted safely.",
    })
    expect(mocks.operations).not.toContainEqual({ table: 'companies', operation: 'delete' })
  })

  it('refuses to orphan company-specific ledger postings', async () => {
    mocks.postingCount = 1

    const response = await DELETE(request, props)

    expect(response.status).toBe(409)
    expect(await response.json()).toEqual({
      error: "This company's accounts still carry 1 ledger posting. Reverse those entries before deleting the company.",
    })
    expect(mocks.operations).not.toContainEqual({ table: 'companies', operation: 'delete' })
  })

  it('returns not found when the company is outside the caller-scoped lookup', async () => {
    mocks.company = null

    const response = await DELETE(request, props)

    expect(response.status).toBe(404)
    expect(await response.json()).toEqual({ error: 'Company not found' })
  })
})

describe('company deletion foreign keys', () => {
  it('retains historical links by setting their company references to null', () => {
    const migration = readFileSync(
      path.join(process.cwd(), 'supabase/migrations/20260905105012_company_delete_set_null.sql'),
      'utf8',
    )

    expect(migration).toMatch(/inbound_emails_company_id_fkey[\s\S]*on delete set null/i)
    expect(migration).toMatch(/parsing_reviews_company_id_fkey[\s\S]*on delete set null/i)
    expect(migration).toMatch(/diligence_deals_promoted_company_id_fkey[\s\S]*on delete set null/i)
  })
})
