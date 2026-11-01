import { beforeEach, describe, expect, it, vi } from 'vitest'
import { NextRequest } from 'next/server'
import type { AccessContext } from '@/lib/access/effective'
import type { MasterAdminPool } from '@/lib/agent/master-admin'
import { DEFAULT_FEATURE_VISIBILITY, type FeatureVisibilityMap } from '@/lib/types/features'
import { memoryAdmin } from './helpers/memory-admin'

/**
 * A pooled connection (one that works in several funds, lib/agent/master-admin.ts) through the real
 * MCP route: each conversation gets its own session at initialize, and every write must name the
 * active fund, so a switch made in another conversation cannot move this one's write.
 */

let store: ReturnType<typeof memoryAdmin>
let pool: MasterAdminPool
const sessions: (string | null | undefined)[] = []
const addChartAccount = vi.fn(async (_a: unknown, _f: string, _g: string, input: any) => ({ account: { code: input.code, name: input.name } }))

const access: AccessContext = {
  fundId: 'fund-1', userId: 'user-me', vehicles: { all: true, ids: [] }, role: 'member',
  features: Object.fromEntries(Object.keys(DEFAULT_FEATURE_VISIBILITY).map(k => [k, 'everyone'])) as FeatureVisibilityMap,
  grants: { accounting: 'write' }, defaults: {},
}

vi.mock('@/lib/supabase/admin', () => ({ createAdminClient: () => store.admin }))
vi.mock('@/lib/oauth/enabled', () => ({ agentApiEnabled: async () => true }))
vi.mock('@/lib/rate-limit', () => ({ rateLimit: async () => null }))
vi.mock('@/lib/pending-actions/notify', () => ({ notifyAdminsOfStagedChange: async () => 0 }))
vi.mock('@/lib/accounting/chart-add', () => ({ addChartAccount: (...args: any[]) => (addChartAccount as any)(...args) }))
vi.mock('@/lib/accounting/api-keys', async importOriginal => ({
  ...(await importOriginal<typeof import('@/lib/accounting/api-keys')>()),
  resolveAgentAuth: async (_admin: unknown, req: Request, opts: { sessionId?: string | null } = {}) => {
    sessions.push(opts.sessionId !== undefined ? opts.sessionId : req.headers.get('mcp-session-id'))
    return { fundId: 'fund-1', keyId: 'oauth:claude', userId: 'user-me', role: 'member', scopes: ['read', 'write'], pool }
  },
  loadCredentialAccess: async () => access,
}))

import { POST as mcpPost } from '@/app/api/mcp/route'

async function rpc(method: string, params: Record<string, unknown> = {}, headers: Record<string, string> = {}) {
  return mcpPost(new NextRequest('https://fund.test/api/mcp', {
    method: 'POST',
    headers: { host: 'fund.test', 'content-type': 'application/json', authorization: 'Bearer mcp_at_test', ...headers },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  }))
}

const addAccount = async (args: Record<string, unknown>) => {
  const body = await (await rpc('tools/call', { name: 'add_account', arguments: { code: '6100', name: 'Legal', type: 'expense', ...args } })).json()
  return { isError: !!body.result?.isError, text: (body.result?.content ?? []).map((c: any) => c.text).join('\n') }
}

beforeEach(() => {
  sessions.length = 0
  addChartAccount.mockClear()
  pool = {
    homeUserId: 'user-me', clientId: 'claude', sessionId: '', activeFundId: 'fund-1',
    funds: [
      { fundId: 'fund-1', fundName: 'Example Fund I', userId: 'user-me', email: 'gp@one.example' },
      { fundId: 'fund-2', fundName: 'Example Fund II', userId: 'user-two', email: 'gp@two.example' },
    ],
  }
  store = memoryAdmin({
    fund_members: [{ fund_id: 'fund-1', user_id: 'user-me', role: 'member' }],
    fund_vehicles: [{ id: 'v1', fund_id: 'fund-1', name: 'Fund I', active: true, kind: 'fund', aliases: null }],
    pending_actions: [], accounting_audit_events: [], api_idempotency_keys: [],
  })
})

describe('a pooled connection', () => {
  it('issues a fresh session at initialize and resolves the fund for it', async () => {
    const res = await rpc('initialize', { protocolVersion: '2025-06-18' })
    const id = res.headers.get('mcp-session-id')
    expect(id).toMatch(/^mcps_/)
    expect(sessions[0]).toBe(id)
    expect((await res.json()).result.instructions).toMatch(/belongs to this conversation/)

    await rpc('tools/list', {}, { 'mcp-session-id': id! })
    expect(sessions[1]).toBe(id)
  })

  it('lists activeFund as a required argument of write tools only', async () => {
    const tools = (await (await rpc('tools/list')).json()).result.tools as any[]
    const write = tools.find(t => t.name === 'add_account')
    expect(write.inputSchema.required).toContain('activeFund')
    const read = tools.find(t => t.name === 'list_pending_actions')
    expect(read.inputSchema.properties?.activeFund).toBeUndefined()
  })

  it('refuses a write that names no fund, or another fund, and changes nothing', async () => {
    const none = await addAccount({})
    expect(none.isError).toBe(true)
    expect(none.text).toMatch(/pass activeFund/)

    const other = await addAccount({ activeFund: 'Example Fund II' })
    expect(other.isError).toBe(true)
    expect(other.text).toMatch(/active fund is Example Fund I/)
    expect(store.tables.pending_actions).toHaveLength(0)
  })

  it('runs a write that names the active fund, without passing the argument on', async () => {
    const ok = await addAccount({ activeFund: 'Example Fund I' })
    expect(ok.isError).toBe(false)
    expect(ok.text).toMatch(/^Fund: Example Fund I/)
    expect(store.tables.pending_actions).toHaveLength(1)
    expect(store.tables.pending_actions[0].args.activeFund).toBeUndefined()
  })

  it('checks the same way through call_tool', async () => {
    const body = await (await rpc('tools/call', { name: 'call_tool', arguments: { name: 'add_account', arguments: { code: '6100', name: 'Legal', type: 'expense', activeFund: 'fund-2' } } })).json()
    expect(body.result.isError).toBe(true)
    expect(store.tables.pending_actions).toHaveLength(0)
  })
})
