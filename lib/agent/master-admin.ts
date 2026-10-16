/**
 * Master admin over the agent connector: one Claude connection that works in several funds.
 *
 * One email is one fund, and that does not change. MASTER_ADMIN_EMAILS lists addresses whose
 * funds are pooled for the CONNECTOR ONLY: a connection authorized by any listed address can
 * switch (`use_fund`) into the fund of any other listed address that is an admin there, and then
 * acts in that fund as that address — its role, its grants, its audit trail. The web app never
 * sees any of this.
 *
 *   MASTER_ADMIN_EMAILS=taylor@laconiacapitalgroup.com,taylor@3seholdings.com
 *
 * Unset (the default) is a deployment with no pooling at all: every function here returns the
 * credential unchanged.
 *
 * WHO decides the pool is the deployment owner, through the host's environment. Nothing a fund
 * admin can do in Settings, and nothing in a request, adds an address to it.
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import { agentApiEnabled } from '@/lib/oauth/enabled'

export interface PoolFund {
  fundId: string
  fundName: string
  /** The listed address that is this fund's admin, and so who the connection acts as there. */
  userId: string
  email: string
}

/** Set on a credential whose owner is in the pool. */
export interface MasterAdminPool {
  /** The user who authorized the connection, and the client it was for: the active fund's key. */
  homeUserId: string
  clientId: string
  funds: PoolFund[]
  activeFundId: string
}

export function masterAdminEmails(raw: string | undefined = process.env.MASTER_ADMIN_EMAILS): string[] {
  if (!raw) return []
  return [...new Set(raw.split(/[\s,;]+/).map(e => e.trim().toLowerCase()).filter(e => e.includes('@')))]
}

/**
 * Pool funds, one per fund. If two listed addresses both administer one fund, the first by email
 * acts there, so the choice is stable.
 */
export function poolFunds(rows: { user_id: string; email: string; fund_id: string; fund_name: string }[]): PoolFund[] {
  const byFund = new Map<string, PoolFund>()
  for (const r of [...rows].sort((a, b) => a.email.localeCompare(b.email))) {
    if (!byFund.has(r.fund_id)) byFund.set(r.fund_id, { fundId: r.fund_id, fundName: r.fund_name, userId: r.user_id, email: r.email })
  }
  return [...byFund.values()].sort((a, b) => a.fundName.localeCompare(b.fundName))
}

/**
 * The pool this credential belongs to, or null when it isn't in one. A credential is in the pool
 * when its owner is a listed address administering its own fund, so a listed address that is only
 * a member somewhere reaches nothing extra.
 */
export async function loadPool(
  admin: SupabaseClient,
  owner: { userId: string; fundId: string; clientId: string },
): Promise<MasterAdminPool | null> {
  const emails = masterAdminEmails()
  if (emails.length < 2) return null

  const { data, error } = await (admin as any).rpc('master_admin_pool', { p_emails: emails })
  if (error) {
    console.error('[master-admin] pool lookup failed:', error.message)
    return null
  }
  const listed = poolFunds((data ?? []) as any[])
  if (!listed.some(f => f.userId === owner.userId && f.fundId === owner.fundId)) return null
  // A fund whose admin has agent access switched off stays out of reach, as it would for its own
  // connection. Filtering here (not refusing later) keeps a connection from switching into a fund
  // that then refuses every request, use_fund included.
  const enabled = await Promise.all(listed.map(f => f.fundId === owner.fundId ? true : agentApiEnabled(admin, f.fundId)))
  const funds = listed.filter((_, i) => enabled[i])
  if (funds.length < 2) return null

  const { data: active } = await (admin as any)
    .from('agent_active_funds')
    .select('fund_id')
    .eq('user_id', owner.userId)
    .eq('client_id', owner.clientId)
    .maybeSingle()
  const activeFundId = funds.some(f => f.fundId === active?.fund_id) ? active.fund_id : owner.fundId

  return { homeUserId: owner.userId, clientId: owner.clientId, funds, activeFundId }
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
  const { error } = await (admin as any)
    .from('agent_active_funds')
    .upsert(
      { user_id: pool.homeUserId, client_id: pool.clientId, fund_id: fundId, updated_at: new Date().toISOString() },
      { onConflict: 'user_id,client_id' },
    )
  if (error) throw new Error(`Could not switch fund: ${error.message}`)
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
      'Switch the active fund. Every tool call after this one reads and writes that fund until you switch again. ' +
      'Say which fund you switched to before doing anything else in it, and switch back explicitly when the work moves on.',
    inputSchema: {
      type: 'object',
      properties: { fund: { type: 'string', description: 'The fund name (or its id) from list_funds.' } },
      required: ['fund'],
      additionalProperties: false,
    },
  },
]
