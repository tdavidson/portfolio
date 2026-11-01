import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/lib/oauth/enabled', () => ({ agentApiEnabled: vi.fn(async (_admin: unknown, fundId: string) => fundId !== 'f-off') }))

import {
  checkActiveFundArgument, loadPool, masterAdminEmails, masterAdminGroups, matchFund, normalizeSessionId, poolFunds,
  setActiveFund, withActiveFundArgument, type MasterAdminPool,
} from './master-admin'

const ROWS = [
  { user_id: 'u-nw', email: 't@northwind.example', fund_id: 'f-nw', fund_name: 'Northwind Holdings' },
  { user_id: 'u-rb', email: 't@riverbend.example', fund_id: 'f-rb', fund_name: 'Riverbend Capital' },
]

/**
 * A client that answers the three tables loadPool reads: agent_active_funds (the stored choice),
 * account_links (linked sign-ins: user → group) and fund_settings (whether a fund allows linking).
 */
function fakeAdmin(rows: unknown[], active: string | null = null, opts: { links?: Record<string, string>; emails?: Record<string, string>; noLinking?: string[] } = {}) {
  const links = opts.links ?? {}
  return {
    rpc: vi.fn(async () => ({ data: rows, error: null })),
    auth: { admin: { getUserById: async (id: string) => ({ data: { user: { email: opts.emails?.[id] } } }) } },
    from: (table: string) => {
      const filters: Record<string, string> = {}
      const chain: any = {
        select: () => chain,
        eq: (col: string, val: string) => { filters[col] = val; return chain },
        maybeSingle: async () => {
          if (table === 'agent_active_funds') return { data: active ? { fund_id: active } : null }
          if (table === 'account_links') return { data: links[filters.user_id] ? { group_id: links[filters.user_id] } : null }
          if (table === 'fund_settings') return { data: { allow_linked_sign_ins: !(opts.noLinking ?? []).includes(filters.fund_id) } }
          return { data: null }
        },
        then: (r: any) => r({ data: table === 'account_links' ? Object.entries(links).filter(([, g]) => g === filters.group_id).map(([user_id]) => ({ user_id })) : [], error: null }),
      }
      return chain
    },
  } as any
}

afterEach(() => { delete process.env.MASTER_ADMIN_EMAILS })

describe('masterAdminEmails', () => {
  it('splits, trims, lower-cases and dedupes', () => {
    expect(masterAdminEmails(' A@x.com, b@y.com;a@X.com\nnot-an-email ')).toEqual(['a@x.com', 'b@y.com'])
    expect(masterAdminEmails(undefined)).toEqual([])
  })
})

describe('masterAdminGroups', () => {
  it('splits pools on |, and treats a list without one as a single pool', () => {
    expect(masterAdminGroups('a@x.example, b@y.example')).toEqual([['a@x.example', 'b@y.example']])
    expect(masterAdminGroups('a@x.example,b@y.example | c@x.example,d@y.example')).toEqual([
      ['a@x.example', 'b@y.example'],
      ['c@x.example', 'd@y.example'],
    ])
  })

  it('drops a pool of fewer than two addresses', () => {
    expect(masterAdminGroups('a@x.example | c@x.example,d@y.example')).toEqual([['c@x.example', 'd@y.example']])
    expect(masterAdminGroups(undefined)).toEqual([])
  })
})

describe('poolFunds', () => {
  it('keeps one acting admin per fund, chosen stably by email', () => {
    const funds = poolFunds([...ROWS, { user_id: 'u-a', email: 'a@northwind.example', fund_id: 'f-nw', fund_name: 'Northwind Holdings' }])
    expect(funds.map(f => [f.fundName, f.email])).toEqual([
      ['Northwind Holdings', 'a@northwind.example'],
      ['Riverbend Capital', 't@riverbend.example'],
    ])
  })

  it('prefers an admin over a plain member when two listed addresses share a fund', () => {
    const funds = poolFunds([
      { ...ROWS[0], role: 'member' },
      { user_id: 'u-z', email: 'z@northwind.example', fund_id: 'f-nw', fund_name: 'Northwind Holdings', role: 'admin' },
    ])
    expect(funds.map(f => f.email)).toEqual(['z@northwind.example'])
  })
})

describe('loadPool', () => {
  const owner = { userId: 'u-rb', fundId: 'f-rb', clientId: 'claude' }

  it('is off when the variable lists fewer than two addresses', async () => {
    process.env.MASTER_ADMIN_EMAILS = 't@riverbend.example'
    expect(await loadPool(fakeAdmin(ROWS), owner)).toBeNull()
  })

  it('is off for an owner who is not a listed admin of their own fund', async () => {
    process.env.MASTER_ADMIN_EMAILS = 't@riverbend.example,t@northwind.example'
    expect(await loadPool(fakeAdmin(ROWS), { ...owner, userId: 'someone-else' })).toBeNull()
  })

  it('starts on the authorizing fund, then follows the stored choice', async () => {
    process.env.MASTER_ADMIN_EMAILS = 't@riverbend.example,t@northwind.example'
    expect((await loadPool(fakeAdmin(ROWS), owner))?.activeFundId).toBe('f-rb')
    expect((await loadPool(fakeAdmin(ROWS, 'f-nw'), owner))?.activeFundId).toBe('f-nw')
  })

  it('ignores a stored fund that has left the pool', async () => {
    process.env.MASTER_ADMIN_EMAILS = 't@riverbend.example,t@northwind.example'
    expect((await loadPool(fakeAdmin(ROWS, 'f-gone'), owner))?.activeFundId).toBe('f-rb')
  })

  it('pools a listed address that is a member but not an admin', async () => {
    process.env.MASTER_ADMIN_EMAILS = 't@riverbend.example,t@northwind.example'
    const rows = [{ ...ROWS[0], role: 'admin' }, { ...ROWS[1], role: 'member' }]
    const pool = await loadPool(fakeAdmin(rows), owner)
    expect(pool?.funds.map(f => f.fundId)).toEqual(['f-nw', 'f-rb'])
  })

  it('leaves out a fund with agent access switched off', async () => {
    process.env.MASTER_ADMIN_EMAILS = 't@riverbend.example,t@northwind.example,t@off.com'
    const rows = [...ROWS, { user_id: 'u-off', email: 't@off.com', fund_id: 'f-off', fund_name: 'Off Fund' }]
    const pool = await loadPool(fakeAdmin(rows), owner)
    expect(pool?.funds.map(f => f.fundId)).toEqual(['f-nw', 'f-rb'])
  })
})

describe('loadPool with several pools', () => {
  // Two people, each with their own address in both funds.
  const rows = [
    { user_id: 'u-jane-nw', email: 'jane@northwind.example', fund_id: 'f-nw', fund_name: 'Northwind Holdings', role: 'admin' },
    { user_id: 'u-jane-rb', email: 'jane@riverbend.example', fund_id: 'f-rb', fund_name: 'Riverbend Capital', role: 'admin' },
    { user_id: 'u-sam-nw', email: 'sam@northwind.example', fund_id: 'f-nw', fund_name: 'Northwind Holdings', role: 'member' },
    { user_id: 'u-sam-rb', email: 'sam@riverbend.example', fund_id: 'f-rb', fund_name: 'Riverbend Capital', role: 'member' },
  ]
  const env = 'jane@northwind.example,jane@riverbend.example | sam@northwind.example,sam@riverbend.example'

  it('acts in each fund as the connecting person\'s own address, not another pool\'s admin', async () => {
    process.env.MASTER_ADMIN_EMAILS = env
    const pool = await loadPool(fakeAdmin(rows), { userId: 'u-sam-rb', fundId: 'f-rb', clientId: 'claude' })
    expect(pool?.funds.map(f => f.email)).toEqual(['sam@northwind.example', 'sam@riverbend.example'])
  })

  it('keeps the other person on their own addresses', async () => {
    process.env.MASTER_ADMIN_EMAILS = env
    const pool = await loadPool(fakeAdmin(rows), { userId: 'u-jane-nw', fundId: 'f-nw', clientId: 'claude' })
    expect(pool?.funds.map(f => f.email)).toEqual(['jane@northwind.example', 'jane@riverbend.example'])
  })

  it('is off for an address in no pool', async () => {
    process.env.MASTER_ADMIN_EMAILS = env
    expect(await loadPool(fakeAdmin(rows), { userId: 'u-other', fundId: 'f-nw', clientId: 'claude' })).toBeNull()
  })
})

describe('matchFund', () => {
  const pool: MasterAdminPool = { homeUserId: 'u-rb', clientId: 'c', sessionId: '', activeFundId: 'f-rb', funds: poolFunds(ROWS) }

  it('matches by id, exact name or an unambiguous part', () => {
    expect((matchFund(pool, 'f-nw') as any).fundId).toBe('f-nw')
    expect((matchFund(pool, 'riverbend capital') as any).fundId).toBe('f-rb')
    expect((matchFund(pool, 'northwind') as any).fundId).toBe('f-nw')
  })

  it('refuses with the choices when nothing or too much matches', () => {
    expect(matchFund(pool, 'nope')).toMatch(/Choose from: Northwind Holdings, Riverbend Capital/)
    expect(matchFund(pool, 'd')).toMatch(/more than one fund/)
    expect(matchFund(pool, '')).toMatch(/Name the fund/)
  })
})

describe('loadPool with linked sign-ins', () => {
  const emails = { 'u-nw': 't@northwind.example', 'u-rb': 't@riverbend.example' }
  const links = { 'u-nw': 'g1', 'u-rb': 'g1' }

  it('pools linked sign-ins with no deployment variable at all', async () => {
    const pool = await loadPool(fakeAdmin(ROWS, null, { links, emails }), { userId: 'u-nw', fundId: 'f-nw', clientId: 'c1' })
    expect(pool?.funds.map(f => f.fundId)).toEqual(['f-nw', 'f-rb'])
  })

  it('leaves out a fund that does not allow linking', async () => {
    expect(await loadPool(fakeAdmin(ROWS, null, { links, emails, noLinking: ['f-rb'] }), { userId: 'u-nw', fundId: 'f-nw', clientId: 'c1' })).toBeNull()
  })

  it('gives no linked funds to a connection whose own fund refuses linking', async () => {
    expect(await loadPool(fakeAdmin(ROWS, null, { links, emails, noLinking: ['f-nw'] }), { userId: 'u-nw', fundId: 'f-nw', clientId: 'c1' })).toBeNull()
  })

  it('does nothing for a sign-in that is not linked', async () => {
    expect(await loadPool(fakeAdmin(ROWS, null, { emails }), { userId: 'u-nw', fundId: 'f-nw', clientId: 'c1' })).toBeNull()
  })
})

/** agent_active_funds as a table keyed on (user, client, session), for the per-conversation tests. */
function sessionAdmin(rows: unknown[]) {
  const stored = new Map<string, string>()
  const key = (f: Record<string, string>) => `${f.user_id}|${f.client_id}|${f.session_id}`
  const base = fakeAdmin(rows)
  return {
    ...base,
    stored,
    from: (table: string) => {
      if (table !== 'agent_active_funds') return base.from(table)
      const filters: Record<string, string> = {}
      const chain: any = {
        select: () => chain,
        eq: (col: string, val: string) => { filters[col] = val; return chain },
        maybeSingle: async () => ({ data: stored.has(key(filters)) ? { fund_id: stored.get(key(filters)) } : null, error: null }),
        upsert: async (row: Record<string, string>) => { stored.set(key(row), row.fund_id); return { error: null } },
      }
      return chain
    },
  } as any
}

describe('the active fund belongs to one conversation', () => {
  const owner = { userId: 'u-rb', fundId: 'f-rb', clientId: 'claude' }
  const LISTED = 't@riverbend.example,t@northwind.example'

  it('switching in one session leaves another session, and a new one, in the home fund', async () => {
    process.env.MASTER_ADMIN_EMAILS = LISTED
    const admin = sessionAdmin(ROWS)
    const a = (await loadPool(admin, { ...owner, sessionId: 'session-aaaa' }))!
    await setActiveFund(admin, a, 'f-nw')
    expect((await loadPool(admin, { ...owner, sessionId: 'session-aaaa' }))?.activeFundId).toBe('f-nw')
    expect((await loadPool(admin, { ...owner, sessionId: 'session-bbbb' }))?.activeFundId).toBe('f-rb')
    expect((await loadPool(admin, owner))?.activeFundId).toBe('f-rb')
  })

  it('keys a client that sends no session id on the shared row', async () => {
    process.env.MASTER_ADMIN_EMAILS = LISTED
    const admin = sessionAdmin(ROWS)
    const shared = (await loadPool(admin, owner))!
    expect(shared.sessionId).toBe('')
    await setActiveFund(admin, shared, 'f-nw')
    expect((await loadPool(admin, { ...owner, sessionId: null }))?.activeFundId).toBe('f-nw')
  })

  it('accepts only sane session ids', () => {
    expect(normalizeSessionId('mcps_abcdefgh')).toBe('mcps_abcdefgh')
    expect(normalizeSessionId('short')).toBe('')
    expect(normalizeSessionId('has a space in it')).toBe('')
    expect(normalizeSessionId(42)).toBe('')
  })
})

describe('activeFund on pooled writes', () => {
  const pool: MasterAdminPool = {
    homeUserId: 'u-rb', clientId: 'claude', sessionId: '', activeFundId: 'f-rb',
    funds: [
      { fundId: 'f-nw', fundName: 'Northwind Holdings', userId: 'u-nw', email: 't@northwind.example' },
      { fundId: 'f-rb', fundName: 'Riverbend Capital', userId: 'u-rb', email: 't@riverbend.example' },
    ],
  }

  it('passes a write naming the active fund, without the argument', () => {
    expect(checkActiveFundArgument(pool, { activeFund: 'Riverbend Capital', memo: 'x' })).toEqual({ args: { memo: 'x' } })
    expect(checkActiveFundArgument(pool, { activeFund: 'f-rb' })).toEqual({ args: {} })
  })

  it('refuses a write naming another fund, or none', () => {
    const other = checkActiveFundArgument(pool, { activeFund: 'Northwind' })
    expect('refusal' in other && other.refusal).toMatch(/active fund is Riverbend Capital/)
    const none = checkActiveFundArgument(pool, { memo: 'x' })
    expect('refusal' in none && none.refusal).toMatch(/pass activeFund/)
  })

  it('adds the argument to a write tool\'s schema as required', () => {
    const t = withActiveFundArgument({ name: 'post_entry', inputSchema: { type: 'object', properties: { memo: {} }, required: ['memo'] } })
    expect((t.inputSchema as any).required).toEqual(['memo', 'activeFund'])
    expect((t.inputSchema as any).properties.activeFund).toBeDefined()
  })
})
