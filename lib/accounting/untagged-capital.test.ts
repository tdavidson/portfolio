import { describe, it, expect } from 'vitest'
import { untaggedCapitalPostings } from './status'

const accounts = [
  { id: 'jane', subtype: 'lp_capital', lpEntityId: 'lp-jane' },
  { id: 'pool', subtype: 'lp_capital', lpEntityId: null },
  { id: 'cash', subtype: 'cash', lpEntityId: null },
]
const p = (over: any) => ({ entryId: 'e', accountId: 'jane', amount: -100, lpEntityId: null, entryDate: '2025-01-30', memo: null, ...over })

describe('untaggedCapitalPostings', () => {
  it("names a line on a partner's own account with no partner tag, and anything on the pooled account", () => {
    const out = untaggedCapitalPostings(accounts, [
      p({ entryId: 'a' }),
      p({ entryId: 'b', lpEntityId: 'lp-jane' }),
      p({ entryId: 'c', accountId: 'pool', entryDate: '2026-01-06' }),
      p({ entryId: 'd', accountId: 'cash' }),
      p({ entryId: 'z', amount: 0 }),
    ])
    expect(out.map(u => [u.entryId, u.ownerId])).toEqual([['c', null], ['a', 'lp-jane']])
  })
})
