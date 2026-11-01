import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * Linked sign-ins (lib/account-links.ts): the code that proves one person holds both sign-ins, and
 * how links join. The pool they feed is pinned in lib/agent/master-admin.test.ts.
 */

import { hashLinkCode, newLinkCode, redeemLinkCode, MAX_LINKED } from './account-links'

/** An in-memory account_links / account_link_codes pair. */
function fakeDb(init: { links?: Record<string, string>; codes?: Record<string, { user_id: string; expires_at: string }> } = {}) {
  const links: Record<string, string> = { ...(init.links ?? {}) }
  const codes = { ...(init.codes ?? {}) }
  const from = (table: string) => {
    const f: Record<string, string> = {}
    const chain: any = {
      select: () => chain,
      eq: (c: string, v: string) => { f[c] = v; return chain },
      delete: () => ({ eq: async (c: string, v: string) => {
        if (table === 'account_link_codes') for (const [k, r] of Object.entries(codes)) { if ((c === 'code_hash' && k === v) || (c === 'user_id' && r.user_id === v)) delete codes[k] }
        if (table === 'account_links' && c === 'user_id') delete links[v]
        return { error: null }
      } }),
      upsert: async (rows: { user_id: string; group_id: string }[]) => { for (const r of rows) links[r.user_id] = r.group_id; return { error: null } },
      maybeSingle: async () => {
        if (table === 'account_link_codes') return { data: codes[f.code_hash] ?? null, error: null }
        if (table === 'account_links') return { data: links[f.user_id] ? { group_id: links[f.user_id] } : null, error: null }
        return { data: null, error: null }
      },
      then: (r: any) => r({ data: Object.entries(links).filter(([, g]) => g === f.group_id).map(([user_id]) => ({ user_id })), error: null }),
    }
    return chain
  }
  return { admin: { from } as any, links, codes }
}

const later = () => new Date(Date.now() + 60_000).toISOString()

describe('link codes', () => {
  it('reads cleanly: eight characters with no 0, O, 1, I or L', () => {
    for (let i = 0; i < 50; i++) expect(newLinkCode()).toMatch(/^[A-HJKMNP-Z2-9]{4}-[A-HJKMNP-Z2-9]{4}$/)
  })

  it('matches however it is typed', () => {
    expect(hashLinkCode('abcd-efgh')).toBe(hashLinkCode(' ABCD EFGH '))
  })
})

describe('linking', () => {
  it('links the sign-in that entered the code with the one that showed it, once', async () => {
    const db = fakeDb({ codes: { [hashLinkCode('AAAA-BBBB')]: { user_id: 'a', expires_at: later() } } })
    expect(await redeemLinkCode(db.admin, 'b', 'aaaa-bbbb')).toMatchObject({ ok: true, value: { linked: 2 } })
    expect(db.links.a).toBe(db.links.b)
    expect(await redeemLinkCode(db.admin, 'c', 'AAAA-BBBB')).toMatchObject({ ok: false, status: 400 })
  })

  it('refuses an expired code, a wrong one, and a code entered by the sign-in that showed it', async () => {
    const past = new Date(Date.now() - 1000).toISOString()
    const db = fakeDb({ codes: { [hashLinkCode('AAAA-BBBB')]: { user_id: 'a', expires_at: past }, [hashLinkCode('CCCC-DDDD')]: { user_id: 'a', expires_at: later() } } })
    expect(await redeemLinkCode(db.admin, 'b', 'AAAA-BBBB')).toMatchObject({ ok: false })
    expect(await redeemLinkCode(db.admin, 'b', 'ZZZZ-ZZZZ')).toMatchObject({ ok: false })
    expect(await redeemLinkCode(db.admin, 'a', 'CCCC-DDDD')).toMatchObject({ ok: false })
    expect(db.links).toEqual({})
  })

  it('joins what either side was already linked to', async () => {
    const db = fakeDb({ links: { a: 'g1', b: 'g1', c: 'g2' }, codes: { [hashLinkCode('AAAA-BBBB')]: { user_id: 'a', expires_at: later() } } })
    expect(await redeemLinkCode(db.admin, 'c', 'AAAA-BBBB')).toMatchObject({ ok: true, value: { linked: 3 } })
    expect(new Set(Object.values(db.links))).toEqual(new Set(['g1']))
  })

  it(`stops at ${MAX_LINKED} sign-ins`, async () => {
    const links = Object.fromEntries(Array.from({ length: MAX_LINKED }, (_, i) => [`u${i}`, 'g1']))
    const db = fakeDb({ links, codes: { [hashLinkCode('AAAA-BBBB')]: { user_id: 'u0', expires_at: later() } } })
    expect(await redeemLinkCode(db.admin, 'new', 'AAAA-BBBB')).toMatchObject({ ok: false, status: 400 })
  })
})

describe('storage', () => {
  it('keeps codes hashed and both tables to the service role, and grants members the new setting', () => {
    const sql = readFileSync(join(__dirname, '..', 'supabase/migrations/20261101160000_linked_sign_ins.sql'), 'utf8')
    expect(sql).toContain('code_hash text primary key')
    for (const t of ['account_links', 'account_link_codes']) {
      expect(sql).toContain(`revoke all on public.${t} from anon, authenticated;`)
      expect(sql).toContain(`alter table public.${t} enable row level security;`)
    }
    expect(sql).toContain('select public.grant_fund_settings_member_columns();')
  })
})
