// Linked sign-ins (20261101160000_linked_sign_ins.sql): one person who works for several funds on
// this deployment links the sign-in they hold in each, so one assistant connection switches between
// those funds (lib/agent/master-admin.ts). It acts in each fund as that fund's own member, so a
// link never widens anyone's access in any fund.
//
// Proof: a code is shown to one sign-in and entered while signed in as the other, so only someone
// who controls both can link them. Codes are single-use, last ten minutes, and stored hashed.
// Each fund may switch linking off for its members (fund_settings.allow_linked_sign_ins); the
// connection then never switches into that fund.

import crypto from 'node:crypto'
import type { SupabaseClient } from '@supabase/supabase-js'
import { done, fail, dbFail, type Outcome } from '@/lib/service-outcome'

export const LINK_CODE_MINUTES = 10
export const MAX_LINKED = 12
// No 0/O, 1/I/L: read off one screen and typed into another.
const ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'

export function newLinkCode(bytes: Buffer = crypto.randomBytes(8)): string {
  const chars = [...bytes].map(b => ALPHABET[b % ALPHABET.length]).join('')
  return `${chars.slice(0, 4)}-${chars.slice(4, 8)}`
}

/** The hash a code is stored and looked up by: case, spaces and the dash don't matter. */
export function hashLinkCode(code: string): string {
  const norm = code.toUpperCase().replace(/[^A-Z0-9]/g, '')
  return crypto.createHash('sha256').update(norm).digest('hex')
}

export interface LinkedSignIn {
  userId: string
  email: string | null
  fundId: string | null
  fundName: string | null
  /** The fund lets its members' sign-ins be linked. */
  allowed: boolean
  isYou: boolean
}

/** A fresh code for this sign-in. Any earlier one stops working. */
export async function createLinkCode(admin: SupabaseClient, userId: string): Promise<Outcome<{ code: string; expiresAt: string }>> {
  const db = admin as any
  await db.from('account_link_codes').delete().eq('user_id', userId)
  const code = newLinkCode()
  const expiresAt = new Date(Date.now() + LINK_CODE_MINUTES * 60_000).toISOString()
  const { error } = await db.from('account_link_codes').insert({ code_hash: hashLinkCode(code), user_id: userId, expires_at: expiresAt })
  if (error) return dbFail(error, 'account-links.code')
  return done({ code, expiresAt })
}

async function groupOf(db: any, userId: string): Promise<string | null> {
  const { data } = await db.from('account_links').select('group_id').eq('user_id', userId).maybeSingle()
  return data?.group_id ?? null
}

async function members(db: any, groupId: string): Promise<string[]> {
  const { data } = await db.from('account_links').select('user_id').eq('group_id', groupId)
  return ((data ?? []) as { user_id: string }[]).map(r => r.user_id)
}

/**
 * Link this sign-in with the one that showed the code. Joins whatever either was already linked
 * to, so linking C to B, where B is linked to A, links all three.
 */
export async function redeemLinkCode(admin: SupabaseClient, userId: string, code: unknown): Promise<Outcome<{ linked: number }>> {
  const db = admin as any
  if (typeof code !== 'string' || code.replace(/[^A-Za-z0-9]/g, '').length !== 8) return fail(400, 'Enter the 8-character code from your other sign-in.')
  const hash = hashLinkCode(code)
  const { data: row, error } = await db.from('account_link_codes').select('user_id, expires_at').eq('code_hash', hash).maybeSingle()
  if (error) return dbFail(error, 'account-links.redeem')
  if (!row || new Date(row.expires_at).getTime() < Date.now()) return fail(400, 'That code is wrong or has expired. Get a new one from your other sign-in.')
  if (row.user_id === userId) return fail(400, 'That code is for this sign-in. Enter it while signed in as your other one.')
  await db.from('account_link_codes').delete().eq('code_hash', hash)

  const [theirs, mine] = await Promise.all([groupOf(db, row.user_id), groupOf(db, userId)])
  const group = theirs ?? mine ?? crypto.randomUUID()
  const everyone = new Set<string>([row.user_id, userId])
  if (theirs) for (const u of await members(db, theirs)) everyone.add(u)
  if (mine) for (const u of await members(db, mine)) everyone.add(u)
  if (everyone.size > MAX_LINKED) return fail(400, `You can link up to ${MAX_LINKED} sign-ins.`)

  const { error: upErr } = await db.from('account_links').upsert(
    [...everyone].map(u => ({ user_id: u, group_id: group })),
    { onConflict: 'user_id' },
  )
  if (upErr) return dbFail(upErr, 'account-links.link')
  return done({ linked: everyone.size })
}

/** Take this sign-in out of its links. A lone sign-in left behind is unlinked too. */
export async function unlinkSignIn(admin: SupabaseClient, userId: string): Promise<Outcome<{ unlinked: true }>> {
  const db = admin as any
  const group = await groupOf(db, userId)
  if (!group) return done({ unlinked: true })
  const { error } = await db.from('account_links').delete().eq('user_id', userId)
  if (error) return dbFail(error, 'account-links.unlink')
  const left = await members(db, group)
  if (left.length === 1) await db.from('account_links').delete().eq('user_id', left[0])
  return done({ unlinked: true })
}

/** Every sign-in linked with this one, this one included, with its fund. Empty when unlinked. */
export async function linkedSignIns(admin: SupabaseClient, userId: string): Promise<LinkedSignIn[]> {
  const db = admin as any
  const group = await groupOf(db, userId)
  if (!group) return []
  const ids = await members(db, group)
  const { data: ms } = await db.from('fund_members').select('user_id, fund_id').in('user_id', ids)
  const fundOf = new Map(((ms ?? []) as { user_id: string; fund_id: string }[]).map(m => [m.user_id, m.fund_id]))
  const fundIds = [...new Set(fundOf.values())]
  const [{ data: funds }, { data: settings }] = fundIds.length
    ? await Promise.all([
        db.from('funds').select('id, name').in('id', fundIds),
        db.from('fund_settings').select('fund_id, allow_linked_sign_ins').in('fund_id', fundIds),
      ])
    : [{ data: [] }, { data: [] }]
  const names = new Map(((funds ?? []) as { id: string; name: string }[]).map(f => [f.id, f.name]))
  const allows = new Map(((settings ?? []) as { fund_id: string; allow_linked_sign_ins: boolean | null }[]).map(s => [s.fund_id, s.allow_linked_sign_ins !== false]))
  const out = await Promise.all(ids.map(async id => {
    const { data } = await admin.auth.admin.getUserById(id)
    const fundId = fundOf.get(id) ?? null
    return {
      userId: id, email: data?.user?.email?.toLowerCase() ?? null, fundId,
      fundName: fundId ? names.get(fundId) ?? null : null,
      allowed: fundId ? allows.get(fundId) ?? true : false,
      isYou: id === userId,
    }
  }))
  return out.sort((a, b) => Number(b.isYou) - Number(a.isYou) || (a.fundName ?? '').localeCompare(b.fundName ?? ''))
}

/** Does this fund let its members' sign-ins be linked? */
export async function fundAllowsLinking(admin: SupabaseClient, fundId: string): Promise<boolean> {
  const { data } = await (admin as any).from('fund_settings').select('allow_linked_sign_ins').eq('fund_id', fundId).maybeSingle()
  return data?.allow_linked_sign_ins !== false
}

/** The emails of every sign-in linked with this one, this one included. Empty when unlinked. */
export async function linkedEmails(admin: SupabaseClient, userId: string): Promise<string[]> {
  const db = admin as any
  const group = await groupOf(db, userId)
  if (!group) return []
  const ids = await members(db, group)
  const emails = await Promise.all(ids.map(async id => (await admin.auth.admin.getUserById(id)).data?.user?.email?.toLowerCase() ?? null))
  return emails.filter((e): e is string => !!e)
}
