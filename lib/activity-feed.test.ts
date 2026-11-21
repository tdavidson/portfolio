import { describe, expect, it, beforeEach } from 'vitest'
import { actionLabel, categorizeActions, countByUser, mergeActivityFeed } from './activity-feed'
import { logConnection, resetConnectionCache } from './activity'

const U1 = 'user-1'
const U2 = 'user-2'

describe('mergeActivityFeed', () => {
  it('reads both stores as one list, newest first, each with its door', () => {
    const feed = mergeActivityFeed(
      [{ user_id: U1, action: 'login', metadata: { changeSource: 'web' }, created_at: '2026-01-02T09:00:00Z' }],
      [{ actor_id: U1, action: 'entry.post', subject_type: 'journal_entry', subject_id: 'je-1', source: 'mcp', created_at: '2026-01-02T10:00:00Z' }],
    )
    expect(feed.map(e => [e.action, e.source, e.kind])).toEqual([
      ['entry.post', 'mcp', 'books'],
      ['login', 'web', 'activity'],
    ])
  })

  it('drops an agent.write that duplicates the record its tool wrote', () => {
    const feed = mergeActivityFeed(
      [{ user_id: U1, action: 'company.document_upload', metadata: { changeSource: 'mcp' }, created_at: '2026-01-02T10:00:00.000Z' }],
      [
        { actor_id: U1, action: 'agent.write', subject_type: 'agent_tool', subject_id: 'x', source: 'mcp', tool: 'company_document_upload_url', created_at: '2026-01-02T10:00:00.400Z' },
        { actor_id: U1, action: 'entry.post', subject_type: 'journal_entry', subject_id: 'je-1', source: 'mcp', created_at: '2026-01-02T11:00:00.000Z' },
        { actor_id: U1, action: 'agent.write', subject_type: 'agent_tool', subject_id: 'x', source: 'mcp', tool: 'post_entry', created_at: '2026-01-02T11:00:00.300Z' },
      ],
    )
    expect(feed.map(e => e.action)).toEqual(['entry.post', 'company.document_upload'])
  })

  it('keeps an agent.write that is the call\'s only trace, named for its tool', () => {
    const feed = mergeActivityFeed([], [
      { actor_id: U1, action: 'agent.write', subject_type: 'agent_tool', subject_id: 'x', source: null, legacy_source: 'api', tool: 'import_bank_transactions', created_at: '2026-01-02T10:00:00Z' },
      // Another person's record at the same moment is not the same call.
      { actor_id: U2, action: 'entry.post', subject_type: 'journal_entry', subject_id: 'je-1', source: 'web', created_at: '2026-01-02T10:00:00Z' },
    ])
    const tool = feed.find(e => e.userId === U1)!
    expect(tool.action).toBe('tool:import_bank_transactions')
    expect(tool.source).toBe('api')
    expect(actionLabel(tool.action)).toBe('Ran import_bank_transactions')
  })

  it('leaves out events with no person (system writes)', () => {
    expect(mergeActivityFeed([], [{ actor_id: null, action: 'period.close', subject_type: 'period', subject_id: null, source: 'web', created_at: '2026-01-02T10:00:00Z' }])).toEqual([])
  })
})

describe('counting', () => {
  it('counts every entry per person and sorts actions into the summary columns', () => {
    const feed = mergeActivityFeed(
      [
        { user_id: U1, action: 'login', metadata: {}, created_at: '2026-01-02T09:00:00Z' },
        { user_id: U1, action: 'connect', metadata: { changeSource: 'mcp' }, created_at: '2026-01-02T09:30:00Z' },
        { user_id: U1, action: 'company.update', metadata: {}, created_at: '2026-01-02T09:40:00Z' },
      ],
      [{ actor_id: U1, action: 'entry.post', subject_type: 'journal_entry', subject_id: 'je-1', source: 'mcp', created_at: '2026-01-02T10:00:00Z' }],
    )
    const counts = countByUser(feed).get(U1)!
    expect(categorizeActions(counts)).toEqual({ signins: 2, companies: 1, imports: 0, books: 1, other: 0 })
  })
})

describe('logConnection', () => {
  beforeEach(() => resetConnectionCache())

  function fakeAdmin(existing: unknown[] = []) {
    const inserts: any[] = []
    let lookups = 0
    const chain: any = {
      select: () => chain, eq: () => chain, gte: () => chain,
      limit: async () => { lookups++; return { data: existing } },
      maybeSingle: async () => ({ data: null }),
      insert: async (row: any) => { inserts.push(row); return { error: null } },
    }
    return { admin: { from: () => chain }, inserts, lookups: () => lookups }
  }

  it('logs one connect per person, door and credential per day, tagged with the door', async () => {
    const f = fakeAdmin()
    const day = new Date('2026-01-02T10:00:00Z')
    await logConnection(f.admin, 'fund-1', U1, 'mcp', 'oauth:client-1', day)
    await logConnection(f.admin, 'fund-1', U1, 'mcp', 'oauth:client-1', day)
    expect(f.inserts).toHaveLength(1)
    expect(f.inserts[0]).toMatchObject({ action: 'connect', user_id: U1, metadata: { changeSource: 'mcp', credential: 'oauth:client-1' } })
    expect(f.lookups()).toBe(1)

    await logConnection(f.admin, 'fund-1', U1, 'api', 'key-1', day)
    await logConnection(f.admin, 'fund-1', U1, 'mcp', 'oauth:client-1', new Date('2026-01-03T00:01:00Z'))
    expect(f.inserts).toHaveLength(3)
  })

  it('writes nothing when another server already logged today\'s', async () => {
    const f = fakeAdmin([{ id: 'row-1' }])
    await logConnection(f.admin, 'fund-1', U1, 'mcp', 'oauth:client-1', new Date('2026-01-02T10:00:00Z'))
    expect(f.inserts).toHaveLength(0)
  })
})
