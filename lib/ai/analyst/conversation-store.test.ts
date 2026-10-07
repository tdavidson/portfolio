import { describe, expect, it } from 'vitest'
import { conversationBelongsToPrincipal, persistConversation } from './conversation-store'
import type { AccessContext } from '@/lib/access/effective'
import { DEFAULT_FEATURE_VISIBILITY, type FeatureVisibilityMap } from '@/lib/types/features'

const access: AccessContext = {
  fundId: 'fund-1',
  userId: 'user-1',
  vehicles: { all: true, ids: [] },
  role: 'member',
  features: { ...DEFAULT_FEATURE_VISIBILITY } as FeatureVisibilityMap,
  grants: {},
  defaults: {},
}
const principal = { userId: 'user-1', fundId: 'fund-1', role: 'member', access }

function recordingAdmin(existing: { id: string; fundId: string; userId: string }) {
  const filters: Array<[string, unknown]> = []
  const updates: Record<string, unknown>[] = []
  const chain: Record<string, any> = {
    select: () => chain,
    update: (value: Record<string, unknown>) => {
      updates.push(value)
      return chain
    },
    eq: (field: string, value: unknown) => {
      filters.push([field, value])
      return chain
    },
    maybeSingle: async () => {
      const values = Object.fromEntries(filters)
      const matches = values.id === existing.id
        && values.fund_id === existing.fundId
        && values.user_id === existing.userId
      return { data: matches ? { id: existing.id } : null, error: null }
    },
    then: (resolve: (value: unknown) => unknown, reject: (reason: unknown) => unknown) =>
      Promise.resolve({ data: null, error: null }).then(resolve, reject),
  }
  return {
    admin: { from: () => chain } as any,
    filters,
    updates,
  }
}

describe('Analyst conversation isolation', () => {
  it('accepts a conversation only for the authenticated user and fund', async () => {
    const own = recordingAdmin({ id: 'conversation-1', fundId: 'fund-1', userId: 'user-1' })
    expect(await conversationBelongsToPrincipal(own.admin, principal, 'conversation-1')).toBe(true)

    const anotherUser = recordingAdmin({ id: 'conversation-1', fundId: 'fund-1', userId: 'user-2' })
    expect(await conversationBelongsToPrincipal(anotherUser.admin, principal, 'conversation-1')).toBe(false)

    const anotherFund = recordingAdmin({ id: 'conversation-1', fundId: 'fund-2', userId: 'user-1' })
    expect(await conversationBelongsToPrincipal(anotherFund.admin, principal, 'conversation-1')).toBe(false)
  })

  it('scopes updates by conversation, fund, and user', async () => {
    const fixture = recordingAdmin({ id: 'conversation-1', fundId: 'fund-1', userId: 'user-1' })
    const result = await persistConversation({
      admin: fixture.admin,
      principal,
      coordinates: { companyId: null, dealId: null, scope: null },
      conversationId: 'conversation-1',
      messages: [{ role: 'user', content: 'Question' }],
      reply: 'Answer',
      provider: {} as any,
      model: 'test-model',
    })

    expect(result).toBe('conversation-1')
    expect(fixture.filters).toEqual(expect.arrayContaining([
      ['id', 'conversation-1'],
      ['fund_id', 'fund-1'],
      ['user_id', 'user-1'],
    ]))
    expect(fixture.updates[0]).toMatchObject({ message_count: 2 })
  })
})
