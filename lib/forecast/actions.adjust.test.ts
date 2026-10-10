import { describe, expect, it } from 'vitest'
import { nextAdjustments, toSaveInput } from './actions'

const detail: any = {
  plan: { id: 'p', vehicle: 'Fund I', name: 'Plan', revision: 3, adjustments: { entries: [], removed: [] } },
  accounts: [],
  allAccounts: [
    { id: 'cash', code: '1000', type: 'asset', subtype: 'cash' }, { id: 'cap', code: '3100', type: 'equity', subtype: 'lp_capital' },
    { id: 'gain', code: '4000', type: 'income', subtype: 'realized_gain' }, { id: 'inv', code: '1100', type: 'asset', subtype: 'investment' },
  ],
  cashAccountIds: ['cash'],
  entries: [{ date: '2031-02-28', kind: 'proceeds', memo: 'Exit proceeds — Acme', source: 'construction', key: 'construction|proceeds|2031-02-28|Exit proceeds — Acme',
    postings: [{ accountId: 'cash', amount: 900 }, { accountId: 'inv', amount: -300 }, { accountId: 'gain', amount: -600 }] }],
}

describe('the Analyst editing a forecast by hand', () => {
  it('sets a cash figure without writing an entry', () => {
    const adj = nextAdjustments(detail, { vehicle: 'Fund I', planId: 'p', cashFigures: [{ line: 'distributed', month: '2029-06', amount: 250 }] })
    expect(adj.entries[0].postings).toEqual([{ accountId: 'cash', amount: -250 }, { accountId: 'cap', amount: 250 }])
  })

  it('replaces a generated exit by key with an entry in account codes, and removes by key', () => {
    const replaced = nextAdjustments(detail, { vehicle: 'Fund I', planId: 'p', entries: [{ date: '2031-06-30', memo: 'Acme exit, later', replaces: detail.entries[0].key,
      lines: [{ account: '1000', amount: 1200 }, { account: '1100', amount: -300 }, { account: '4000', amount: -900 }] }] })
    expect(replaced.entries[0]).toMatchObject({ replaces: detail.entries[0].key, postings: [{ accountId: 'cash', amount: 1200 }, { accountId: 'inv', amount: -300 }, { accountId: 'gain', amount: -900 }] })
    expect(nextAdjustments(detail, { vehicle: 'Fund I', planId: 'p', removeEntries: [detail.entries[0].key] }).removed).toEqual([detail.entries[0].key])
  })

  it('refuses a key it was not given and an entry that does not balance', () => {
    expect(() => nextAdjustments(detail, { vehicle: 'Fund I', planId: 'p', entries: [{ date: '2031-06-30', memo: 'x', replaces: 'construction|made-up', lines: [{ account: '1000', amount: 1 }, { account: '4000', amount: -1 }] }] })).toThrow(/No generated entry/)
    expect(() => toSaveInput(detail, { vehicle: 'Fund I', planId: 'p', entries: [{ date: '2031-06-30', memo: 'x', lines: [{ account: '1000', amount: 2 }, { account: '4000', amount: -1 }] }] })).toThrow(/does not balance/)
  })
})
