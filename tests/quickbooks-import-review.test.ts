import { beforeEach, describe, expect, it, vi } from 'vitest'
import { NextRequest } from 'next/server'

const { from, ensureInvestmentAccounts } = vi.hoisted(() => ({ from: vi.fn(), ensureInvestmentAccounts: vi.fn() }))
vi.mock('@/lib/supabase/server', () => ({ createClient: async () => ({ auth: { getUser: async () => ({ data: { user: { id: 'user' } } }) } }) }))
vi.mock('@/lib/supabase/admin', () => ({ createAdminClient: () => ({ from }) }))
vi.mock('@/lib/api-helpers', () => ({ assertReadAccess: async () => ({ fundId: 'tenant' }), assertWriteAccess: async () => ({ fundId: 'tenant' }) }))
vi.mock('@/lib/accounting/http-vehicle', () => ({ resolveGroupOr400: async (_a: unknown, _g: unknown, name: string) => name }))
vi.mock('@/lib/accounting/vehicle-id', () => ({ vehicleIdByName: async (_a: unknown, _f: string, group: string) => group === 'Fund II' ? 'vehicle-2' : 'vehicle-1' }))
vi.mock('@/lib/accounting/investments', () => ({ ensureInvestmentAccounts, investmentCostCode: (id: string) => `1100-${id.slice(0, 8)}` }))

import { POST as parse } from '@/app/api/accounting/quickbooks/parse/route'
import { PUT as save } from '@/app/api/accounting/quickbooks/mapping/route'
import { POST as discover } from '@/app/api/accounting/quickbooks/mapping/discover/route'
import { POST as createAccount } from '@/app/api/accounting/chart/route'
import { getTool } from '@/lib/accounting/agent-tools'

let tables: Record<string, any[]>
let writes: { table: string; row: any }[]
beforeEach(() => {
  writes = []
  tables = {
    chart_of_accounts: [
      { id: 'cash', fund_id: 'tenant', vehicle_id: 'vehicle-2', code: '1000', name: 'Cash', type: 'asset', subtype: 'cash', is_active: true },
      { id: 'other-lp', fund_id: 'tenant', vehicle_id: 'vehicle-1', code: '3100-other', name: "Partners' capital — Fund I LP", type: 'equity', subtype: 'lp_capital', lp_entity_id: 'lp1', is_active: true },
    ],
    fund_vehicles: [{ id: 'vehicle-2', fund_id: 'tenant', name: 'Fund II', kind: 'fund' }],
    qb_account_mappings: [], companies: [], fund_holding_terms: [],
  }
  ensureInvestmentAccounts.mockReset().mockImplementation(async (_a, _f, _g, holdings) => new Map(holdings.map((h: any) => [h.id, { costId: 'cost' }])))
  from.mockImplementation((table: string) => {
    const filters: Record<string, unknown> = {}
    let mutation: any = null
    const result = () => {
      if (mutation) {
        const rows = (Array.isArray(mutation) ? mutation : [mutation]).map(row => ({ id: row.id ?? 'new-id', ...row }))
        rows.forEach(row => writes.push({ table, row }))
        return { data: rows, error: null }
      }
      return { data: (tables[table] ?? []).filter(row => Object.entries(filters).every(([k, v]) => row[k] === v)), error: null }
    }
    const q: any = {
      select: () => q, eq: (k: string, v: unknown) => { filters[k] = v; return q },
      insert: (rows: any) => { mutation = rows; return q },
      upsert: (rows: any) => { mutation = rows; return q },
      update: (row: any) => { mutation = row; return q },
      maybeSingle: async () => { const r = result(); return { ...r, data: r.data[0] ?? null } },
      single: async () => { const r = result(); return { ...r, data: r.data[0] ?? null } },
      then: (resolve: any) => Promise.resolve(result()).then(resolve),
    }
    return q
  })
})

const req = (body: object, method = 'POST') => new NextRequest('http://localhost/api/test', { method, body: JSON.stringify({ group: 'Fund II', ...body }) })

describe('QuickBooks import review routes', () => {
  it('does not propose another vehicle’s partner account', async () => {
    const res = await parse(req({ text: 'Date,Transaction Type,Num,Account,Debit,Credit\n01/01/2026,Journal Entry,1,Cash,100,\n,,,Partners capital,,100' }))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.accounts.find((a: any) => a.qbAccount === 'Partners capital').code).not.toBe('3100-other')
    expect(writes).toEqual([])
    expect(body.accounts.find((a: any) => a.qbAccount === 'Cash').lineCount).toBe(1)
  })

  it('rejects a manually supplied account code from another vehicle', async () => {
    const res = await save(req({ rows: [{ qbAccount: 'Partners capital', accountCode: '3100-other' }] }, 'PUT'))
    expect(res.status).toBe(400)
    expect(writes).toEqual([])
  })

  it('saves valid mappings and explicit exclusions for the requested vehicle', async () => {
    const res = await save(req({ rows: [{ qbAccount: 'Bank', accountCode: '1000' }, { qbAccount: 'Unused', accountCode: null, excluded: true }] }, 'PUT'))
    expect(res.status).toBe(200)
    expect(writes).toHaveLength(2)
    expect(writes.every(w => w.row.vehicle_id === 'vehicle-2')).toBe(true)
  })

  it('creates a missing chart account on the selected vehicle', async () => {
    const res = await createAccount(req({ action: 'add', code: '1700', name: 'Accumulated Amortization', type: 'asset' }))
    expect(res.status).toBe(200)
    expect(writes[0]).toMatchObject({ table: 'chart_of_accounts', row: { code: '1700', vehicle_id: 'vehicle-2', portfolio_group: 'Fund II', type: 'asset' } })
  })

  it('requires a holding type before writing anything', async () => {
    expect((await discover(req({ holdings: ['Exchange Co'] }))).status).toBe(400)
    expect(writes).toEqual([])
  })

  it('honors Exchange Co as a fund and a different holding as a company', async () => {
    const res = await discover(req({ holdings: ['Exchange Co', 'Direct Co'], holdingTypes: { 'Exchange Co': 'fund', 'Direct Co': 'company' } }))
    expect(res.status).toBe(200)
    expect(writes.filter(w => w.table === 'companies').map(w => [w.row.name, w.row.holding_type])).toEqual([['Exchange Co', 'fund'], ['Direct Co', 'company']])
    expect(writes.filter(w => w.table === 'fund_holding_terms')).toHaveLength(1)
    expect(ensureInvestmentAccounts).toHaveBeenCalledWith(expect.anything(), 'tenant', 'Fund II', expect.arrayContaining([expect.objectContaining({ name: 'Exchange Co' })]))
    expect((await res.json()).mappings).toHaveLength(2)
  })

  it('reuses an existing holding without changing its type and repairs its accounts', async () => {
    tables.companies = [{ id: 'exchange', name: 'Exchange Co', holding_type: 'fund', fund_id: 'tenant', portfolio_group: ['Fund II'] }]
    const res = await discover(req({ holdings: ['Exchange Co'], holdingTypes: { 'Exchange Co': 'company' } }))
    expect(writes).toEqual([])
    expect((await res.json()).mappings).toEqual([{ name: 'Exchange Co', code: '1100-exchange' }])
  })

  it('keeps each journal source on its own mapping', async () => {
    const res = await save(req({ rows: [{ qbAccount: 'Bank', accountCode: '1000' }] }, 'PUT'))
    expect(res.status).toBe(200)
    expect(writes[0].row.source).toBe('quickbooks')

    const tool = getTool('save_journal_mapping')!
    const ctx = { admin: { from } as any, fundId: 'tenant', portfolioGroup: 'Fund II', userId: 'user', access: {} as any }
    await tool.handler(ctx, { source: 'carta', rows: [{ qbAccount: '1108 Cash - Operating', accountCode: '1000' }] })
    expect(writes[1].row).toMatchObject({ source: 'carta', qb_account: '1108 Cash - Operating', vehicle_id: 'vehicle-2' })
    await expect(tool.handler(ctx, { source: 'xero', rows: [] })).rejects.toThrow(/Unknown journal source/)
  })

  it('proposes accounts for structured transactions a connector sends, without writing', async () => {
    tables.qb_account_mappings = [{ fund_id: 'tenant', vehicle_id: 'vehicle-2', source: 'quickbooks', qb_account: 'Operating cash', account_code: '1000', excluded: false }]
    const tool = getTool('journal_import_accounts')!
    const ctx = { admin: { from } as any, fundId: 'tenant', portfolioGroup: 'Fund II', userId: 'user', access: {} as any }
    const transactions = [{ date: '2026-01-15', num: 'GL-1', lines: [{ account: 'Operating cash', debit: 100 }, { account: 'Contributed capital - LP', name: 'Example LP', credit: 100 }] }]

    const carta: any = await tool.handler(ctx, { source: 'carta', transactions })
    expect(carta.source).toBe('carta')
    // The QuickBooks mapping for the same name is not Carta's.
    expect(carta.accounts.find((a: any) => a.qbAccount === 'Operating cash').reason).not.toBe('Confirmed previously.')

    const qb: any = await tool.handler(ctx, { transactions })
    expect(qb.accounts.find((a: any) => a.qbAccount === 'Operating cash')).toMatchObject({ code: '1000', reason: 'Confirmed previously.' })
    expect(writes).toEqual([])
  })
})
