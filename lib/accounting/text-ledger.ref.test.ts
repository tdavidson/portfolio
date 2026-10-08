import { describe, it, expect } from 'vitest'
import { serializeLedger, parseLedgerText } from './text-ledger'

const accounts = [
  { id: 'cash', fundId: 'f', code: '1000', name: 'Cash', type: 'asset' as const, subtype: 'cash' },
  { id: 'cost', fundId: 'f', code: '1100-aa', name: 'Investment — Acme', type: 'asset' as const, subtype: 'investment', companyId: 'co' },
]

describe('text ledger keeps what produced an entry', () => {
  it('writes the entry\'s ref and reads it back', () => {
    const text = serializeLedger(accounts, [{ entryDate: '2026-03-01', memo: 'Investment — Acme', status: 'posted', sourceRef: 'txn:t1',
      postings: [{ accountId: 'cost', amount: 100, currency: 'USD' }, { accountId: 'cash', amount: -100, currency: 'USD' }] }])
    expect(text).toContain('  ref: "txn:t1"')
    expect(parseLedgerText(text).entries[0].ref).toBe('txn:t1')
  })
})
