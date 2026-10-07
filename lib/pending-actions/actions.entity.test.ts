import { describe, it, expect, vi } from 'vitest'

// A member granted Fund I, which holds company c1 only.
vi.mock('@/lib/access/scope', async orig => ({
  ...(await orig<typeof import('@/lib/access/scope')>()),
  visibleCompanyIds: async () => ['c1'],
}))
vi.mock('@/lib/access/entity-scope', () => ({
  entityScopeFor: async (_a: any, access: any) => ({ access, vehicleNames: ['Fund I'], companyIds: ['c1'] }),
}))

import { previewMetricValue } from './metric-value'
import { previewRecordInvestment } from './investment'

const companies: Record<string, any> = { c1: { id: 'c1', name: 'Acme', fund_id: 'f1' }, c2: { id: 'c2', name: 'Beta', fund_id: 'f1' } }
function admin() {
  return {
    from: (t: string) => {
      const eqs: Record<string, any> = {}
      const chain: any = {
        select: () => chain, is: () => chain, ilike: () => chain, limit: () => chain,
        eq: (k: string, v: any) => { eqs[k] = v; return chain },
        maybeSingle: async () => ({
          data: t === 'companies' ? companies[eqs.id] ?? null
            : t === 'metrics' ? { id: eqs.id, name: 'ARR', value_type: 'number', company_id: eqs.company_id, fund_id: 'f1' }
            : null,
          error: null,
        }),
        then: (res: any) => res({ data: [], error: null }),
      }
      return chain
    },
  } as any
}
const deps = { admin: admin(), fundId: 'f1', userId: 'u1', access: { fundId: 'f1', vehicles: { all: false, ids: ['v1'] } } as any }

describe('pending-action previews refuse another entity\'s data', () => {
  it('a metric on a company outside their entities is not found', async () => {
    const input = { metricId: 'm1', period_label: 'Q3', period_year: 2026, value: 1 }
    await expect(previewMetricValue(deps, { ...input, companyId: 'c2' })).rejects.toThrow(/not found/i)
    await expect(previewMetricValue(deps, { ...input, companyId: 'c1' })).resolves.toMatchObject({ details: { metric: 'ARR' } })
  })
  it('an investment into an entity they cannot see is refused at staging, not only at approval', async () => {
    const input = { company: 'c1', transaction_type: 'investment', transaction_date: '2026-07-01', investment_cost: 1 }
    await expect(previewRecordInvestment(deps, { ...input, vehicle: 'Fund II' })).rejects.toThrow(/entit/i)
    await expect(previewRecordInvestment(deps, { ...input, vehicle: 'Fund I' })).resolves.toBeTruthy()
  })
})
