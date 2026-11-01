import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * Linked sign-ins (lib/account-links.ts): the code that proves one person holds both sign-ins, and
 * how links join. The pool they feed is pinned in lib/agent/master-admin.test.ts.
 */

import { confirmLinkRequest, declineLinkRequest, hashLinkCode, newLinkCode, redeemLinkCode, MAX_LINKED } from './account-links'

type Code = { user_id: string; expires_at: string; redeemed_by?: string | null }

/** An in-memory account_links / account_link_codes pair. */
function fakeDb(init: { links?: Record<string, string>; codes?: Record<string, Code> } = {}) {
  const links: Record<string, string> = { ...(init.links ?? {}) }
  const codes: Record<string, Code> = Object.fromEntries(Object.entries(init.codes ?? {}).map(([k, v]) => [k, { ...v }]))
  const from = (table: string) => {
    const f: Record<string, any> = {}
    let patch: Partial<Code> | null = null
    const codeRows = () => Object.entries(codes).filter(([k, r]) =>
      (f.code_hash === undefined || k === f.code_hash) && (f.user_id === undefined || r.user_id === f.user_id)
      && (f.redeemedNull === undefined || (f.redeemedNull ? !r.redeemed_by : !!r.redeemed_by)))
    const chain: any = {
      select: () => chain,
      eq: (c: string, v: string) => { f[c] = v; return chain },
      is: (_c: string, _v: null) => { f.redeemedNull = true; return chain },
      not: () => { f.redeemedNull = false; return chain },
      update: (u: Partial<Code>) => { patch = u; return chain },
      delete: () => ({ eq: async (c: string, v: string) => {
        if (table === 'account_link_codes') for (const [k, r] of Object.entries(codes)) { if ((c === 'code_hash' && k === v) || (c === 'user_id' && r.user_id === v)) delete codes[k] }
        if (table === 'account_links' && c === 'user_id') delete links[v]
        return { error: null }
      } }),
      upsert: async (rows: { user_id: string; group_id: string }[]) => { for (const r of rows) links[r.user_id] = r.group_id; return { error: null } },
      maybeSingle: async () => {
        if (table === 'account_link_codes') {
          const [hit] = codeRows()
          return { data: hit ? { code_hash: hit[0], ...hit[1] } : null, error: null }
        }
        if (table === 'account_links') return { data: links[f.user_id] ? { group_id: links[f.user_id] } : null, error: null }
        return { data: null, error: null }
      },
      then: (r: any) => {
        if (table === 'account_link_codes' && patch) {
          const hits = codeRows()
          for (const [, row] of hits) Object.assign(row, patch)
          return r({ data: hits.map(([k]) => ({ code_hash: k })), error: null })
        }
        return r({ data: Object.entries(links).filter(([, g]) => g === f.group_id).map(([user_id]) => ({ user_id })), error: null })
      },
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

  it('draws each character uniformly from the whole alphabet', () => {
    const seen: number[] = []
    newLinkCode(n => { seen.push(n); return n - 1 })
    expect(seen).toEqual(Array(8).fill(31))
  })

  it('matches however it is typed', () => {
    expect(hashLinkCode('abcd-efgh')).toBe(hashLinkCode(' ABCD EFGH '))
  })
})

describe('linking', () => {
  const entered = async (db: ReturnType<typeof fakeDb>, by: string, code = 'aaaa-bbbb') => redeemLinkCode(db.admin, by, code)

  it('entering a code links nothing until the sign-in that showed it confirms', async () => {
    const db = fakeDb({ codes: { [hashLinkCode('AAAA-BBBB')]: { user_id: 'a', expires_at: later() } } })
    expect(await entered(db, 'b')).toMatchObject({ ok: true, value: { pending: true, otherUserId: 'a' } })
    expect(db.links).toEqual({})
    expect(await confirmLinkRequest(db.admin, 'a')).toMatchObject({ ok: true, value: { linked: 2, otherUserId: 'b' } })
    expect(db.links.a).toBe(db.links.b)
  })

  it('a code is entered once: a second sign-in gets nothing, and cannot take over the request', async () => {
    const db = fakeDb({ codes: { [hashLinkCode('AAAA-BBBB')]: { user_id: 'a', expires_at: later() } } })
    await entered(db, 'b')
    expect(await entered(db, 'c')).toMatchObject({ ok: false, status: 400 })
    await confirmLinkRequest(db.admin, 'a')
    expect(db.links.c).toBeUndefined()
  })

  it('declining drops the request', async () => {
    const db = fakeDb({ codes: { [hashLinkCode('AAAA-BBBB')]: { user_id: 'a', expires_at: later() } } })
    await entered(db, 'b')
    expect(await declineLinkRequest(db.admin, 'a')).toMatchObject({ ok: true })
    expect(await confirmLinkRequest(db.admin, 'a')).toMatchObject({ ok: false, status: 400 })
    expect(db.links).toEqual({})
  })

  it('only the sign-in that showed the code can confirm it', async () => {
    const db = fakeDb({ codes: { [hashLinkCode('AAAA-BBBB')]: { user_id: 'a', expires_at: later() } } })
    await entered(db, 'b')
    expect(await confirmLinkRequest(db.admin, 'b')).toMatchObject({ ok: false, status: 400 })
    expect(db.links).toEqual({})
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
    await entered(db, 'c')
    expect(await confirmLinkRequest(db.admin, 'a')).toMatchObject({ ok: true, value: { linked: 3 } })
    expect(new Set(Object.values(db.links))).toEqual(new Set(['g1']))
  })

  it(`stops at ${MAX_LINKED} sign-ins`, async () => {
    const links = Object.fromEntries(Array.from({ length: MAX_LINKED }, (_, i) => [`u${i}`, 'g1']))
    const db = fakeDb({ links, codes: { [hashLinkCode('AAAA-BBBB')]: { user_id: 'u0', expires_at: later() } } })
    await entered(db, 'new')
    expect(await confirmLinkRequest(db.admin, 'u0')).toMatchObject({ ok: false, status: 400 })
  })
})

describe('the route', () => {
  it('meters entering a code per sign-in and per address, and emails both addresses at each step', () => {
    const src = readFileSync(join(__dirname, '..', 'app/api/account/links/route.ts'), 'utf8')
    expect(src).toContain('account-link:${c.userId}')
    expect(src).toContain('account-link-ip:${getClientIp(req)}')
    expect(src).toContain("sendLinkNotice(c.admin, 'requested'")
    expect(src).toContain("sendLinkNotice(c.admin, 'linked'")
  })

  it('keeps the redeemer on the code row, service role only, and turns linking off for new funds', () => {
    const sql = readFileSync(join(__dirname, '..', 'supabase/migrations/20261101200000_account_link_confirmation.sql'), 'utf8')
    expect(sql).toContain('add column if not exists redeemed_by uuid')
    expect(sql).toContain('revoke all on public.account_link_codes from anon, authenticated;')
    expect(sql).toContain('alter column allow_linked_sign_ins set default false')
    expect(sql).toContain('select public.grant_fund_settings_member_columns();')
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
