import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { NextRequest } from 'next/server'
import type { AccessContext, AccessLevel } from '@/lib/access/effective'
import type { Domain } from '@/lib/access/domains'
import { DEFAULT_FEATURE_VISIBILITY, type FeatureVisibilityMap } from '@/lib/types/features'
import { memoryAdmin } from './helpers/memory-admin'

/**
 * The destructive tools (lib/agent/destructive.ts): offered only with AGENT_DESTRUCTIVE_ACTIONS=true,
 * and then always staged, from any credential, for an admin to approve. The routes, authorization,
 * staging, previews and approval are real; the database is in memory. lp_delete_investor stands in
 * for the family: every destructive tool goes through the same checks.
 */

let scopes = ['read', 'write']
let keyId = 'oauth:claude'
let access: AccessContext
let store: ReturnType<typeof memoryAdmin>

vi.mock('@/lib/supabase/admin', () => ({ createAdminClient: () => store.admin }))
vi.mock('@/lib/oauth/enabled', () => ({ agentApiEnabled: async () => true }))
vi.mock('@/lib/rate-limit', () => ({ rateLimit: async () => null }))
const notifyAdmins = vi.fn(async () => 1)
vi.mock('@/lib/pending-actions/notify', () => ({ notifyAdminsOfStagedChange: (...args: any[]) => (notifyAdmins as any)(...args) }))
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

import { GET as agentGet, POST as agentPost } from '@/app/api/agent/route'
import { POST as mcpPost } from '@/app/api/mcp/route'
import { DESTRUCTIVE_FLAG, destructiveToolsEnabled } from '@/lib/agent/destructive'
import { approvePendingAction } from '@/lib/pending-actions/service'

const grantee = (grants: Partial<Record<Domain, AccessLevel>>, role: 'admin' | 'member' | 'viewer' = 'member'): AccessContext => ({
  fundId: 'fund-1', userId: 'user-me', vehicles: { all: true, ids: [] }, role,
  features: Object.fromEntries(Object.keys(DEFAULT_FEATURE_VISIBILITY).map(k => [k, 'everyone'])) as FeatureVisibilityMap,
  grants, defaults: {},
})
const admin = () => grantee({}, 'admin')

async function rpc(method: string, params: Record<string, unknown> = {}) {
  const res = await mcpPost(new NextRequest('https://fund.test/api/mcp', {
    method: 'POST',
    headers: { host: 'fund.test', 'content-type': 'application/json', authorization: 'Bearer mcp_at_test' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  }))
  return res.json()
}

async function callTool(name: string, args: Record<string, unknown>) {
  const body = await rpc('tools/call', { name, arguments: args })
  const text = body.result?.content?.[0]?.text as string
  return { isError: !!body.result?.isError, text, json: (() => { try { return JSON.parse(text) } catch { return null } })() }
}

async function callAgent(tool: string, input: Record<string, unknown>) {
  const res = await agentPost(new NextRequest('https://fund.test/api/agent', {
    method: 'POST',
    headers: { host: 'fund.test', 'content-type': 'application/json', authorization: 'Bearer lk_test' },
    body: JSON.stringify({ tool, input }),
  }))
  return { status: res.status, body: await res.json() }
}

async function agentManifest(): Promise<string[]> {
  const res = await agentGet(new NextRequest('https://fund.test/api/agent', { headers: { host: 'fund.test', authorization: 'Bearer lk_test' } }))
  return ((await res.json()).tools as { name: string }[]).map(t => t.name)
}

const listed = async (): Promise<string[]> => ((await rpc('tools/list')).result.tools as { name: string }[]).map(t => t.name)
const investors = () => (store.tables.lp_investors ?? []).map(i => i.id).sort()
const DELETE_FO = { investor: 'Acme FO' }

beforeEach(() => {
  vi.unstubAllEnvs()
  scopes = ['read', 'write']
  keyId = 'oauth:claude'
  access = admin()
  notifyAdmins.mockClear()
  store = memoryAdmin({
    fund_members: [{ fund_id: 'fund-1', user_id: 'user-me', role: 'admin' }],
    fund_vehicles: [{ id: 'v1', fund_id: 'fund-1', name: 'Fund I', active: true, kind: 'fund', aliases: null }],
    lp_investors: [
      { id: 'inv-1', fund_id: 'fund-1', name: 'Acme Family Office' },
      { id: 'inv-2', fund_id: 'fund-1', name: 'Acme FO' },
    ],
    lp_entities: [{ id: 'ent-2', fund_id: 'fund-1', investor_id: 'inv-2', entity_name: 'Acme FO LP' }],
    journal_postings: [{ id: 'p1', fund_id: 'fund-1', book: 'actual', lp_entity_id: 'ent-2', amount: 100 }],
    capital_call_lines: [],
    pending_actions: [],
    accounting_audit_events: [],
    api_idempotency_keys: [],
  }, { unique: [{ table: 'api_idempotency_keys', key: r => `${r.fund_id}|${r.client_id}|${r.endpoint}|${r.key}` }] })
})
afterEach(() => vi.unstubAllEnvs())

describe('the flag', () => {
  it('is on only for the exact value "true"', () => {
    expect(destructiveToolsEnabled({})).toBe(false)
    expect(destructiveToolsEnabled({ [DESTRUCTIVE_FLAG]: 'false' })).toBe(false)
    expect(destructiveToolsEnabled({ [DESTRUCTIVE_FLAG]: '1' })).toBe(false)
    expect(destructiveToolsEnabled({ [DESTRUCTIVE_FLAG]: 'true' })).toBe(true)
    expect(destructiveToolsEnabled({ [DESTRUCTIVE_FLAG]: ' TRUE ' })).toBe(true)
  })
})

describe('with AGENT_DESTRUCTIVE_ACTIONS unset', () => {
  it('lists none of them in tools/list, search_tools or GET /api/agent, even to an admin', async () => {
    expect(await listed()).not.toContain('lp_delete_investor')
    expect(await listed()).toContain('lp_create_investor')
    const search = await callTool('search_tools', {})
    expect(search.json.tools.map((t: any) => t.name)).not.toContain('lp_delete_investor')
    const named = await callTool('search_tools', { names: ['lp_delete_investor'] })
    expect(named.json.tools).toEqual([])
    expect(named.json.notFound[0].name).toBe('lp_delete_investor')
    expect(await agentManifest()).not.toContain('lp_delete_investor')
  })

  it('refuses a direct call, naming the flag, and stages nothing', async () => {
    const out = await callTool('lp_delete_investor', DELETE_FO)
    expect(out.isError).toBe(true)
    expect(out.text).toContain(DESTRUCTIVE_FLAG)
    expect(store.tables.pending_actions).toHaveLength(0)
    expect(investors()).toEqual(['inv-1', 'inv-2'])
  })

  it('refuses one run through call_tool the same way', async () => {
    const out = await callTool('call_tool', { name: 'lp_delete_investor', arguments: DELETE_FO })
    expect(out.isError).toBe(true)
    expect(out.text).toContain(DESTRUCTIVE_FLAG)
    expect(store.tables.pending_actions).toHaveLength(0)
  })

  it('refuses one as a stage_run step', async () => {
    const out = await callTool('stage_run', {
      title: 'Clean up investors', rationale: 'A duplicate.', steps: [{ tool: 'lp_delete_investor', input: DELETE_FO }],
    })
    expect(out.isError).toBe(true)
    expect(out.text).toContain(DESTRUCTIVE_FLAG)
    expect(store.tables.pending_actions).toHaveLength(0)
  })

  it('refuses one from an API key with a 403', async () => {
    keyId = 'key-1'
    const out = await callAgent('lp_delete_investor', DELETE_FO)
    expect(out.status).toBe(403)
    expect(out.body.error).toContain(DESTRUCTIVE_FLAG)
    expect(investors()).toEqual(['inv-1', 'inv-2'])
  })

  it('refuses to apply one staged while the flag was on', async () => {
    vi.stubEnv(DESTRUCTIVE_FLAG, 'true')
    const staged = await callTool('lp_delete_investor', DELETE_FO)
    vi.unstubAllEnvs()
    const out = await callTool('approve_action', { id: staged.json.pendingActionId })
    expect(out.isError).toBe(true)
    expect(out.text).toContain(DESTRUCTIVE_FLAG)
    expect(investors()).toEqual(['inv-1', 'inv-2'])
  })
})

describe('with AGENT_DESTRUCTIVE_ACTIONS=true', () => {
  beforeEach(() => { vi.stubEnv(DESTRUCTIVE_FLAG, 'true') })

  it('lists them, marked destructive and always staged', async () => {
    const tools = (await rpc('tools/list')).result.tools as any[]
    const tool = tools.find(t => t.name === 'lp_delete_investor')
    expect(tool.annotations).toMatchObject({ readOnlyHint: false, destructiveHint: true })
    keyId = 'key-1'
    const described = await callTool('search_tools', { names: ['lp_delete_investor'] })
    expect(described.json.tools[0]).toMatchObject({ name: 'lp_delete_investor', staged: true, destructive: true })
    expect(await agentManifest()).toContain('lp_delete_investor')
  })

  it("stages an admin's API-key call instead of applying it, and that key cannot approve it", async () => {
    keyId = 'key-1'
    const out = await callAgent('lp_delete_investor', DELETE_FO)
    expect(out.status).toBe(200)
    expect(out.body.result).toMatchObject({ staged: true })
    expect(out.body.result.next).toMatch(/cannot approve its own changes/)
    expect(investors()).toEqual(['inv-1', 'inv-2'])

    const [row] = store.tables.pending_actions
    expect(row).toMatchObject({ action_type: 'agent_tool_call', created_via: 'api', args: { tool: 'lp_delete_investor', input: { investor: 'inv-2' } } })

    // The same key, over MCP: refused (lib/pending-actions/service.ts selfApprovalRefused).
    const self = await callTool('approve_action', { id: out.body.result.pendingActionId })
    expect(self.isError).toBe(true)
    expect(self.text).toMatch(/staged with this key, so this key cannot approve it/)
    expect(investors()).toEqual(['inv-1', 'inv-2'])

    // The admin's own chat (another credential) approves it on their yes.
    keyId = 'oauth:admins-chat'
    const approved = await callTool('approve_action', { id: out.body.result.pendingActionId })
    expect(approved.isError).toBe(false)
    expect(approved.json).toMatchObject({ applied: true, result: { tool: 'lp_delete_investor', result: { deleted: { id: 'inv-2' } } } })
    expect(investors()).toEqual(['inv-1'])
  })

  it('shows the approver what the delete would take with it, and pins the record it previewed', async () => {
    const out = await callTool('lp_delete_investor', DELETE_FO)
    expect(out.json.summary).toMatch(/Delete LP investor Acme FO and its 1 entity \(Acme FO LP\)/)
    expect(out.json.summary).toMatch(/WARNING: Acme FO LP has ledger activity/)
    expect(out.json.summary).toMatch(/Cannot be undone; needs an admin's approval/)
    expect(out.json.preview).toMatchObject({
      destructive: true,
      impact: { investor: { id: 'inv-2', name: 'Acme FO' }, entities: [{ id: 'ent-2', name: 'Acme FO LP', postings: 1, callLines: 0 }] },
    })
    // Renaming the other investor to the same name later does not change what approval deletes.
    store.tables.lp_investors[0].name = 'Acme FO'
    keyId = 'oauth:admins-chat'
    await callTool('approve_action', { id: out.json.pendingActionId })
    expect(investors()).toEqual(['inv-1'])
  })

  it("an admin's own chat approves what it staged, on the person's explicit yes", async () => {
    const out = await callTool('lp_delete_investor', DELETE_FO)
    expect(out.json.next).toMatch(/Only after they explicitly say yes, call approve_action/)
    const approved = await callTool('approve_action', { id: out.json.pendingActionId })
    expect(approved.isError).toBe(false)
    expect(investors()).toEqual(['inv-1'])
  })

  it('an admin approves it in the app', async () => {
    const out = await callTool('lp_delete_investor', DELETE_FO)
    await approvePendingAction(store.admin, {
      userId: 'user-me', fundId: 'fund-1', role: 'admin', access: admin(), credentialKind: 'cookie',
    } as any, out.json.pendingActionId)
    expect(investors()).toEqual(['inv-1'])
  })

  it("a member's chat proposes it, the admins are told, and only an admin can approve it", async () => {
    access = grantee({ lp_capital: 'write' })
    const out = await callTool('lp_delete_investor', DELETE_FO)
    expect(out.json).toMatchObject({ staged: true })
    expect(out.json.next).toMatch(/Only an admin can delete an LP investor/)
    expect(notifyAdmins).toHaveBeenCalledTimes(1)

    const refused = await callTool('approve_action', { id: out.json.pendingActionId })
    expect(refused.isError).toBe(true)
    expect(refused.text).toMatch(/Only an admin can delete an LP investor/)
    expect(investors()).toEqual(['inv-1', 'inv-2'])

    access = admin()
    keyId = 'oauth:admins-chat'
    const approved = await callTool('approve_action', { id: out.json.pendingActionId })
    expect(approved.isError).toBe(false)
    expect(investors()).toEqual(['inv-1'])
  })

  it("refuses a member's API key outright", async () => {
    access = grantee({ lp_capital: 'write' })
    keyId = 'key-1'
    const out = await callAgent('lp_delete_investor', DELETE_FO)
    expect(out.status).toBe(403)
    expect(out.body.error).toBe('Only an admin can delete an LP investor.')
    expect(store.tables.pending_actions).toHaveLength(0)
  })

  it('stages one through call_tool, and as a step of a run approved by an admin', async () => {
    const viaGateway = await callTool('call_tool', { name: 'lp_delete_investor', arguments: DELETE_FO })
    expect(viaGateway.json).toMatchObject({ staged: true })

    const run = await callTool('stage_run', {
      title: 'Merge the duplicate investor', rationale: 'Acme FO is Acme Family Office.',
      steps: [{ tool: 'lp_merge_investors', input: { from: 'Acme FO', into: 'Acme Family Office' } }],
    })
    expect(run.isError).toBe(false)
    expect(run.json).toMatchObject({ staged: true, steps: 1 })
    keyId = 'oauth:admins-chat'
    const approved = await callTool('approve_action', { id: run.json.pendingActionId })
    expect(approved.isError).toBe(false)
    expect(investors()).toEqual(['inv-1'])
    expect(store.tables.lp_entities[0].investor_id).toBe('inv-1')
  })

  it('refuses to stage voiding a draft, alone or as a run step, and points to discard_drafts', async () => {
    store.tables.journal_entries = [{ id: 'je-draft', fund_id: 'fund-1', vehicle_id: 'v1', book: 'actual', status: 'draft', entry_date: '2026-03-31' }]
    const alone = await callTool('void_entry', { entry_id: 'je-draft', reason: 'Duplicate' })
    expect(alone.isError).toBe(true)
    expect(alone.text).toMatch(/discard_drafts/)
    const run = await callTool('stage_run', {
      title: 'Clear duplicates', rationale: 'Imported twice.', steps: [{ tool: 'void_entry', input: { entry_id: 'je-draft', reason: 'Duplicate' } }],
    })
    expect(run.isError).toBe(true)
    expect(run.text).toMatch(/discard_drafts/)
    expect(store.tables.pending_actions).toHaveLength(0)
    expect(store.tables.journal_entries[0].status).toBe('draft')
  })

  it('applies the route\'s own refusal on approval: an entity with ledger activity is not deleted', async () => {
    const out = await callTool('lp_delete_entity', { lp: 'Acme FO LP' })
    expect(out.json.summary).toMatch(/so the delete will be refused/)
    keyId = 'oauth:admins-chat'
    const approved = await callTool('approve_action', { id: out.json.pendingActionId })
    expect(approved.isError).toBe(true)
    expect(approved.text).toMatch(/has activity in the ledger/)
    expect(store.tables.lp_entities).toHaveLength(1)
  })
})
