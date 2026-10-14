import { beforeEach, describe, expect, it, vi } from 'vitest'
import { NextRequest } from 'next/server'
import type { AccessContext, AccessLevel } from '@/lib/access/effective'
import type { Domain } from '@/lib/access/domains'
import { DEFAULT_FEATURE_VISIBILITY, type FeatureVisibilityMap } from '@/lib/types/features'
import { memoryAdmin } from './helpers/memory-admin'

/**
 * Writes from Claude/ChatGPT (MCP, OAuth) and from scripts (/api/agent, API keys) go through one
 * dispatcher (lib/agent/dispatch.ts): an assistant's write is staged until a person approves it, a
 * key's write applies at once, every write is audited with its source and credential, and a retry
 * under the same idempotency key does not write twice. The routes, authorization, staging and
 * approval are real; the database is in memory and the one write handler is a stand-in.
 */

let scopes = ['read', 'write']
let keyId = 'oauth:claude'
let access: AccessContext
let store: ReturnType<typeof memoryAdmin>
const addChartAccount = vi.fn(async (_a: unknown, _f: string, _g: string, input: any) => ({ account: { code: input.code, name: input.name } }))

vi.mock('@/lib/supabase/admin', () => ({ createAdminClient: () => store.admin }))
vi.mock('@/lib/oauth/enabled', () => ({ agentApiEnabled: async () => true }))
vi.mock('@/lib/rate-limit', () => ({ rateLimit: async () => null }))
const notifyAdmins = vi.fn(async () => 1)
vi.mock('@/lib/pending-actions/notify', () => ({ notifyAdminsOfStagedChange: (...args: any[]) => (notifyAdmins as any)(...args) }))
vi.mock('@/lib/accounting/chart-add', () => ({ addChartAccount: (...args: any[]) => (addChartAccount as any)(...args) }))
const addPartner = vi.fn(async () => ({ entityId: 'lp-1', commitmentId: 'c-1' }))
vi.mock('@/lib/accounting/add-partner', async importOriginal => ({
  ...(await importOriginal<typeof import('@/lib/accounting/add-partner')>()),
  addPartner: (...args: any[]) => (addPartner as any)(...args),
}))
vi.mock('@/lib/accounting/api-keys', async importOriginal => {
  const credential = (req: Request) =>
    req.headers.get('authorization') ? { fundId: 'fund-1', keyId, userId: 'user-me', role: access.role, scopes } : null
  return {
    ...(await importOriginal<typeof import('@/lib/accounting/api-keys')>()),
    resolveAgentAuth: async (_admin: unknown, req: Request) => credential(req),
    resolveFundFromApiKey: async (_admin: unknown, req: Request) => credential(req),
    loadCredentialAccess: async () => access,
  }
})

import { POST as mcpPost } from '@/app/api/mcp/route'
import { POST as agentPost } from '@/app/api/agent/route'
import { isDraftOnlyCall, shouldStage, auditInput, assistantDedupeKey, ASSISTANT_DEDUPE_WINDOW_MS } from '@/lib/agent/dispatch'
import { getTool } from '@/lib/accounting/agent-tools'
import { visibleTo } from '@/lib/audit/read'
import { recordAudit } from '@/lib/audit/events'
import { currentChangeSource, withChangeSource } from '@/lib/audit/source'

const member = (grants: Partial<Record<Domain, AccessLevel>>, role: 'admin' | 'member' | 'viewer' = 'member'): AccessContext => ({
  fundId: 'fund-1', userId: 'user-me', vehicles: { all: true, ids: [] }, role,
  features: Object.fromEntries(Object.keys(DEFAULT_FEATURE_VISIBILITY).map(k => [k, 'everyone'])) as FeatureVisibilityMap,
  grants, defaults: {},
})

async function callTool(name: string, args: Record<string, unknown>, meta?: Record<string, unknown>) {
  const res = await mcpPost(new NextRequest('https://fund.test/api/mcp', {
    method: 'POST',
    headers: { host: 'fund.test', 'content-type': 'application/json', authorization: 'Bearer mcp_at_test' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args, ...(meta ? { _meta: meta } : {}) } }),
  }))
  const body = await res.json()
  const result = body.result
  return { isError: !!result?.isError, text: result?.content?.[0]?.text as string, json: (() => { try { return JSON.parse(result?.content?.[0]?.text) } catch { return null } })() }
}

async function callAgent(tool: string, input: Record<string, unknown>, headers: Record<string, string> = {}) {
  const res = await agentPost(new NextRequest('https://fund.test/api/agent', {
    method: 'POST',
    headers: { host: 'fund.test', 'content-type': 'application/json', authorization: 'Bearer lk_test', ...headers },
    body: JSON.stringify({ tool, input }),
  }))
  return { status: res.status, body: await res.json() }
}

const audit = () => store.tables.accounting_audit_events ?? []

beforeEach(() => {
  scopes = ['read', 'write']
  keyId = 'oauth:claude'
  access = member({ accounting: 'write' })
  addChartAccount.mockClear()
  addPartner.mockClear()
  store = memoryAdmin({
    fund_members: [{ fund_id: 'fund-1', user_id: 'user-me', role: 'member' }],
    fund_vehicles: [{ id: 'v1', fund_id: 'fund-1', name: 'Fund I', active: true, kind: 'fund', aliases: null }],
    pending_actions: [],
    accounting_audit_events: [],
    api_idempotency_keys: [],
  }, { unique: [{ table: 'api_idempotency_keys', key: r => `${r.fund_id}|${r.client_id}|${r.endpoint}|${r.key}` }] })
})

describe('a chat assistant (OAuth over MCP)', () => {
  it('stages a write instead of applying it, and records who staged it from where', async () => {
    const out = await callTool('add_account', { code: '6100', name: 'Legal', type: 'expense' })
    expect(out.isError).toBe(false)
    expect(out.json).toMatchObject({ staged: true, summary: expect.stringContaining('add_account on Fund I') })
    expect(addChartAccount).not.toHaveBeenCalled()

    const [row] = store.tables.pending_actions
    expect(row).toMatchObject({
      action_type: 'agent_tool_call', domain: 'accounting', vehicle_id: 'v1', created_via: 'mcp', created_by: 'user-me',
      args: { tool: 'add_account', input: { code: '6100', name: 'Legal', type: 'expense', vehicle: 'Fund I' } },
    })
    expect(audit()).toEqual([expect.objectContaining({
      action: 'pending_action.stage', source: 'mcp', actor_id: 'user-me', subject_id: row.id,
      details: expect.objectContaining({ credentialId: 'oauth:claude' }),
    })])
  })

  it('names the app page where it can be approved, for a chat that has no approve_action tool', async () => {
    const out = await callTool('add_account', { code: '6100', name: 'Legal', type: 'expense' })
    const url = `${new URL(out.json.approveUrl).origin}/pending-actions`
    expect(out.json.approveUrl).toBe(url)
    expect(out.json.next).toContain(`approve it in the app at ${url}`)
  })

  it('emails nobody about a change the person can approve themselves', async () => {
    notifyAdmins.mockClear()
    await callTool('add_account', { code: '1999', name: 'Suspense', type: 'asset' })
    expect(notifyAdmins).not.toHaveBeenCalled()
  })

  it('applies the staged write when approved from chat, its own or another', async () => {
    const staged = await callTool('add_account', { code: '6100', name: 'Legal', type: 'expense' })
    expect(addChartAccount).not.toHaveBeenCalled()

    keyId = 'oauth:another-chat'
    const approved = await callTool('approve_action', { id: staged.json.pendingActionId })
    expect(approved.isError).toBe(false)
    expect(approved.json).toMatchObject({ applied: true, result: { tool: 'add_account', result: { code: '6100' } } })
    expect(addChartAccount).toHaveBeenCalledTimes(1)
    expect(store.tables.pending_actions[0].status).toBe('applied')
    expect(audit().map(e => [e.action, e.source])).toEqual([['pending_action.stage', 'mcp'], ['pending_action.approve', 'mcp']])
    expect(store.tables.pending_actions[0].created_credential).toBe('oauth:claude')

    // A second approval replays rather than writing twice.
    await callTool('approve_action', { id: staged.json.pendingActionId })
    expect(addChartAccount).toHaveBeenCalledTimes(1)
  })

  it('applies nothing when the person declines', async () => {
    const staged = await callTool('add_account', { code: '6100', name: 'Legal', type: 'expense' })
    const rejected = await callTool('reject_action', { id: staged.json.pendingActionId })
    expect(rejected.json).toMatchObject({ rejected: true })
    expect(addChartAccount).not.toHaveBeenCalled()
    expect(store.tables.pending_actions[0].status).toBe('rejected')
  })

  it('lists what is waiting', async () => {
    await callTool('add_account', { code: '6100', name: 'Legal', type: 'expense' })
    const listed = await callTool('list_pending_actions', {})
    expect(listed.json.actions).toEqual([expect.objectContaining({ actionType: 'agent_tool_call', stagedVia: 'mcp' })])
  })

  it('cannot approve on a read-only connection', async () => {
    const staged = await callTool('add_account', { code: '6100', name: 'Legal', type: 'expense' })
    scopes = ['read']
    const out = await callTool('approve_action', { id: staged.json.pendingActionId })
    expect(out.isError).toBe(true)
    expect(out.text).toMatch(/read-only/)
    expect(addChartAccount).not.toHaveBeenCalled()
  })

  it('approves only with the approver’s own write access to the change', async () => {
    const staged = await callTool('add_account', { code: '6100', name: 'Legal', type: 'expense' })
    access = member({ accounting: 'read' })
    keyId = 'oauth:another-chat'
    const out = await callTool('approve_action', { id: staged.json.pendingActionId })
    expect(out.isError).toBe(true)
    expect(out.text).toMatch(/write access/)
    expect(addChartAccount).not.toHaveBeenCalled()
  })

  it('is refused a write its owner has no grant for, as the web is', async () => {
    access = member({ accounting: 'read' })
    const out = await callTool('add_account', { code: '6100', name: 'Legal', type: 'expense' })
    expect(out.isError).toBe(true)
    expect(store.tables.pending_actions).toHaveLength(0)
  })
})

describe('a script (API key over /api/agent)', () => {
  beforeEach(() => { keyId = 'key-1' })

  it('applies the write at once and audits it with its source and key', async () => {
    const out = await callAgent('add_account', { code: '6100', name: 'Legal', type: 'expense' })
    expect(out.status).toBe(200)
    expect(out.body.result).toEqual({ code: '6100', name: 'Legal' })
    expect(addChartAccount).toHaveBeenCalledTimes(1)
    expect(store.tables.pending_actions).toHaveLength(0)
    expect(audit()).toEqual([expect.objectContaining({
      action: 'agent.write', source: 'api', actor_id: 'user-me', vehicle_id: 'v1', subject_id: 'add_account',
      details: expect.objectContaining({ tool: 'add_account', credentialId: 'key-1', domain: 'accounting' }),
    })])
  })

  it('does not write twice when a retry repeats its Idempotency-Key', async () => {
    const first = await callAgent('add_account', { code: '6100', name: 'Legal', type: 'expense' }, { 'idempotency-key': 'k1' })
    const retry = await callAgent('add_account', { code: '6100', name: 'Legal', type: 'expense' }, { 'idempotency-key': 'k1' })
    expect(retry.body.result).toEqual(first.body.result)
    expect(addChartAccount).toHaveBeenCalledTimes(1)

    const reused = await callAgent('add_account', { code: '6200', name: 'Audit', type: 'expense' }, { 'idempotency-key': 'k1' })
    expect(reused.status).toBe(400)
    expect(addChartAccount).toHaveBeenCalledTimes(1)
  })
})

describe('admin-only operations (lib/access/admin-only.ts)', () => {
  const partner = { name: 'New LP', partnerClass: 'limited', commitment: 1_000_000 }

  it('refuses a member’s API key outright: there is nobody to ask', async () => {
    keyId = 'key-1'
    const out = await callAgent('add_partner', partner)
    expect(out.status).toBe(403)
    expect(out.body).toMatchObject({ code: 'ADMIN_ONLY', error: 'Only an admin can add a partner and commitment.' })
    expect(addPartner).not.toHaveBeenCalled()
    expect(audit()).toEqual([])
  })

  it('applies an admin’s API key at once', async () => {
    keyId = 'key-1'
    access = member({}, 'admin')
    const out = await callAgent('add_partner', partner)
    expect(out.status).toBe(200)
    expect(addPartner).toHaveBeenCalledTimes(1)
  })

  it('lets a member propose one from chat, and says an admin must approve it', async () => {
    const staged = await callTool('add_partner', partner)
    expect(staged.json).toMatchObject({ staged: true, next: expect.stringMatching(/admins have been emailed/) })
    // The admin it waits on is not in this conversation, so they are told.
    expect(notifyAdmins).toHaveBeenCalledWith(store.admin, expect.objectContaining({ fundId: 'fund-1', label: 'add a partner and commitment', requesterId: 'user-me' }))

    const approved = await callTool('approve_action', { id: staged.json.pendingActionId })
    expect(approved.isError).toBe(true)
    expect(approved.text).toBe('Only an admin can add a partner and commitment.')
    expect(addPartner).not.toHaveBeenCalled()
    expect(store.tables.pending_actions[0].status).toBe('pending')

    // The member can still withdraw what they proposed.
    const rejected = await callTool('reject_action', { id: staged.json.pendingActionId })
    expect(rejected.json).toMatchObject({ rejected: true })
  })

  it('applies a member’s proposal once an admin approves it', async () => {
    const staged = await callTool('add_partner', partner)
    // The admin, from their own chat.
    access = member({}, 'admin')
    keyId = 'oauth:admin-chat'
    const approved = await callTool('approve_action', { id: staged.json.pendingActionId })
    expect(approved.isError).toBe(false)
    expect(addPartner).toHaveBeenCalledTimes(1)
  })
})

describe('MCP idempotency', () => {
  beforeEach(() => { keyId = 'key-1' })

  it('replays a retried call that names the same _meta.idempotencyKey', async () => {
    const a = await callTool('add_account', { code: '6100', name: 'Legal', type: 'expense' }, { idempotencyKey: 'abc' })
    const b = await callTool('add_account', { code: '6100', name: 'Legal', type: 'expense' }, { idempotencyKey: 'abc' })
    expect(b.json).toEqual(a.json)
    expect(addChartAccount).toHaveBeenCalledTimes(1)
  })
})

describe('an assistant asking for the same change twice (no idempotency key)', () => {
  // Two chats each staged the same carry reallocation and each was approved: booked twice. An
  // assistant's staged write without a key is now keyed by what it asks, for 24 hours.
  const legal = { code: '6100', name: 'Legal', type: 'expense' }
  const pending = () => store.tables.pending_actions

  it('replays the first pending action instead of staging a second', async () => {
    const first = await callTool('add_account', legal)
    const second = await callTool('add_account', { type: 'expense', name: 'Legal', code: '6100', vehicle: 'Fund I' })
    expect(second.json).toMatchObject({ staged: true, duplicate: true, status: 'pending', pendingActionId: first.json.pendingActionId })
    expect(second.json.next).toMatch(/already waiting for approval/)
    expect(pending()).toHaveLength(1)
  })

  it('is caught from a second assistant host too', async () => {
    const first = await callTool('add_account', legal)
    keyId = 'oauth:another-host'
    const second = await callTool('add_account', legal)
    expect(second.json.pendingActionId).toBe(first.json.pendingActionId)
    expect(pending()).toHaveLength(1)
  })

  it('says a repeat of an applied change is already done, and applies nothing', async () => {
    const first = await callTool('add_account', legal)
    // Approved from another chat of the same person.
    keyId = 'oauth:another-chat'
    await callTool('approve_action', { id: first.json.pendingActionId })
    keyId = 'oauth:claude'
    const again = await callTool('add_account', legal)
    expect(again.json).toMatchObject({ duplicate: true, status: 'applied', pendingActionId: first.json.pendingActionId })
    expect(again.json.next).toMatch(/Do NOT approve or send it again/)
    expect(pending()).toHaveLength(1)
    expect(addChartAccount).toHaveBeenCalledTimes(1)
  })

  it('stages afresh after the first was declined', async () => {
    const first = await callTool('add_account', legal)
    await callTool('reject_action', { id: first.json.pendingActionId })
    const again = await callTool('add_account', legal)
    expect(again.json.duplicate).toBeUndefined()
    expect(again.json.pendingActionId).not.toBe(first.json.pendingActionId)
    expect(pending()).toHaveLength(2)
  })

  it('treats a different change as a different request', async () => {
    await callTool('add_account', legal)
    await callTool('add_account', { ...legal, code: '6101' })
    expect(pending()).toHaveLength(2)
  })

  it('stages afresh once the window has passed', async () => {
    const first = await callTool('add_account', legal)
    for (const row of store.tables.api_idempotency_keys) row.created_at = new Date(Date.now() - ASSISTANT_DEDUPE_WINDOW_MS - 60_000).toISOString()
    const again = await callTool('add_account', legal)
    expect(again.json.pendingActionId).not.toBe(first.json.pendingActionId)
    expect(pending()).toHaveLength(2)
  })

  it('lets an explicit key win, so a deliberate second copy is possible', async () => {
    const first = await callTool('add_account', legal)
    const second = await callTool('add_account', legal, { idempotencyKey: 'second-on-purpose' })
    expect(second.json.duplicate).toBeUndefined()
    expect(second.json.pendingActionId).not.toBe(first.json.pendingActionId)
  })

  it('leaves calls that only make drafts or previews, and API keys, alone', async () => {
    const call = (name: string, input: Record<string, unknown>, k = 'oauth:claude') => ({
      admin: store.admin, tool: getTool(name)!, input, auth: { fundId: 'fund-1', keyId: k, userId: 'user-me', role: 'member', scopes } as any, access, channel: 'mcp' as const,
    })
    access = member({ accounting: 'write', lp_capital: 'write' }, 'admin')
    expect(await assistantDedupeKey(call('post_entry', { status: 'draft' }))).toBeNull()
    expect(await assistantDedupeKey(call('categorize_bank_transactions', {}))).toBeNull()
    expect(await assistantDedupeKey(call('allocation', { action: 'carry', post: false }))).toBeNull()
    expect(await assistantDedupeKey(call('add_account', legal, 'key-1'))).toBeNull()
    expect(await assistantDedupeKey(call('allocation', { action: 'carry' }))).toMatchObject({ key: expect.stringMatching(/^derived:user-me:/) })
  })
})

describe('what waits for approval', () => {
  const oauth = { keyId: 'oauth:x' }
  it('stages an assistant’s writes, never its reads or a key’s writes', () => {
    expect(shouldStage(getTool('add_account')!, {}, oauth)).toBe(true)
    expect(shouldStage(getTool('list_accounts')!, {}, oauth)).toBe(false)
    expect(shouldStage(getTool('add_account')!, {}, { keyId: 'key-1' })).toBe(false)
  })

  it('runs calls that only make drafts or previews directly', () => {
    expect(isDraftOnlyCall({ name: 'post_entry' }, { status: 'draft' })).toBe(true)
    expect(isDraftOnlyCall({ name: 'post_entry' }, {})).toBe(false)
    expect(isDraftOnlyCall({ name: 'allocation' }, { post: false })).toBe(true)
    expect(isDraftOnlyCall({ name: 'allocation' }, {})).toBe(false)
    expect(isDraftOnlyCall({ name: 'post_bank_transaction' }, {})).toBe(false)
  })

  it('keeps a huge input out of the trail', () => {
    expect(auditInput({ csv: 'x'.repeat(30_000) })).toEqual({ truncated: true, bytes: expect.any(Number) })
    expect(auditInput({ code: '6100' })).toEqual({ code: '6100' })
  })
})

describe('reading the trail', () => {
  it('shows an assistant’s write only to someone who may read what it touched', () => {
    const books = visibleTo(member({ accounting: 'read' }))
    const portfolio = visibleTo(member({ portfolio: 'read' }))
    const lps = visibleTo(member({ lp_capital: 'read' }))
    const event = { tool: 'add_partner', input: { name: 'Jane' } }
    expect(portfolio('agent.write', event)).toBe(false)
    expect(lps('agent.write', event)).toBe(true)
    // A carry allocation is GP economics, whoever can read the books.
    expect(books('agent.write', { tool: 'allocation', input: { action: 'carry' } })).toBe(false)
    expect(books('agent.write', { tool: 'no_such_tool', input: {} })).toBe(false)
  })

  it('gates a staged call by its tool', () => {
    const books = visibleTo(member({ accounting: 'read' }))
    const portfolio = visibleTo(member({ portfolio: 'read' }))
    const staged = (tool: string) => ({ actionType: 'agent_tool_call', args: { tool, input: {} } })
    expect(books('pending_action.stage', staged('add_account'))).toBe(true)
    expect(portfolio('pending_action.stage', staged('add_account'))).toBe(false)
    expect(portfolio('pending_action.stage', staged('record_investment'))).toBe(true)
    expect(books('pending_action.stage', staged('no_such_tool'))).toBe(false)
  })
})

describe('the source of a change', () => {
  it('is web outside any wrapper, and the wrapper’s inside one', async () => {
    expect(currentChangeSource()).toBe('web')
    await withChangeSource('api', async () => {
      await Promise.resolve()
      expect(currentChangeSource()).toBe('api')
    })
  })

  it('is written on every audit event, and kept in details when the column is not there yet', async () => {
    const base = { fundId: 'fund-1', actorId: 'u', action: 'entry.post' as const, subjectType: 'journal_entry' }
    await withChangeSource('mcp', () => recordAudit(store.admin, base))
    expect(audit()[0]).toMatchObject({ source: 'mcp' })

    store.failNext('accounting_audit_events', 'insert', 'column "source" does not exist')
    // memoryAdmin's failures carry only a message; give this one Postgres' code.
    const from = store.admin.from
    let first = true
    store.admin.from = (t: string) => {
      const q = from(t)
      if (t !== 'accounting_audit_events' || !first) return q
      first = false
      const insert = q.insert
      q.insert = (rows: any) => { const r = insert(rows); const then = r.then; r.then = (res: any, rej: any) => then((v: any) => res({ ...v, error: v.error && { ...v.error, code: '42703' } }), rej); return r }
      return q
    }
    await recordAudit(store.admin, base)
    store.admin.from = from
    expect(audit()[1]).toMatchObject({ details: { source: 'web' } })
    expect(audit()[1].source).toBeUndefined()
  })
})

describe('the same access rules as the web', () => {
  // Each agent write and the web route that makes the same change. The tool must ask at least
  // what the route asks: the same domain and the same feature switch. (A tool may ask MORE, as
  // `allocation` does for carry.)
  const PAIRS: [tool: string, route: string][] = [
    ['post_entry', 'api/accounting/journal'],
    ['post_drafts', 'api/accounting/journal'],
    ['discard_drafts', 'api/accounting/journal/bulk-void'],
    ['add_account', 'api/accounting/chart'],
    ['close_period', 'api/accounting/periods'],
    ['allocation', 'api/accounting/allocation'],
    ['post_bank_transaction', 'api/accounting/bank'],
    ['ignore_bank_transaction', 'api/accounting/bank'],
    ['import_bank_transactions', 'api/accounting/bank'],
    ['import_journal', 'api/accounting/quickbooks/import'],
    ['save_journal_mapping', 'api/accounting/quickbooks/mapping'],
    ['add_partner', 'api/accounting/commitments'],
    ['book_capital_call', 'api/accounting/capital-calls'],
    ['issue_capital_call', 'api/accounting/capital-calls'],
    ['record_investment', 'api/portfolio/investments'],
    ['update_investment', 'api/companies/[id]/investments/[txnId]'],
    ['delete_investment', 'api/companies/[id]/investments/[txnId]'],
    ['forecast_update_plan', 'api/accounting/forecast/[id]'],
    ['forecast_publish', 'api/accounting/forecast/[id]/publish'],
    ['portfolio_construction_update', 'api/accounting/construction'],
    ['lp_portal_invite', 'api/lps/invites'],
    ['lp_portal_account_status', 'api/lps/invites'],
    ['lp_portal_unlink', 'api/lps/invites'],
    ['lp_portal_resend_invite', 'api/lps/invites/resend'],
    ['lp_portal_invite_bulk', 'api/lps/invites/bulk'],
    ['lp_authorized_user_add', 'api/lps/authorized-users'],
    ['lp_authorized_user_remove', 'api/lps/authorized-users'],
    ['lp_announce', 'api/lps/announce'],
    ['lp_send_item', 'api/lps/send'],
    ['lp_portal_settings', 'api/settings'],
    ['lp_proposed_call_propose', 'api/accounting/proposed-calls'],
    ['lp_proposed_call_revise', 'api/accounting/proposed-calls'],
    ['lp_proposed_call_discard', 'api/accounting/proposed-calls'],
    ['lp_proposed_call_approve', 'api/accounting/proposed-calls'],

    // The destructive tools (AGENT_DESTRUCTIVE_ACTIONS), each the route whose lib function it calls.
    ['unpost_entry', 'api/accounting/journal'],
    ['reverse_entry', 'api/accounting/journal'],
    ['void_entry', 'api/accounting/journal'],
    ['reopen_period', 'api/accounting/periods'],
    ['delete_lp_positions', 'api/accounting/positions'],
    ['delete_company', 'api/companies/[id]'],
    ['lp_delete_investor', 'api/lps/investors'],
    ['lp_merge_investors', 'api/lps/investors'],
    ['lp_delete_entity', 'api/lps/entities'],
    ['lp_delete_commitment', 'api/accounting/commitments'],
    ['diligence_delete_deal', 'api/diligence/[id]'],
    ['remove_member', 'api/settings/members/[id]'],
    ['merge_vehicles', 'api/vehicles'],

    // Uploads: the signed URL and the register step, each like the page's own pair of calls.
    ['diligence_document_upload_url', 'api/diligence/[id]/documents/upload-url'],
    ['diligence_add_documents', 'api/diligence/[id]/documents'],
    ['company_document_upload_url', 'api/companies/[id]/documents'],
    ['add_company_document', 'api/companies/[id]/documents'],
    ['deals_deck_upload_url', 'api/deals/manual'],
    ['deals_create_inbound', 'api/deals/manual'],
    ['email_attachment_upload_url', 'api/emails/[id]/attachments'],
    ['add_email_attachment', 'api/emails/[id]/attachments'],
    ['lp_document_upload_url', 'api/lps/documents/upload-url'],
    ['lp_add_document', 'api/lps/documents'],
    // The server's model, as the web buttons.
    ['company_generate_summary', 'api/companies/[id]/summary'],
    ['portfolio_import_preview', 'api/import'],
  ]

  it.each(PAIRS)('%s is gated like %s', async (toolName, route) => {
    const { ROUTE_DOMAINS } = await import('@/lib/access/route-domains')
    const { accessDomainFor, accessFeatureFor } = await import('@/lib/accounting/agent-tools')
    const tool = getTool(toolName)!
    expect(tool.scope).toBe('write')
    expect(ROUTE_DOMAINS[route], route).toBeDefined()
    expect(accessDomainFor(tool)).toBe(ROUTE_DOMAINS[route].domain)
    expect(accessFeatureFor(tool) ?? null).toBe(ROUTE_DOMAINS[route].feature ?? null)
  })
})
