import { describe, it, expect } from 'vitest'
import { memoryAdmin } from '@/tests/helpers/memory-admin'
import { holdingHref, soiRowHref } from './holding-href'
import { holdingEntities, holdersFromTransactions, walletEntity, walletsForEntity, scopeWallets } from './holding-entities'
import { walletFromRow, balanceFromRow } from './wallets'

describe('holdingHref', () => {
  it('links to the holding page, naming the entity when there is one', () => {
    expect(holdingHref('c1')).toBe('/companies/c1')
    expect(holdingHref('c1', null)).toBe('/companies/c1')
    expect(holdingHref('c1', 'v 1')).toBe('/companies/c1?entity=v%201')
  })
})

describe('holdingEntities', () => {
  const seed = () => memoryAdmin({
    company_vehicles: [
      { fund_id: 'f', company_id: 'k1', vehicle_id: 'v2', relation: 'holding' },
      { fund_id: 'f', company_id: 'k1', vehicle_id: 'v1', relation: 'assigned' },
      { fund_id: 'f', company_id: 'other', vehicle_id: 'v3', relation: 'holding' },
    ],
    fund_vehicles: [
      { id: 'v1', fund_id: 'f', name: 'Fund I' },
      { id: 'v2', fund_id: 'f', name: 'Fund II' },
      { id: 'v3', fund_id: 'f', name: 'Fund III' },
    ],
  })

  it('lists every entity linked to the holding for a caller who sees all', async () => {
    expect(await holdingEntities(seed().admin, 'f', 'k1', { vehicles: { all: true, ids: [] } }))
      .toEqual([{ id: 'v1', name: 'Fund I' }, { id: 'v2', name: 'Fund II' }])
  })

  // memoryAdmin cannot fail a select, so the error path uses a stub whose reads fail by table.
  const failing = (table: string) => ({
    from: (name: string) => {
      const q: any = { select: () => q, eq: () => q, in: () => q }
      q.then = (res: any) => res(name === table
        ? { data: null, error: { message: 'boom' } }
        : { data: name === 'company_vehicles' ? [{ vehicle_id: 'v1' }] : [], error: null })
      return q
    },
  }) as any

  it('throws when the company_vehicles read fails, rather than reporting no entities', async () => {
    await expect(holdingEntities(failing('company_vehicles'), 'f', 'k1', { vehicles: { all: true, ids: [] } }))
      .rejects.toThrow('company_vehicles read failed: boom')
  })

  it('throws when the fund_vehicles read fails, rather than returning a partial list', async () => {
    await expect(holdingEntities(failing('fund_vehicles'), 'f', 'k1', { vehicles: { all: true, ids: [] } }))
      .rejects.toThrow('fund_vehicles read failed: boom')
  })

  it("lists only the caller's entities", async () => {
    expect(await holdingEntities(seed().admin, 'f', 'k1', { vehicles: { all: false, ids: ['v2'] } }))
      .toEqual([{ id: 'v2', name: 'Fund II' }])
  })
})

describe('which entity a wallet speaks for', () => {
  const holders = holdersFromTransactions([
    { company_id: 'solo', transaction_type: 'investment', portfolio_group: 'Fund I' },
    { company_id: 'solo', transaction_type: 'unrealized_gain_change', portfolio_group: null },
    { company_id: 'shared', transaction_type: 'investment', portfolio_group: 'Fund II' },
    { company_id: 'shared', transaction_type: 'investment', portfolio_group: 'Fund I' },
  ])
  const w = (id: string, company_id: string, portfolio_group: string | null) => ({ id, company_id, portfolio_group })

  it('reads the holders of each holding from its investment rows', () => {
    expect(holders.get('solo')).toEqual(['Fund I'])
    expect(holders.get('shared')).toEqual(['Fund I', 'Fund II'])
  })

  it("takes a wallet's own entity when it has one", () => {
    expect(walletEntity(w('a', 'shared', 'Fund II'), holders)).toBe('Fund II')
  })

  it("gives a wallet watched before wallets had an entity to the holding's only holder", () => {
    expect(walletEntity(w('b', 'solo', null), holders)).toBe('Fund I')
    expect(walletsForEntity([w('b', 'solo', null)], 'Fund I', holders)).toHaveLength(1)
  })

  it('gives an untagged wallet on a shared holding to nobody, so it is never counted twice', () => {
    expect(walletEntity(w('c', 'shared', null), holders)).toBeNull()
    expect(walletsForEntity([w('c', 'shared', null)], 'Fund I', holders)).toEqual([])
    expect(walletsForEntity([w('c', 'shared', null)], 'Fund II', holders)).toEqual([])
  })

  it('shows a scoped member only the wallets of their entities', () => {
    const all = [w('a', 'shared', 'Fund II'), w('b', 'solo', null), w('c', 'shared', null), w('d', 'shared', 'Fund I')]
    expect(scopeWallets(all, ['Fund I'], holders).map(x => x.id)).toEqual(['b', 'd'])
    expect(scopeWallets(all, null, holders).map(x => x.id)).toEqual(['a', 'b', 'c', 'd'])
  })
})

describe('wallet row mappers', () => {
  it('read database rows into the shapes the reconciliation uses', () => {
    expect(walletFromRow({ id: 'w', company_id: 'c', chain: 'ethereum', address: '0x1', label: null, active: null, verified_at: null, verification_method: null }))
      .toEqual({ id: 'w', companyId: 'c', chain: 'ethereum', address: '0x1', label: null, active: true, verifiedAt: null, verificationMethod: null })
    expect(balanceFromRow({ wallet_id: 'w', as_of_date: '2026-03-31', units: '12.5', block_height: 7 }))
      .toEqual({ walletId: 'w', asOfDate: '2026-03-31', units: 12.5, blockHeight: 7 })
  })
})

describe('soiRowHref', () => {
  it("links a schedule row to its holding, on the schedule's entity", () => {
    expect(soiRowHref({ companyId: 'f1' }, 'v1')).toBe('/companies/f1?entity=v1')
    expect(soiRowHref({ companyId: 'c1' }, null)).toBe('/companies/c1')
  })
  it('has nothing to link for a pooled ledger-only row', () => {
    expect(soiRowHref({}, 'v1')).toBeNull()
  })
})
