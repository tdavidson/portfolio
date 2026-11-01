import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { AccessContext, AccessLevel } from '@/lib/access/effective'
import type { Domain } from '@/lib/access/domains'
import { DEFAULT_FEATURE_VISIBILITY, type FeatureVisibilityMap } from '@/lib/types/features'
import { memoryAdmin } from './helpers/memory-admin'

/**
 * The query tools: questions no named tool answers, over rows the named tools already load. A
 * dataset is gated by its source tool's access and scoped by its source tool's loader.
 */

vi.mock('@/lib/access/entity-scope', () => ({
  entityScopeFor: async (_: unknown, a: AccessContext) =>
    a.vehicles.all ? { access: a, vehicleNames: null, writableNames: null, companyIds: null } : { access: a, vehicleNames: ['Fund I'], writableNames: ['Fund I'], companyIds: ['c1'] },
}))
vi.mock('@/lib/access/scope', async importOriginal => ({
  ...(await importOriginal<typeof import('@/lib/access/scope')>()),
  visibleCompanyIds: async (_: unknown, a: AccessContext) => (a.vehicles.all ? null : ['c1']),
}))
vi.mock('@/lib/access/carry-visibility', async importOriginal => ({
  ...(await importOriginal<typeof import('@/lib/access/carry-visibility')>()),
  carryRecipientIds: async () => new Set(['ent-gp']),
}))

import { QUERY_HANDLERS as H } from '@/lib/agent/query-tools'
import { getTool } from '@/lib/accounting/agent-tools'

const member = (grants: Partial<Record<Domain, AccessLevel>>, all = true, features: Partial<FeatureVisibilityMap> = {}): AccessContext => ({
  fundId: 'f1', userId: 'u1', vehicles: { all, ids: all ? [] : ['v1'] }, role: 'member',
  features: { ...Object.fromEntries(Object.keys(DEFAULT_FEATURE_VISIBILITY).map(k => [k, 'everyone'])), ...features } as FeatureVisibilityMap,
  grants, defaults: {},
})
let store: ReturnType<typeof memoryAdmin>
const ctx = (access: AccessContext, portfolioGroup = '') => ({ admin: store.admin, fundId: 'f1', portfolioGroup, userId: 'u1', access }) as any

beforeEach(() => {
  store = memoryAdmin({
    fund_vehicles: [{ id: 'v1', fund_id: 'f1', name: 'Fund I', active: true, kind: 'fund', aliases: null }],
    companies: [
      { id: 'c1', fund_id: 'f1', name: 'Acme', holding_type: 'company', status: 'active', stage: 'Seed', industry: ['Fintech'], portfolio_group: ['Fund I'] },
      { id: 'c2', fund_id: 'f1', name: 'Birch', holding_type: 'company', status: 'active', stage: 'Series A', industry: ['Health'], portfolio_group: ['Fund II'] },
    ],
    metrics: [{ id: 'm1', company_id: 'c1', name: 'ARR', unit: 'USD' }, { id: 'm2', company_id: 'c2', name: 'ARR', unit: 'USD' }],
    metric_values: [
      { metric_id: 'm1', period_label: 'Q1 2026', period_year: 2026, period_quarter: 1, value_number: 100 },
      { metric_id: 'm1', period_label: 'Q2 2026', period_year: 2026, period_quarter: 2, value_number: 150 },
      { metric_id: 'm2', period_label: 'Q2 2026', period_year: 2026, period_quarter: 2, value_number: 900 },
    ],
    investment_transactions: [{ id: 't1', fund_id: 'f1', company_id: 'c1', portfolio_group: 'Fund I', transaction_type: 'investment', transaction_date: '2025-03-01', investment_cost: 250000 }],
    chart_of_accounts: [
      { id: 'a1', fund_id: 'f1', vehicle_id: 'v1', code: '6100', name: 'Legal fees', type: 'expense' },
      { id: 'a2', fund_id: 'f1', vehicle_id: 'v1', code: '1000', name: 'Cash', type: 'asset' },
      { id: 'a3', fund_id: 'f1', vehicle_id: 'v1', code: '3000', name: 'Partners capital', type: 'equity' },
    ],
    journal_entries: [
      { id: 'e1', fund_id: 'f1', vehicle_id: 'v1', book: 'actual', status: 'posted', entry_date: '2026-02-01', memo: 'Counsel', source_type: 'manual' },
      { id: 'e2', fund_id: 'f1', vehicle_id: 'v1', book: 'actual', status: 'posted', entry_date: '2026-05-01', memo: 'Counsel', source_type: 'manual' },
      { id: 'e3', fund_id: 'f1', vehicle_id: 'v1', book: 'actual', status: 'draft', entry_date: '2026-05-02', memo: 'Draft', source_type: 'manual' },
      { id: 'e4', fund_id: 'f1', vehicle_id: 'v1', book: 'actual', status: 'posted', entry_date: '2026-06-30', memo: 'Carry', source_type: 'allocation' },
    ],
    journal_postings: [
      { fund_id: 'f1', vehicle_id: 'v1', book: 'actual', journal_entry_id: 'e1', account_id: 'a1', amount: 1000 },
      { fund_id: 'f1', vehicle_id: 'v1', book: 'actual', journal_entry_id: 'e1', account_id: 'a2', amount: -1000 },
      { fund_id: 'f1', vehicle_id: 'v1', book: 'actual', journal_entry_id: 'e2', account_id: 'a1', amount: 2500 },
      { fund_id: 'f1', vehicle_id: 'v1', book: 'actual', journal_entry_id: 'e2', account_id: 'a2', amount: -2500 },
      { fund_id: 'f1', vehicle_id: 'v1', book: 'actual', journal_entry_id: 'e3', account_id: 'a1', amount: 99 },
      { fund_id: 'f1', vehicle_id: 'v1', book: 'actual', journal_entry_id: 'e4', account_id: 'a3', amount: -500, lp_entity_id: 'ent-gp' },
    ],
    lp_entities: [{ id: 'ent-gp', fund_id: 'f1', entity_name: 'GP Carry LLC' }],
  })
})

describe('query tools', () => {
  it('are read-only, one per area, each with its area as the gate', () => {
    expect(getTool('query_portfolio')).toMatchObject({ scope: 'read', domain: 'portfolio' })
    expect(getTool('query_lps')).toMatchObject({ scope: 'read', domain: 'lp' })
    expect(getTool('query_deals')).toMatchObject({ scope: 'read', domain: 'deals' })
    expect(getTool('query_diligence')).toMatchObject({ scope: 'read', domain: 'diligence' })
    expect(getTool('query_ledger')).toMatchObject({ scope: 'read', domain: 'ledger' })
  })

  it('aggregates KPIs over only the companies the member can see', async () => {
    const q = { dataset: 'kpis', where: [{ column: 'metric', op: 'eq', value: 'ARR' }, { column: 'period', op: 'eq', value: 'Q2 2026' }], aggregates: [{ fn: 'sum', column: 'value' }] }
    expect(((await H.query_portfolio(ctx(member({ portfolio: 'read' })), q)) as any).rows).toEqual([{ sum_value: 1050 }])
    expect(((await H.query_portfolio(ctx(member({ portfolio: 'read' }, false)), q)) as any).rows).toEqual([{ sum_value: 150 }])
  })

  it('lists companies through the same scope as list_companies', async () => {
    const out = await H.query_portfolio(ctx(member({ portfolio: 'read' }, false)), { dataset: 'companies', columns: ['company'] }) as any
    expect(out.rows).toEqual([{ company: 'Acme' }])
  })

  it("holds a dataset to its source tool's switch", async () => {
    const off = member({ portfolio: 'read' }, true, { investments: 'off' })
    await expect(H.query_portfolio(ctx(off), { dataset: 'transactions' })).rejects.toThrow('transactions dataset needs access')
    const out = await H.query_portfolio(ctx(member({ portfolio: 'read' })), { dataset: 'transactions', columns: ['company', 'invested'] }) as any
    expect(out.rows).toEqual([{ company: 'Acme', invested: 250000 }])
  })

  it('sums posted journal lines by quarter, and folds carry recipients without GP economics', async () => {
    const legal = await H.query_ledger(ctx(member({ accounting: 'read' }), 'Fund I'), {
      where: [{ column: 'account_name', op: 'eq', value: 'Legal fees' }], group_by: ['date:quarter'], aggregates: [{ fn: 'sum', column: 'debit' }], order_by: [{ column: 'date_quarter' }],
    }) as any
    expect(legal.rows).toEqual([{ date_quarter: '2026-Q1', sum_debit: 1000 }, { date_quarter: '2026-Q2', sum_debit: 2500 }])
    const carry = (a: AccessContext) => H.query_ledger(ctx(a, 'Fund I'), { where: [{ column: 'account_type', op: 'eq', value: 'equity' }], columns: ['lp'] })
    expect(((await carry(member({ accounting: 'read' }))) as any).rows).toEqual([{ lp: 'Carried interest recipients' }])
    expect(((await carry(member({ accounting: 'read', gp_economics: 'read' }))) as any).rows).toEqual([{ lp: 'GP Carry LLC' }])
  })

  it('needs a dataset when an area has several, and says which', async () => {
    await expect(H.query_portfolio(ctx(member({ portfolio: 'read' })), {})).rejects.toThrow('Pass a dataset: positions, companies, transactions, kpis')
  })
})
