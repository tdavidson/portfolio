import { describe, it, expect } from 'vitest'
import { companyDeleteDenial } from './company-delete'

function admin(t: { links?: any[]; company?: any; txns?: any[] }) {
  return {
    from: (table: string) => {
      const chain: any = {
        select: () => chain, eq: () => chain,
        maybeSingle: async () => ({ data: table === 'companies' ? t.company ?? null : null, error: null }),
        then: (res: any) => res({ data: table === 'company_vehicles' ? t.links ?? [] : table === 'investment_transactions' ? t.txns ?? [] : [], error: null }),
      }
      return chain
    },
  } as any
}
const member = { access: { fundId: 'f1', vehicles: { all: false, ids: ['v1'] } }, vehicleNames: ['Fund I'], companyIds: ['c1'] } as any
const everyone = { access: { fundId: 'f1', vehicles: { all: true, ids: [] } }, vehicleNames: null, companyIds: null } as any

describe('companyDeleteDenial — a member deletes only what is wholly theirs', () => {
  it('allows a company held only by their entities', async () => {
    expect(await companyDeleteDenial(admin({ links: [{ vehicle_id: 'v1' }], company: { portfolio_group: ['Fund I'] }, txns: [{ portfolio_group: 'Fund I' }, { portfolio_group: null }] }), member, 'c1')).toBeNull()
  })
  it('refuses when another entity is linked', async () => {
    expect(await companyDeleteDenial(admin({ links: [{ vehicle_id: 'v1' }, { vehicle_id: 'v2' }] }), member, 'c1')).toMatch(/Only an admin/)
  })
  it('refuses when a legacy tag names a group that is not theirs, though no entity links it', async () => {
    expect(await companyDeleteDenial(admin({ links: [{ vehicle_id: 'v1' }], company: { portfolio_group: ['Fund I', 'Old SPV'] } }), member, 'c1')).toMatch(/Only an admin/)
  })
  it('refuses when a transaction belongs to a group that is not theirs', async () => {
    expect(await companyDeleteDenial(admin({ links: [{ vehicle_id: 'v1' }], company: { portfolio_group: ['Fund I'] }, txns: [{ portfolio_group: 'Old SPV' }] }), member, 'c1')).toMatch(/Only an admin/)
  })
  it('never refuses an unscoped caller', async () => {
    expect(await companyDeleteDenial(admin({ links: [{ vehicle_id: 'v2' }] }), everyone, 'c1')).toBeNull()
  })
})
