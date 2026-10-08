import { describe, it, expect } from 'vitest'
import { memoryAdmin } from '@/tests/helpers/memory-admin'
import { owningTransactions, releaseOwnership } from './ownership'

const seed = (extra: Record<string, any[]> = {}) => memoryAdmin({
  companies: [{ id: 'co-a', fund_id: 'f', name: 'Acme' }],
  investment_transactions: [
    { id: 't1', fund_id: 'f', company_id: 'co-a', transaction_type: 'investment', transaction_date: '2026-03-01', adopted_entry_id: null },
    { id: 't2', fund_id: 'f', company_id: 'co-a', transaction_type: 'investment', transaction_date: '2026-03-01', adopted_entry_id: 'e-adopted' },
    { id: 't3', fund_id: 'f', company_id: 'co-a', transaction_type: 'unrealized_gain_change', transaction_date: '2026-03-01', adopted_entry_id: 'e-adopted' },
  ],
  journal_entries: [{ id: 'e-derived', fund_id: 'f', book: 'actual', source_ref: 'txn:t1' }],
  fund_capital_events: [], fund_nav_statements: [],
  ...extra,
})

describe('owningTransactions', () => {
  it('names a derived entry\'s transaction and every adopted one', async () => {
    const { admin } = seed()
    expect((await owningTransactions(admin, 'f', { id: 'e-derived', source_ref: 'txn:t1' })).map(t => t.id)).toEqual(['t1'])
    expect((await owningTransactions(admin, 'f', { id: 'e-adopted', source_ref: null })).map(t => t.id)).toEqual(['t2', 't3'])
    expect((await owningTransactions(admin, 'f', { id: 'e-adopted', source_ref: null }))[0]).toMatchObject({ company: 'Acme', type: 'investment' })
  })
})

describe('releaseOwnership', () => {
  it('deletes a derived entry\'s transaction and clears its source_ref', async () => {
    const m = seed()
    expect(await releaseOwnership(m.admin, 'f', { id: 'e-derived', source_ref: 'txn:t1' })).toMatchObject({ removed: [{ id: 't1' }], unlinked: [] })
    expect(m.tables.investment_transactions.map(t => t.id)).toEqual(['t2', 't3'])
    expect(m.tables.journal_entries[0].source_ref).toBeNull()
  })
  it('deletes every transaction an adopted entry owns', async () => {
    const m = seed()
    await releaseOwnership(m.admin, 'f', { id: 'e-adopted', source_ref: null })
    expect(m.tables.investment_transactions.map(t => t.id)).toEqual(['t1'])
  })
  it('refuses when a conversion depends on one of them, deleting nothing', async () => {
    const m = seed()
    m.tables.investment_transactions.push({ id: 'conv', fund_id: 'f', company_id: 'co-a', converts_from_txn_id: 't1' })
    expect(await releaseOwnership(m.admin, 'f', { id: 'e-derived', source_ref: 'txn:t1' })).toEqual({ error: expect.stringMatching(/conversion/) })
    expect(m.tables.investment_transactions).toHaveLength(4)
  })
  it('says which register rows lose their link', async () => {
    const m = seed({
      fund_capital_events: [{ id: 'ev', fund_id: 'f', kind: 'call', event_date: '2026-03-01', investment_transaction_id: 't1' }],
      fund_nav_statements: [{ id: 'nav', fund_id: 'f', as_of_date: '2026-03-31', investment_transaction_id: 't1' }],
    })
    expect(await releaseOwnership(m.admin, 'f', { id: 'e-derived', source_ref: 'txn:t1' }))
      .toMatchObject({ unlinked: ['the call of 2026-03-01', 'the NAV as of 2026-03-31'] })
  })
  it('an unowned entry releases nothing', async () => {
    const m = seed()
    expect(await releaseOwnership(m.admin, 'f', { id: 'other', source_ref: null })).toEqual({ removed: [], unlinked: [] })
  })
  it('a failure after the delete reports what was deleted; a failed delete reports nothing', async () => {
    const m = seed()
    m.failNext('journal_entries', 'update', 'unlink failed')
    expect(await releaseOwnership(m.admin, 'f', { id: 'e-derived', source_ref: 'txn:t1' }))
      .toMatchObject({ error: expect.stringMatching(/unlink failed/), removed: [{ id: 't1' }] })
    const n = seed()
    n.failNext('investment_transactions', 'delete', 'delete failed')
    expect(await releaseOwnership(n.admin, 'f', { id: 'e-derived', source_ref: 'txn:t1' }))
      .toEqual({ error: expect.stringMatching(/delete failed/), removed: [], unlinked: [] })
  })
})
