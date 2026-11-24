import { describe, it, expect } from 'vitest'
import { buildDistributionPaymentEntry, buildDistributionDeclarationEntry, splitAgainstPayable } from './entries'

const base = { fundId: 'f', entryDate: '2026-06-30' }
const capMap = new Map([['a', 'cap-a'], ['b', 'cap-b']])
const sum = (xs: { amount: number }[]) => xs.reduce((s, p) => s + p.amount, 0)

describe('splitAgainstPayable', () => {
  it('settles what is owed first and leaves only the excess for capital', () => {
    const { settle, capital } = splitAgainstPayable(
      new Map([['a', 60_000], ['b', 40_000]]),
      new Map([['a', 50_000], ['b', 40_000]]),
    )
    expect(Object.fromEntries(settle)).toEqual({ a: 50_000, b: 40_000 })
    expect(Object.fromEntries(capital)).toEqual({ a: 10_000 })
  })

  it('treats a partner with nothing owed, or an overpaid payable, as a fresh distribution', () => {
    const { settle, capital } = splitAgainstPayable(new Map([['a', 1_000], ['b', 2_000]]), new Map([['b', -500]]))
    expect(settle.size).toBe(0)
    expect(Object.fromEntries(capital)).toEqual({ a: 1_000, b: 2_000 })
  })
})

describe('buildDistributionPaymentEntry', () => {
  it('paying a declared distribution per partner clears the payable and leaves capital alone', () => {
    const perLp = new Map([['a', 60_000], ['b', 40_000]])
    const declared = buildDistributionDeclarationEntry(base, perLp, capMap, 'payable')
    const paid = buildDistributionPaymentEntry(base, perLp, perLp, capMap, 'cash', 'payable')

    expect(paid.sourceType).toBe('distribution_settlement')
    const all = [...declared.postings, ...paid.postings]
    // Capital came down once, at declaration.
    expect(sum(all.filter(p => p.accountId === 'cap-a'))).toBe(60_000)
    expect(sum(all.filter(p => p.accountId === 'cap-b'))).toBe(40_000)
    // Nothing left owed, and the cash is out.
    expect(sum(all.filter(p => p.accountId === 'payable'))).toBe(0)
    expect(sum(all.filter(p => p.accountId === 'cash'))).toBe(-100_000)
  })

  it('books only the excess over the payable to capital, as a distribution', () => {
    const paid = buildDistributionPaymentEntry(base, new Map([['a', 70_000]]), new Map([['a', 60_000]]), capMap, 'cash', 'payable')
    expect(paid.sourceType).toBe('distribution')
    expect(paid.postings).toEqual(expect.arrayContaining([
      expect.objectContaining({ accountId: 'payable', amount: 60_000, lpEntityId: 'a' }),
      expect.objectContaining({ accountId: 'cap-a', amount: 10_000, lpEntityId: 'a' }),
      expect.objectContaining({ accountId: 'cash', amount: -70_000 }),
    ]))
  })

  it('without a payable account, every line is a distribution out of capital', () => {
    const paid = buildDistributionPaymentEntry(base, new Map([['a', 5_000]]), new Map([['a', 5_000]]), capMap, 'cash', null)
    expect(paid.sourceType).toBe('distribution')
    expect(paid.postings.find(p => p.accountId === 'cap-a')?.amount).toBe(5_000)
  })
})
