import { describe, expect, it } from 'vitest'
import type { AccessContext } from '@/lib/access/effective'
import { accessByArea, credentialSummary } from './whoami'

const base: AccessContext = {
  fundId: 'fund-1',
  userId: 'user-1',
  role: 'member',
  features: {} as AccessContext['features'],
  grants: {},
  defaults: {},
  vehicles: { all: true, ids: [] } as any,
}

describe('whoami', () => {
  it('gives an admin every area that is switched on, and a member only their grants', () => {
    const admin = accessByArea({ ...base, role: 'admin' })
    expect(admin.granted.length).toBeGreaterThan(0)
    expect(admin.granted.every(a => a.level === 'edit')).toBe(true)

    const member = accessByArea({ ...base, grants: { portfolio: 'read' }, defaults: {} })
    const portfolio = member.granted.find(a => a.area.toLowerCase().includes('portfolio'))
    expect(portfolio?.level).toBe('read')
    expect(member.none.length).toBeGreaterThan(0)
  })

  it('describes a read-only assistant and a read-and-write key differently', () => {
    expect(credentialSummary({ kind: 'assistant', canWrite: false })).toMatchObject({ kind: 'chat assistant (OAuth)', canChange: false })
    expect(credentialSummary({ kind: 'key', canWrite: true })).toMatchObject({ kind: 'API key', canChange: true })
    expect(credentialSummary(undefined).kind).toBe('unknown')
  })
})
