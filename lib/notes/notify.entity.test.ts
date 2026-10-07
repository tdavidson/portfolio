import { describe, it, expect, vi, beforeEach } from 'vitest'

const m = vi.hoisted(() => ({ send: vi.fn(), audience: vi.fn() }))
vi.mock('@/lib/email', () => ({ getOutboundConfig: async () => ({}), sendOutboundEmail: m.send }))
vi.mock('@/lib/access/company-audience', () => ({ membersWhoCanSeeNote: m.audience }))

import { sendNoteNotifications } from './notify'

const rows: Record<string, any[]> = {
  fund_members: [{ user_id: 'author' }, { user_id: 'mine' }, { user_id: 'other' }],
  note_notification_preferences: [{ user_id: 'mine', level: 'all' }, { user_id: 'other', level: 'all' }],
  note_company_subscriptions: [],
}
const admin = {
  from: (t: string) => {
    const chain: any = {
      select: () => chain, eq: () => chain,
      maybeSingle: async () => ({ data: null }),
      then: (res: any) => res({ data: rows[t] ?? [], error: null }),
    }
    return chain
  },
  auth: { admin: { getUserById: async (id: string) => ({ data: { user: { email: `${id}@x.test` } } }) } },
} as any

const note = (companyId: string | null) => ({
  id: 'n1', content: 'Q3 numbers are soft', companyId, companyName: companyId ? 'Acme' : null, vehicleId: 'v1',
  authorName: 'A', authorUserId: 'author', mentionedUserIds: ['other'],
})

describe('note notifications — only to members who can read the note', () => {
  beforeEach(() => { m.send.mockClear(); m.audience.mockReset() })

  it('a company note skips a member who cannot see the company, even when @mentioned', async () => {
    m.audience.mockResolvedValue(new Set(['author', 'mine']))
    await sendNoteNotifications(admin, 'f1', note('c1'))
    expect(m.send.mock.calls.map(c => c[1].to)).toEqual(['mine@x.test'])
  })
  it('before the entity migration (audience unknown): everyone, as before', async () => {
    m.audience.mockResolvedValue(null)
    await sendNoteNotifications(admin, 'f1', note('c1'))
    expect(m.send.mock.calls.map(c => c[1].to).sort()).toEqual(['mine@x.test', 'other@x.test'])
  })
  it('a note about no company is filtered by its entity', async () => {
    m.audience.mockResolvedValue(new Set(['author', 'other']))
    await sendNoteNotifications(admin, 'f1', note(null))
    expect(m.audience).toHaveBeenCalledWith(admin, 'f1', { vehicleId: 'v1', companyId: null })
    expect(m.send.mock.calls.map(c => c[1].to)).toEqual(['other@x.test'])
  })
})
