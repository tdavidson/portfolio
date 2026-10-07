import { describe, it, expect } from 'vitest'
import { previewRecordInvestment } from '@/lib/pending-actions/investment'

/** Minimal admin stub: resolveCompany's by-id lookup (maybeSingle) returns the company; the conversion lookup a SAFE. */
function makeAdminStub(company: { id: string; name: string }) {
  const query = (table?: string) => {
    // The conversion source, for a preview that links one: an investment on the same company.
    const result = { data: table === 'investment_transactions' ? { id: 'src', transaction_type: 'investment', portfolio_group: 'Fund IV' } : company, error: null }
    const handler: ProxyHandler<any> = {
      get(_t, prop) {
        if (prop === 'then') return (res: any) => Promise.resolve(result).then(res)
        if (prop === 'maybeSingle' || prop === 'single') return async () => result
        return () => proxy
      },
    }
    const proxy: any = new Proxy({}, handler)
    return proxy
  }
  return { from: query } as any
}

const deps = (admin: any) => ({ admin, fundId: 'f1', userId: 'u1', access: { fundId: 'f1', vehicles: { all: true, ids: [] } } as any })

describe('investment action preview', () => {
  it('summarizes company, type, and amount without writing', async () => {
    const admin = makeAdminStub({ id: 'comp1', name: 'Apogee' })
    const p = await previewRecordInvestment(deps(admin), {
      company: 'comp1',
      transaction_type: 'investment',
      transaction_date: '2026-07-01',
      vehicle: 'Fund IV',
      investment_cost: 3_750_000,
    })
    expect(p.summary).toContain('Apogee')
    expect(p.summary).toContain('investment')
    expect(p.details.company).toBe('Apogee')
    expect(p.details.transaction_type).toBe('investment')
    expect(p.details.amount).toBe(3_750_000)
    expect(p.details.convertsFrom).toBeUndefined()
  })

  it('flags a conversion when converts_from_txn_id is present', async () => {
    const admin = makeAdminStub({ id: 'comp1', name: 'Apogee' })
    const p = await previewRecordInvestment(deps(admin), {
      company: 'comp1',
      transaction_type: 'investment',
      transaction_date: '2026-07-01',
      vehicle: 'Fund IV',
      investment_cost: 1_000_000,
      converts_from_txn_id: 'txn-safe-1',
    })
    expect(p.details.convertsFrom).toBe('txn-safe-1')
  })
})
