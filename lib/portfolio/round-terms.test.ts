import { beforeEach, describe, expect, it } from 'vitest'
import { memoryAdmin } from '../../tests/helpers/memory-admin'
import { cleanRoundTerms, isEmptyRoundTerms, setRoundTerms } from './round-terms'

describe('cleanRoundTerms', () => {
  it('keeps known fields, reads numbers and bases loosely, and drops bad values', () => {
    expect(cleanRoundTerms({ round_size: '$10,000,000', valuation: -5, valuation_basis: 'Post-Money', discount_pct: 150, lead: '  Example Ventures ', extra: 'x' })).toEqual({
      round_size: 10_000_000, valuation: null, valuation_basis: 'post_money', currency: null, lead: 'Example Ventures',
      security: null, discount_pct: null, rights: null, notes: null,
    })
    expect(isEmptyRoundTerms(cleanRoundTerms({}))).toBe(true)
  })
})

describe('setRoundTerms', () => {
  const store = memoryAdmin()
  beforeEach(() => {
    store.tables.investment_transactions = [
      { id: 't1', fund_id: 'fund-1', company_id: 'c1', transaction_type: 'investment', portfolio_group: 'Fund I', investment_cost: 100_000 },
      { id: 't2', fund_id: 'fund-1', company_id: 'c1', transaction_type: 'proceeds', portfolio_group: 'Fund I' },
    ]
  })
  const ctx = (vehicleNames: string[] | null) => ({ fundId: 'fund-1', vehicleNames })

  it('stores the terms on the transaction and touches nothing else', async () => {
    const out = await setRoundTerms(store.admin as any, ctx(null), 'c1', 't1', { round_size: 5_000_000, lead: 'Example Ventures' })
    expect(out.ok).toBe(true)
    const row = store.tables.investment_transactions[0]
    expect(row.round_terms).toMatchObject({ round_size: 5_000_000, lead: 'Example Ventures' })
    expect(row.investment_cost).toBe(100_000)
    // Nothing passed clears them.
    await setRoundTerms(store.admin as any, ctx(null), 'c1', 't1', {})
    expect(store.tables.investment_transactions[0].round_terms).toBeNull()
  })

  it("refuses another entity's transaction, an exit, and another company's id", async () => {
    expect(await setRoundTerms(store.admin as any, ctx(['Fund II']), 'c1', 't1', { lead: 'X' })).toMatchObject({ ok: false, status: 403 })
    expect(await setRoundTerms(store.admin as any, ctx(null), 'c1', 't2', { lead: 'X' })).toMatchObject({ ok: false, status: 400 })
    expect(await setRoundTerms(store.admin as any, ctx(null), 'c2', 't1', { lead: 'X' })).toMatchObject({ ok: false, status: 404 })
  })
})
