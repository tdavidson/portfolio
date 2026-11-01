/**
 * Master admin over the agent connector: one Claude connection that works in several funds.
 *
 * One email is one fund, and that does not change. MASTER_ADMIN_EMAILS lists addresses whose
 * funds are pooled for the CONNECTOR ONLY: a connection authorized by any listed address can
 * switch (`use_fund`) into the fund of any other listed address that is a member there, and then
 * acts in that fund as that address — its role, its grants, its audit trail. Any role counts: the
 * list itself is the gate, and in each fund the connection can do only what that member can. The
 * web app never sees any of this.
 *
 *   MASTER_ADMIN_EMAILS=admin@fund-a.example,admin@fund-b.example
 *
 * Separate pools are separated by `|`, one per set of people, so each set keeps its own addresses
 * and so its own roles and grants in each fund. A connection joins the pool that lists its own
 * address, and never reaches a fund through another pool's addresses:
 *
 *   MASTER_ADMIN_EMAILS=jane@fund-a.example,jane@fund-b.example | sam@fund-a.example,sam@fund-b.example
 *
 * Unset (the default) is a deployment with no deployment-set pooling.
 *
 * LINKED SIGN-INS (lib/account-links.ts) pool the same way, set up by the person: someone who holds
 * a sign-in in several funds (an outside fund administrator, say) links them by entering a code
 * shown to one while signed in as the other. Each fund can switch linking off for its members
 * (fund_settings.allow_linked_sign_ins); a fund reached only through a link must allow it, and a
 * connection whose own fund refuses it gets no linked funds at all.
 *
 * WHO decides the pool is the deployment owner, through the host's environment. Nothing a fund
 * admin can do in Settings, and nothing in a request, adds an address to it.
 */
import { randomBytes } from 'node:crypto'
import type { SupabaseClient } from '@supabase/supabase-js'
import { agentApiEnabled } from '@/lib/oauth/enabled'
import { fundAllowsLinking, linkedEmails } from '@/lib/account-links'

export interface PoolFund {
  fundId: string
  fundName: string
  /** The listed address that is this fund's member, and so who the connection acts as there. */
  userId: string
  email: string
}

/** Set on a credential whose owner is in the pool. */
export interface MasterAdminPool {
  /** The user who authorized the connection, and the client it was for: the active fund's key. */
  homeUserId: string
  clientId: string
  /**
   * The conversation this request belongs to: the MCP session id the server issued at
   * `initialize` (app/api/accounting/mcp/route.ts), or '' for a client that sends none. The active
   * fund is stored per conversation, so switching in one chat never moves another chat's writes.
   */
  sessionId: string
  funds: PoolFund[]
  activeFundId: string
}

function parseEmails(raw: string): string[] {
  return [...new Set(raw.split(/[\s,;]+/).map(e => e.trim().toLowerCase()).filter(e => e.includes('@')))]
}

/** Every listed address, across all pools. */
export function masterAdminEmails(raw: string | undefined = process.env.MASTER_ADMIN_EMAILS): string[] {
  if (!raw) return []
  return parseEmails(raw)
}

/** The pools, split on `|`; a list with no `|` is one pool. Pools of fewer than two are dropped. */
export function masterAdminGroups(raw: string | undefined = process.env.MASTER_ADMIN_EMAILS): string[][] {
  if (!raw) return []
  return raw.split('|').map(parseEmails).filter(g => g.length >= 2)
}

/**
 * Pool funds, one per fund. If two listed addresses are both members of one fund, an admin acts
 * there ahead of a non-admin, then the first by email, so the choice is stable.
 */
export function poolFunds(rows: { user_id: string; email: string; fund_id: string; fund_name: string; role?: string }[]): PoolFund[] {
  const byFund = new Map<string, PoolFund>()
  const rank = (r: { role?: string }) => (r.role === undefined || r.role === 'admin' ? 0 : 1)
  for (const r of [...rows].sort((a, b) => rank(a) - rank(b) || a.email.localeCompare(b.email))) {
    if (!byFund.has(r.fund_id)) byFund.set(r.fund_id, { fundId: r.fund_id, fundName: r.fund_name, userId: r.user_id, email: r.email })
  }
  return [...byFund.values()].sort((a, b) => a.fundName.localeCompare(b.fundName))
}

/**
 * The pool this credential belongs to, or null when it isn't in one. A credential is in the pool
 * when its owner is a listed address acting for its own fund.
 */
export async function loadPool(
  admin: SupabaseClient,
  owner: { userId: string; fundId: string; clientId: string; sessionId?: string | null },
): Promise<MasterAdminPool | null> {
  const groups = masterAdminGroups()
  // Linked sign-ins (lib/account-links.ts): the same idea, set up by the person rather than the
  // deployment owner, and each fund may refuse it.
  const linked = await linkedEmails(admin, owner.userId)
  if (!groups.length && linked.length < 2) return null

  const { data, error } = await (admin as any).rpc('master_admin_pool', { p_emails: [...new Set([...groups.flat(), ...linked])] })
  if (error) {
    console.error('[master-admin] pool lookup failed:', error.message)
    return null
  }
  const rows = (data ?? []) as { user_id: string; email: string; fund_id: string; fund_name: string; role?: string }[]
  // The owner's pool is the first that lists their own address; only that pool's addresses count.
  const ownerEmail = rows.find(r => r.user_id === owner.userId)?.email
  const envGroup = ownerEmail ? groups.find(g => g.includes(ownerEmail)) ?? [] : []
  const linkedGroup = linked.length >= 2 && await fundAllowsLinking(admin, owner.fundId) ? linked : []
  const group = [...new Set([...envGroup, ...linkedGroup])]
  if (group.length < 2) return null
  const listed = poolFunds(rows.filter(r => group.includes(r.email)))
  if (!listed.some(f => f.userId === owner.userId && f.fundId === owner.fundId)) return null
  // A fund whose admin has agent access switched off stays out of reach, as it would for its own
  // connection. Filtering here (not refusing later) keeps a connection from switching into a fund
  // that then refuses every request, use_fund included. A fund reached only through a linked
  // sign-in must also allow linking.
  const enabled = await Promise.all(listed.map(async f => {
    if (f.fundId === owner.fundId) return true
    if (!(await agentApiEnabled(admin, f.fundId))) return false
    return envGroup.includes(f.email) || fundAllowsLinking(admin, f.fundId)
  }))
  const funds = listed.filter((_, i) => enabled[i])
  if (funds.length < 2) return null

  const sessionId = normalizeSessionId(owner.sessionId)
  const active = await storedActiveFund(admin, owner.userId, owner.clientId, sessionId)
  // A new conversation starts in the fund the connection was authorized for, whatever another
  // conversation on the same connection switched to.
  const activeFundId = active && funds.some(f => f.fundId === active) ? active : owner.fundId

  return { homeUserId: owner.userId, clientId: owner.clientId, sessionId, funds, activeFundId }
}

/** An MCP session id we accept as a key: visible ASCII, of a sane length. Anything else is ''. */
export function normalizeSessionId(raw: unknown): string {
  return typeof raw === 'string' && /^[\x21-\x7e]{8,128}$/.test(raw) ? raw : ''
}

/** A fresh MCP session id, issued at `initialize` to a pooled connection. */
export function newSessionId(): string {
  return `mcps_${randomBytes(24).toString('base64url')}`
}

/** Postgres' "undefined column": the session_id migration (20261101180000) isn't applied yet. */
const missingSessionColumn = (error: { code?: string; message?: string } | null | undefined) =>
  !!error && (error.code === '42703' || /session_id/.test(error.message ?? ''))

async function storedActiveFund(admin: SupabaseClient, userId: string, clientId: string, sessionId: string): Promise<string | null> {
  const read = (withSession: boolean) => {
    let q = (admin as any).from('agent_active_funds').select('fund_id').eq('user_id', userId).eq('client_id', clientId)
    if (withSession) q = q.eq('session_id', sessionId)
    return q.maybeSingle()
  }
  const { data, error } = await read(true)
  if (missingSessionColumn(error)) return (await read(false)).data?.fund_id ?? null
  return data?.fund_id ?? null
}

export function activeFund(pool: MasterAdminPool): PoolFund {
  return pool.funds.find(f => f.fundId === pool.activeFundId)!
}

/** Match a fund the model named, by id, exact name, or an unambiguous part of a name. */
export function matchFund(pool: MasterAdminPool, named: unknown): PoolFund | string {
  const q = typeof named === 'string' ? named.trim().toLowerCase() : ''
  if (!q) return `Name the fund. Choose from: ${pool.funds.map(f => f.fundName).join(', ')}.`
  const exact = pool.funds.find(f => f.fundId === q || f.fundName.toLowerCase() === q)
  if (exact) return exact
  const partial = pool.funds.filter(f => f.fundName.toLowerCase().includes(q))
  if (partial.length === 1) return partial[0]
  return partial.length
    ? `"${named}" matches more than one fund: ${partial.map(f => f.fundName).join(', ')}. Name one exactly.`
    : `No fund named "${named}" in this connection. Choose from: ${pool.funds.map(f => f.fundName).join(', ')}.`
}

export async function setActiveFund(admin: SupabaseClient, pool: MasterAdminPool, fundId: string): Promise<void> {
  const row = { user_id: pool.homeUserId, client_id: pool.clientId, fund_id: fundId, updated_at: new Date().toISOString() }
  let { error } = await (admin as any)
    .from('agent_active_funds')
    .upsert({ ...row, session_id: pool.sessionId }, { onConflict: 'user_id,client_id,session_id' })
  // Before the migration: the one row per connection, as it was.
  if (missingSessionColumn(error)) ({ error } = await (admin as any).from('agent_active_funds').upsert(row, { onConflict: 'user_id,client_id' }))
  if (error) throw new Error(`Could not switch fund: ${error.message}`)
}

/**
 * The argument every write tool takes on a pooled connection: the fund the model believes it is
 * working in. A write naming any other fund is refused, so a stale belief (a switch the model
 * missed) costs a retry, never a change in the wrong fund.
 */
export const ACTIVE_FUND_ARG = 'activeFund'

const ACTIVE_FUND_PROPERTY = {
  type: 'string',
  description:
    'The fund this change is for: the active fund, by name or id, as list_funds or use_fund last reported it. ' +
    'Refused if a different fund is active, so nothing lands in the wrong fund.',
}

/** A tool's listing with the activeFund argument added and required (write tools only). */
export function withActiveFundArgument(tool: Record<string, unknown>): Record<string, unknown> {
  const schema = (tool.inputSchema ?? { type: 'object', properties: {} }) as { properties?: Record<string, unknown>; required?: string[] }
  return {
    ...tool,
    inputSchema: {
      ...schema,
      properties: { ...(schema.properties ?? {}), [ACTIVE_FUND_ARG]: ACTIVE_FUND_PROPERTY },
      required: [...new Set([...(schema.required ?? []), ACTIVE_FUND_ARG])],
    },
  }
}

/**
 * Check a pooled write's activeFund against the fund that is actually active. Returns the
 * arguments without it (the tool itself never sees it), or the refusal.
 */
export function checkActiveFundArgument(
  pool: MasterAdminPool,
  args: Record<string, unknown>,
): { args: Record<string, unknown> } | { refusal: string } {
  const { [ACTIVE_FUND_ARG]: named, ...rest } = args
  const active = activeFund(pool)
  if (named === undefined || named === null || named === '') {
    return { refusal: `This connection works in several funds. Say which one this change is for: pass ${ACTIVE_FUND_ARG} (the active fund is ${active.fundName}). Nothing was changed.` }
  }
  const match = matchFund(pool, named)
  if (typeof match === 'string') return { refusal: `${match} Nothing was changed.` }
  if (match.fundId !== active.fundId) {
    return {
      refusal:
        `${ACTIVE_FUND_ARG} names ${match.fundName}, but the active fund is ${active.fundName}. Nothing was changed. ` +
        `If the change is for ${match.fundName}, call use_fund first; otherwise retry with ${ACTIVE_FUND_ARG}: "${active.fundName}".`,
    }
  }
  return { args: rest }
}

export const LIST_FUNDS = 'list_funds'
export const USE_FUND = 'use_fund'

/** The two tools a pooled connection gets, listed beside the rest. */
export const MASTER_ADMIN_TOOLS = [
  {
    name: LIST_FUNDS,
    description:
      'The funds this connection can work in, and which one is active now. Every other tool acts on the active fund only. ' +
      'Call this at the start of a conversation and whenever the person mentions a fund by name.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    annotations: { readOnlyHint: true },
  },
  {
    name: USE_FUND,
    description:
      'Switch the active fund for this conversation. Every tool call after this one reads and writes that fund until you switch again; ' +
      'other conversations on the same connection keep their own. ' +
      'Say which fund you switched to before doing anything else in it, and switch back explicitly when the work moves on.',
    inputSchema: {
      type: 'object',
      properties: { fund: { type: 'string', description: 'The fund name (or its id) from list_funds.' } },
      required: ['fund'],
      additionalProperties: false,
    },
  },
]
