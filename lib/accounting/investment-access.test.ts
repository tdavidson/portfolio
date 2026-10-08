import { describe, it, expect } from 'vitest'
import { mayTouchInvestments } from './investment-access'
import type { AccessContext } from '@/lib/access/effective'

const ctx = (over: Partial<AccessContext> = {}): AccessContext => ({
  fundId: 'f', userId: 'u', role: 'member', features: {} as any, grants: { accounting: 'write', portfolio: 'write' }, defaults: {},
  vehicles: { all: true, ids: [] } as any, ...over,
})

describe('mayTouchInvestments', () => {
  it('a member with portfolio write may, when investments are on for everyone', () => {
    expect(mayTouchInvestments(ctx())).toBe(true)
  })
  it('an accounting-only member may not', () => {
    expect(mayTouchInvestments(ctx({ grants: { accounting: 'write' } }))).toBe(false)
  })
  it('investments limited to admins: a member is refused, an admin is not', () => {
    const features = { investments: 'admin' } as any
    expect(mayTouchInvestments(ctx({ features }))).toBe(false)
    expect(mayTouchInvestments(ctx({ features, role: 'admin' }))).toBe(true)
  })
  it('investments switched off or hidden: the tracker is not in use, so the ledger wins', () => {
    expect(mayTouchInvestments(ctx({ features: { investments: 'off' } as any, grants: { accounting: 'write' } }))).toBe(true)
    expect(mayTouchInvestments(ctx({ features: { investments: 'hidden' } as any, grants: { accounting: 'write' } }))).toBe(true)
  })
})
