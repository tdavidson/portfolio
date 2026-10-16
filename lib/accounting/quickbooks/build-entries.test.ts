import { describe, it, expect } from 'vitest'
import { createHash } from 'crypto'
import { buildEntries, qbLegacySourceRef, qbSourceRef, qbSourceRefs, qbVendorName } from './build-entries'
import type { QbTransaction } from './parse-journal'

const txn: QbTransaction = {
  date: '2024-01-15', type: 'Journal Entry', num: 'JE-1', memo: 'Capital call — Acme III',
  lines: [
    { account: 'Investments:Acme Ventures III', name: null, memo: 'Capital call', debit: 1_000_000, credit: 0 },
    { account: 'Bank:Operating', name: null, memo: 'Capital call', debit: 0, credit: 1_000_000 },
  ],
}

const MAPPING = new Map([['Investments:Acme Ventures III', '1100'], ['Bank:Operating', '1000']])
const IDS = new Map([['1100', 'acct-1100'], ['1000', 'acct-1000']])

describe('qbSourceRef', () => {
  it('is stable across runs for the same transaction', () => {
    expect(qbSourceRef(txn)).toBe(qbSourceRef({ ...txn, lines: [...txn.lines] }))
    expect(qbSourceRef(txn)).toMatch(/^qb:v2:[0-9a-f]{32}$/)
  })

  it('changes when an amount changes, so a corrected export re-imports', () => {
    const edited = { ...txn, lines: [{ ...txn.lines[0], debit: 999 }, txn.lines[1]] }
    expect(qbSourceRef(edited)).not.toBe(qbSourceRef(txn))
  })

  it('is insensitive to line order, which QuickBooks does not guarantee', () => {
    const reordered = { ...txn, lines: [txn.lines[1], txn.lines[0]] }
    expect(qbSourceRef(reordered)).toBe(qbSourceRef(txn))
  })

  it('distinguishes two same-day transactions with different numbers', () => {
    expect(qbSourceRef({ ...txn, num: 'JE-2' })).not.toBe(qbSourceRef(txn))
  })

  // Two LPs wiring the same amount on the same day, no number: the first version hashed these
  // identically and skipped every one after the first.
  const deposit = (name: string, memo: string | null = null): QbTransaction => ({
    date: '2024-03-01', type: 'Deposit', num: null, memo,
    lines: [
      { account: 'Bank:Operating', name, memo: null, debit: 25_000, credit: 0 },
      { account: 'Partner investments', name: null, memo: null, debit: 0, credit: 25_000 },
    ],
  })

  it('distinguishes same-day, same-amount transactions from different payees', () => {
    expect(qbSourceRef(deposit('Alex Rivera'))).not.toBe(qbSourceRef(deposit('Ann Lee')))
    expect(qbLegacySourceRef(deposit('Alex Rivera'))).toBe(qbLegacySourceRef(deposit('Ann Lee')))
  })

  it('distinguishes them by memo, and ignores whitespace noise in names', () => {
    expect(qbSourceRef(deposit('Alex Rivera', 'Call 1'))).not.toBe(qbSourceRef(deposit('Alex Rivera', 'Call 2')))
    expect(qbSourceRef(deposit(' Alex  Rivera '))).toBe(qbSourceRef(deposit('Alex Rivera')))
  })

  it('keeps the first-version ref byte-for-byte, so entries already imported are still recognised', () => {
    expect(qbLegacySourceRef(txn)).toBe('qb:' + createHash('sha256')
      .update('2024-01-15|Journal Entry|JE-1|Bank:Operating|0.00|1000000.00;Investments:Acme Ventures III|1000000.00|0.00')
      .digest('hex').slice(0, 32))
  })

  it('numbers identical transactions within a batch instead of colliding them', () => {
    const refs = qbSourceRefs([deposit('Alex Rivera'), deposit('Ann Lee'), deposit('Alex Rivera'), deposit('Alex Rivera')])
    const base = qbSourceRef(deposit('Alex Rivera'))
    expect(refs.map(r => r.ref)).toEqual([base, qbSourceRef(deposit('Ann Lee')), `${base}:2`, `${base}:3`])
    expect(new Set(refs.map(r => r.legacyRef)).size).toBe(1)
    const { entries, origins } = buildEntries([deposit('Alex Rivera'), deposit('Alex Rivera')],
      new Map([['Bank:Operating', '1000'], ['Partner investments', '3100']]), new Map([['1000', 'cash'], ['3100', 'lp']]), 'f')
    expect(entries.map(e => e.sourceRef)).toEqual([base, `${base}:2`])
    expect(origins.map(o => o.legacyRef)).toEqual([qbLegacySourceRef(deposit('Alex Rivera')), qbLegacySourceRef(deposit('Alex Rivera'))])
  })
})

describe('buildEntries', () => {
  it('converts debit/credit columns into signed postings', () => {
    const { entries } = buildEntries([txn], MAPPING, IDS, 'fund-1')
    expect(entries).toHaveLength(1)
    const [e] = entries
    expect(e.entryDate).toBe('2024-01-15')
    expect(e.fundId).toBe('fund-1')
    expect(e.postings.map(p => p.amount)).toEqual([1_000_000, -1_000_000])
    expect(e.postings.map(p => p.accountId)).toEqual(['acct-1100', 'acct-1000'])
  })

  it('stamps sourceType and a stable sourceRef for idempotent re-import', () => {
    const [e] = buildEntries([txn], MAPPING, IDS, 'fund-1').entries
    expect(e.sourceType).toBe('quickbooks')
    expect(e.sourceRef).toBe(qbSourceRef(txn))
  })

  it('marks every imported entry as a draft', () => {
    // Nothing posts on import. A bad mapping is then re-runnable rather than needing reversal.
    const [e] = buildEntries([txn], MAPPING, IDS, 'fund-1').entries
    expect(e.status).toBe('draft')
  })

  it('carries the QuickBooks type and number into the memo so an entry is traceable', () => {
    const [e] = buildEntries([txn], MAPPING, IDS, 'fund-1').entries
    expect(e.memo).toMatch(/JE-1/)
    expect(e.memo).toMatch(/Capital call/)
  })

  it('skips a transaction with an unmapped account, naming the account', () => {
    const partial = new Map([['Bank:Operating', '1000']])
    const { entries, skipped } = buildEntries([txn], partial, IDS, 'fund-1')
    expect(entries).toEqual([])
    expect(skipped[0].reason).toMatch(/Investments:Acme Ventures III/)
  })

  it('skips a transaction whose mapped code has no account in the chart', () => {
    const { entries, skipped } = buildEntries([txn], MAPPING, new Map([['1000', 'acct-1000']]), 'fund-1')
    expect(entries).toEqual([])
    expect(skipped[0].reason).toMatch(/1100/)
  })

  it('produces balanced postings for a multi-split transaction', () => {
    const multi: QbTransaction = {
      ...txn, num: 'JE-2',
      lines: [
        { account: 'Investments:Acme Ventures III', name: null, memo: null, debit: 900, credit: 0 },
        { account: 'Bank:Operating', name: null, memo: null, debit: 100, credit: 0 },
        { account: 'Bank:Operating', name: null, memo: null, debit: 0, credit: 1000 },
      ],
    }
    const [e] = buildEntries([multi], MAPPING, IDS, 'fund-1').entries
    expect(e.postings.reduce((a, p) => a + p.amount, 0)).toBe(0)
    expect(e.postings).toHaveLength(3)
  })

  it('keeps good transactions when a neighbour is skipped', () => {
    const bad: QbTransaction = {
      ...txn, num: 'JE-3',
      lines: [{ account: 'Unmapped Thing', name: null, memo: null, debit: 5, credit: 0 },
              { account: 'Bank:Operating', name: null, memo: null, debit: 0, credit: 5 }],
    }
    const { entries, skipped } = buildEntries([txn, bad], MAPPING, IDS, 'fund-1')
    expect(entries).toHaveLength(1)
    expect(skipped).toHaveLength(1)
  })
})

describe('vendors on import', () => {
  const paid: QbTransaction = {
    date: '2024-02-01', type: 'Check', num: '1042', memo: 'Audit fee',
    lines: [
      { account: 'Investments:Acme Ventures III', name: 'Acme Audit LLP', memo: null, debit: 5000, credit: 0 },
      { account: 'Bank:Operating', name: 'Acme Audit LLP', memo: null, debit: 0, credit: 5000 },
    ],
  }

  it('reads the payee from the first named line', () => {
    expect(qbVendorName(paid)).toBe('Acme Audit LLP')
    expect(qbVendorName(txn)).toBeNull()
  })

  it('carries the resolved vendor id onto the entry, case-insensitively, and none without a map', () => {
    const ids = new Map([['acme audit llp', 'vendor-1']])
    expect(buildEntries([paid], MAPPING, IDS, 'fund-1', ids).entries[0].vendorId).toBe('vendor-1')
    expect(buildEntries([paid], MAPPING, IDS, 'fund-1').entries[0].vendorId).toBeNull()
    expect(buildEntries([txn], MAPPING, IDS, 'fund-1', ids).entries[0].vendorId).toBeNull()
  })
})

describe('per-LP capital from QuickBooks', () => {
  const contribution: QbTransaction = {
    date: '2024-01-15', type: 'Deposit', num: null, memo: null,
    lines: [
      { account: 'Bank', name: 'Alex Rivera', memo: null, debit: 87500, credit: 0 },
      { account: 'Partner investments', name: null, memo: null, debit: 0, credit: 87500 },
    ],
  }
  const mapping = new Map([['Bank', '1000'], ['Partner investments', '3100']])
  const ids = new Map([['1000', 'cash'], ['3100', 'pooled']])
  const capital = { accountIds: new Set(['pooled']), targets: [{ entityId: 'alex', name: 'Alex Rivera', accountId: 'alex-capital' }] }
  it('links the equity split while preserving cash, source identity and balance', () => {
    const result = buildEntries([contribution], mapping, ids, 'fund', undefined, capital)
    expect(result.entries[0].postings).toEqual([
      { accountId: 'cash', amount: 87500, currency: 'USD' },
      { accountId: 'alex-capital', lpEntityId: 'alex', amount: -87500, currency: 'USD' },
    ])
    expect(result.entries[0].sourceRef).toBe(qbSourceRef(contribution))
    expect(result.capitalWarnings).toEqual([])
  })
  it('retains unknown LPs in pooled capital and exposes the review item', () => {
    const result = buildEntries([contribution], mapping, ids, 'fund', undefined, { ...capital, targets: [] })
    expect(result.entries[0].postings[1].accountId).toBe('pooled')
    expect(result.capitalWarnings).toHaveLength(1)
    expect(result.entries[0].postings.reduce((s, p) => s + p.amount, 0)).toBe(0)
  })
  it('matches separate named capital splits independently', () => {
    const split = { ...contribution, lines: [
      { ...contribution.lines[0], debit: 100 },
      { ...contribution.lines[1], name: 'Alex Rivera', credit: 60 },
      { ...contribution.lines[1], name: 'Other LP', credit: 40 },
    ] }
    const result = buildEntries([split], mapping, ids, 'fund', undefined, capital)
    expect(result.entries[0].postings.map(p => p.accountId)).toEqual(['cash', 'alex-capital', 'pooled'])
    expect(result.capitalWarnings).toHaveLength(1)
  })
})

describe('journal sources', () => {
  it('tags a Carta import with its own provenance and idempotency prefix', () => {
    const [e] = buildEntries([txn], MAPPING, IDS, 'fund-1', undefined, undefined, 'carta').entries
    expect(e.sourceType).toBe('carta')
    expect(e.sourceRef).toMatch(/^carta:v2:[0-9a-f]{32}$/)
  })

  it('never matches the same transaction across sources as a re-import', () => {
    expect(qbSourceRef(txn, 'carta').slice(6)).toBe(qbSourceRef(txn).slice(3))
    expect(qbLegacySourceRef(txn, 'carta')).not.toBe(qbLegacySourceRef(txn))
    expect(qbSourceRef(txn, 'carta')).not.toBe(qbSourceRef(txn))
  })

  it('names the source in an unmapped-account skip', () => {
    const { skipped } = buildEntries([txn], new Map(), IDS, 'fund-1', undefined, undefined, 'carta')
    expect(skipped[0].reason).toContain('Carta account')
  })
})
