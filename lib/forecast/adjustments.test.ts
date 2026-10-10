import { describe, expect, it } from 'vitest'
import { applyAdjustments, cashCellAdjustments, entryKey, NO_ADJUSTMENTS, validateAdjustments, AdjustmentError } from './adjustments'
import type { CompiledEntry } from './compile'

const exit: CompiledEntry = {
  entryDate: '2031-02-28', kind: 'proceeds', memo: 'Exit proceeds — Bluefish Labs (inferred)', accountId: 'gain', ruleId: null, overrideId: null,
  source: 'construction', postings: [{ accountId: 'cash', amount: 8_250_000, currency: 'USD' }, { accountId: 'inv', amount: -3_000_000, currency: 'USD' }, { accountId: 'gain', amount: -5_250_000, currency: 'USD' }],
}
const fee: CompiledEntry = {
  entryDate: '2027-01-31', kind: 'recognition', memo: '5000 Management fee — 2027-01', accountId: 'fee', ruleId: 'r', overrideId: null,
  source: 'rule', postings: [{ accountId: 'fee', amount: 2100, currency: 'USD' }, { accountId: 'prepaid', amount: -2100, currency: 'USD' }],
}
const ACCOUNTS = ['cash', 'inv', 'gain', 'fee', 'prepaid', 'cap'].map(id => ({ id }))
const window = { first: '2026-10' as const, last: '2031-09' as const }

describe('editing a forecast by hand', () => {
  it('gives generated entries a key, and rule entries none (they edit through the rule)', () => {
    expect(entryKey(exit)).toBe('construction|proceeds|2031-02-28|Exit proceeds — Bluefish Labs (inferred)')
    expect(entryKey(fee)).toBeNull()
  })

  it('replaces a construction exit with the edited one — a later month, a different amount', () => {
    const adj = validateAdjustments({ entries: [{ id: 'm1', date: '2031-09-30', memo: 'Exit proceeds — Bluefish Labs (our view)', replaces: entryKey(exit),
      postings: [{ accountId: 'cash', amount: 9_000_000 }, { accountId: 'inv', amount: -3_000_000 }, { accountId: 'gain', amount: -6_000_000 }] }], removed: [] }, ACCOUNTS)
    const r = applyAdjustments([exit, fee], adj, window, 'USD')
    expect(r.entries.map(e => [e.entryDate, e.source])).toEqual([['2027-01-31', 'rule'], ['2031-09-30', 'manual']])
    expect(r.entries[1].key).toBe('manual|m1')
    expect(r.warnings).toEqual([])
  })

  it('removes a generated entry, and says when an edit no longer matches what the source generates', () => {
    const r = applyAdjustments([fee], validateAdjustments({ entries: [], removed: [entryKey(exit)] }, ACCOUNTS), window, 'USD')
    expect(r.entries).toEqual([fee])
    expect(r.warnings[0]).toMatch(/no longer generated/)
  })

  it('refuses an entry that does not balance, or names an account outside the chart', () => {
    expect(() => validateAdjustments({ entries: [{ date: '2027-03-31', memo: 'x', postings: [{ accountId: 'cash', amount: 10 }, { accountId: 'cap', amount: -9 }] }] }, ACCOUNTS)).toThrow(AdjustmentError)
    expect(() => validateAdjustments({ entries: [{ date: '2027-03-31', memo: 'x', postings: [{ accountId: 'cash', amount: 10 }, { accountId: 'nope', amount: -10 }] }] }, ACCOUNTS)).toThrow(/not in this chart/)
  })
})

describe('editing a cash figure', () => {
  const accounts = [
    { id: 'cash', code: '1000', type: 'asset', subtype: 'cash' }, { id: 'inv', code: '1100', type: 'asset', subtype: 'investment' },
    { id: 'gain', code: '4000', type: 'income', subtype: 'realized_gain' }, { id: 'cap', code: '3100', type: 'equity', subtype: 'lp_capital' },
  ]
  const exitEntry = { date: exit.entryDate, kind: 'proceeds', memo: exit.memo, source: 'construction', key: entryKey(exit),
    postings: exit.postings.map(p => ({ accountId: p.accountId, amount: p.amount })) }
  const base = { entries: [exitEntry], accounts, cashAccountIds: ['cash'] }

  it('replaces the month\'s exit with your figure — the cost stays, the gain takes the rest', () => {
    const adj = cashCellAdjustments(NO_ADJUSTMENTS, { ...base, category: 'proceeds', month: '2031-02', cash: 10_000_000 })
    expect(adj.removed).toEqual([entryKey(exit)])
    expect(adj.entries).toHaveLength(1)
    expect(adj.entries[0].postings).toEqual([
      { accountId: 'cash', amount: 10_000_000 }, { accountId: 'inv', amount: -3_000_000 }, { accountId: 'gain', amount: -7_000_000 },
    ])
  })

  it('adds a distribution where construction has none, on the standard accounts', () => {
    const adj = cashCellAdjustments(NO_ADJUSTMENTS, { ...base, category: 'distributed', month: '2028-06', cash: 500_000 })
    expect(adj.entries[0].postings).toEqual([{ accountId: 'cash', amount: -500_000 }, { accountId: 'cap', amount: 500_000 }])
  })

  it('edits its own entry when the cell is changed again, and clears it at zero', () => {
    const once = cashCellAdjustments(NO_ADJUSTMENTS, { ...base, category: 'distributed', month: '2028-06', cash: 500_000 })
    const shown = [{ date: '2028-06-30', kind: 'recognition', memo: once.entries[0].memo, source: 'manual', key: `manual|${once.entries[0].id}`, postings: once.entries[0].postings }]
    const twice = cashCellAdjustments(once, { ...base, entries: shown, category: 'distributed', month: '2028-06', cash: 750_000 })
    expect(twice.entries).toHaveLength(1)
    expect(twice.entries[0].postings[0].amount).toBe(-750_000)
    expect(cashCellAdjustments(twice, { ...base, entries: shown, category: 'distributed', month: '2028-06', cash: 0 }).entries).toEqual([])
  })
})
