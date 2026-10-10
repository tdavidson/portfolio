import { beforeEach, describe, expect, it, vi } from 'vitest'
import { NextRequest } from 'next/server'
import type { AccessContext, AccessLevel } from '@/lib/access/effective'
import type { Domain } from '@/lib/access/domains'
import { DEFAULT_FEATURE_VISIBILITY, type FeatureVisibilityMap } from '@/lib/types/features'
import { memoryAdmin } from './helpers/memory-admin'

/**
 * The MCP endpoint end to end, as an assistant drives it: initialize, list the tools, fetch the
 * view, call a dashboard, save one, open it again. The database and the read handlers are
 * stand-ins; the JSON-RPC dispatch, authorization and result shaping are the real route.
 */

let scopes = ['read', 'write']
let access: AccessContext
const store = memoryAdmin({
  saved_dashboards: [],
  funds: [{ id: 'fund-1', name: 'Northgate' }],
  fund_settings: [{ fund_id: 'fund-1', currency: 'USD', theme: null }],
  fund_members: [{ fund_id: 'fund-1', user_id: 'user-me', role: 'member' }],
  fund_vehicles: [{ id: 'v1', fund_id: 'fund-1', name: 'Fund I', active: true, kind: 'fund', aliases: null }],
})

vi.mock('@/lib/supabase/admin', () => ({ createAdminClient: () => store.admin }))
vi.mock('@/lib/oauth/enabled', () => ({ agentApiEnabled: async () => true }))
vi.mock('@/lib/rate-limit', () => ({ rateLimit: async () => null }))
vi.mock('@/lib/accounting/api-keys', async importOriginal => ({
  ...(await importOriginal<typeof import('@/lib/accounting/api-keys')>()),
  resolveAgentAuth: async (_admin: unknown, req: Request) =>
    req.headers.get('authorization') ? { fundId: 'fund-1', keyId: 'oauth:test', userId: 'user-me', role: access.role, scopes } : null,
  loadCredentialAccess: async () => access,
}))
vi.mock('@/lib/agent/portfolio-tools', async importOriginal => {
  const real = await importOriginal<typeof import('@/lib/agent/portfolio-tools')>()
  return { ...real, PORTFOLIO_HANDLERS: {
    ...real.PORTFOLIO_HANDLERS,
    portfolio_summary: async () => ({
      asOf: '2026-10-09', vehicle: 'all',
      positions: [{ company: 'Acme', companyId: 'c1', status: 'active', stage: 'Seed', industry: [], cost: 100, fairValue: 250, unrealized: 150, realized: 0, moic: 2.5, pctOfPortfolio: 100 }],
      totals: { cost: 100, fairValue: 250, unrealized: 150, realized: 0, grossMoic: 2.5 },
    }),
  } }
})

import { POST, GET } from '@/app/api/mcp/route'
import { DASHBOARD_RESOURCE_URI } from '@/lib/mcp-apps/server'

const member = (grants: Partial<Record<Domain, AccessLevel>>, role: 'admin' | 'member' | 'viewer' = 'member'): AccessContext => ({
  fundId: 'fund-1', userId: 'user-me', vehicles: { all: true, ids: [] }, role,
  features: Object.fromEntries(Object.keys(DEFAULT_FEATURE_VISIBILITY).map(k => [k, 'everyone'])) as FeatureVisibilityMap,
  grants, defaults: {},
})

async function rpc(method: string, params?: unknown, authed = true) {
  const res = await POST(new NextRequest('https://fund.test/api/mcp', {
    method: 'POST',
    // A request built in a test has no Host header; a real one always does.
    headers: { host: 'fund.test', 'content-type': 'application/json', ...(authed ? { authorization: 'Bearer mcp_at_test' } : {}) },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  }))
  return { status: res.status, headers: res.headers, body: res.status === 202 ? null : await res.json() }
}
const call = (name: string, args: Record<string, unknown> = {}) => rpc('tools/call', { name, arguments: args })

beforeEach(() => {
  scopes = ['read', 'write']
  access = member({ portfolio: 'read' })
  store.tables.saved_dashboards = []
})

describe('initialize', () => {
  it('answers in the client\'s protocol version and advertises tools, resources and prompts', async () => {
    const { body } = await rpc('initialize', { protocolVersion: '2025-06-18', capabilities: { extensions: { 'io.modelcontextprotocol/ui': { mimeTypes: ['text/html;profile=mcp-app'] } } } })
    expect(body.result.protocolVersion).toBe('2025-06-18')
    expect(body.result.capabilities).toEqual({ tools: {}, resources: {}, prompts: {} })
    // The fund's square app mark, absolute on the address the host reached, for a host that shows icons.
    expect(body.result.serverInfo.icons).toEqual([
      { src: 'https://fund.test/api/pwa-icon?size=192', mimeType: 'image/png', sizes: ['192x192'] },
      { src: 'https://fund.test/api/pwa-icon?size=512', mimeType: 'image/png', sizes: ['512x512'] },
    ])
  })

  it('still serves a client that only speaks the original revision', async () => {
    expect((await rpc('initialize', { protocolVersion: '2024-11-05' })).body.result.protocolVersion).toBe('2024-11-05')
  })

  it('refuses a request with no credential, pointing at the OAuth metadata', async () => {
    const res = await rpc('initialize', {}, false)
    expect(res.status).toBe(401)
    expect(res.headers.get('www-authenticate')).toContain('resource_metadata="https://fund.test/.well-known/oauth-protected-resource"')
  })
})

describe('tools/list', () => {
  it('describes the dashboards this member can open, each pointing at the view', async () => {
    const tools: any[] = (await rpc('tools/list')).body.result.tools
    const byName = Object.fromEntries(tools.map(t => [t.name, t]))
    expect(byName.show_portfolio_dashboard._meta.ui.resourceUri).toBe(DASHBOARD_RESOURCE_URI)
    expect(byName.show_portfolio_dashboard.annotations).toEqual({ readOnlyHint: true, openWorldHint: false })
    expect(byName.open_dashboard._meta['openai/outputTemplate']).toBe(DASHBOARD_RESOURCE_URI)
    expect(byName.portfolio_summary._meta).toBeUndefined()
    // Portfolio only: the books and the LPs are not on the menu.
    expect(byName.show_financial_statements).toBeUndefined()
    expect(byName.show_lp_dashboard).toBeUndefined()
  })
})

describe('resources', () => {
  it('lists and serves the view the tools point at', async () => {
    const listed = (await rpc('resources/list')).body.result.resources
    expect(listed.map((r: any) => r.uri)).toEqual([DASHBOARD_RESOURCE_URI])

    const read = (await rpc('resources/read', { uri: DASHBOARD_RESOURCE_URI })).body.result.contents[0]
    expect(read.mimeType).toBe('text/html;profile=mcp-app')
    expect(read.text.startsWith('<!doctype html>')).toBe(true)
  })

  it('answers not-found for anything else, and needs a credential like everything here', async () => {
    expect((await rpc('resources/read', { uri: 'ui://other/x.html' })).body.error.code).toBe(-32002)
    expect((await rpc('resources/read', { uri: DASHBOARD_RESOURCE_URI }, false)).status).toBe(401)
    expect((await rpc('resources/templates/list')).body.result).toEqual({ resourceTemplates: [] })
  })
})

describe('tools/call', () => {
  it('returns a dashboard as figures for the model and a payload for the view', async () => {
    const { result } = (await call('show_portfolio_dashboard')).body
    expect(result.isError).toBeUndefined()
    expect(result.structuredContent).toMatchObject({ view: 'portfolio', title: 'Portfolio overview', branding: { fundName: 'Northgate', currency: 'USD' } })
    // This member does not hold accounting, so the fund's own position is not in either half.
    expect(result.structuredContent.data.performance).toBeNull()
    const forModel = JSON.parse(result.content[0].text)
    expect(forModel.data.totals.grossMoic).toBe(2.5)
    expect(forModel.data.performance).toBeNull()
  })

  it('refuses a dashboard outside the member\'s access, as a tool error the model can read', async () => {
    const { result } = (await call('show_financial_statements')).body
    expect(result.isError).toBe(true)
    expect(result.content[0].text).toMatch(/does not have access to Fund accounting/)
    expect(result.structuredContent).toBeUndefined()
  })

  it('saves a dashboard, lists it, opens it by name, and deletes it', async () => {
    // Typed loosely, as a model would: it is stored under the vehicle's own spelling.
    const saved = (await call('save_dashboard', { name: 'Board pack', view: 'portfolio', arguments: { vehicle: 'fund i' } })).body.result
    expect(saved.isError).toBeUndefined()
    expect(store.tables.saved_dashboards).toHaveLength(1)
    expect(store.tables.saved_dashboards[0]).toMatchObject({ fund_id: 'fund-1', user_id: 'user-me', name: 'Board pack' })

    const listed = JSON.parse((await call('list_dashboards')).body.result.content[0].text).dashboards
    expect(listed.map((d: any) => d.name)).toEqual(['Portfolio overview', 'Board pack'])

    const opened = (await call('open_dashboard', { dashboard: 'board pack' })).body.result
    expect(opened.structuredContent).toMatchObject({ view: 'portfolio', title: 'Board pack', args: { vehicle: 'Fund I' } })

    expect((await call('delete_dashboard', { dashboard: 'Board pack' })).body.result.isError).toBeUndefined()
    expect(store.tables.saved_dashboards).toHaveLength(0)
  })

  it('will not save through a read-only connection, and writes nothing', async () => {
    scopes = ['read']
    const { result } = (await call('save_dashboard', { name: 'Board pack', view: 'portfolio' })).body
    expect(result.isError).toBe(true)
    expect(result.content[0].text).toMatch(/read-only/)
    expect(store.tables.saved_dashboards).toHaveLength(0)
    // Opening is still fine.
    expect((await call('open_dashboard', { dashboard: 'standard:portfolio' })).body.result.isError).toBeUndefined()
  })

  it('will not save for the read-only demo', async () => {
    access = member({}, 'viewer')
    const { result } = (await call('save_dashboard', { name: 'x', view: 'portfolio' })).body
    expect(result.isError).toBe(true)
    expect(store.tables.saved_dashboards).toHaveLength(0)
  })

  it('reports an unknown tool as a protocol error', async () => {
    expect((await call('show_everything')).body.error.code).toBe(-32602)
  })
})

describe('prompts', () => {
  it('lists the templates for the member\'s areas, and renders one with its arguments', async () => {
    const prompts: any[] = (await rpc('prompts/list')).body.result.prompts
    const names = prompts.map(p => p.name)
    expect(names).toContain('get_started')
    expect(names).toContain('company_check_in')
    // Portfolio only: no books, LP or forecast templates on offer.
    expect(names).not.toContain('quarter_end_review')
    expect(names).not.toContain('draft_forecast')
    const got = (await rpc('prompts/get', { name: 'company_check_in', arguments: { company: 'Acme' } })).body.result
    expect(got.messages[0]).toEqual({ role: 'user', content: { type: 'text', text: expect.stringContaining('Open the dashboard for Acme') } })
  })

  it('refuses a template outside the member\'s access, or one missing its argument', async () => {
    expect((await rpc('prompts/get', { name: 'draft_forecast', arguments: { vehicle: 'Fund I' } })).body.error.code).toBe(-32602)
    expect((await rpc('prompts/get', { name: 'company_check_in', arguments: {} })).body.error.message).toMatch(/company/)
  })
})

describe('the home dashboard', () => {
  it('opens for any member, as help text for the model and a launcher for the view', async () => {
    const res = (await call('show_home')).body.result
    expect(res.structuredContent.view).toBe('home')
    expect(res.structuredContent.data.dashboards.map((d: any) => d.tool)).toEqual(['show_portfolio_dashboard'])
    expect(res.content[0].text).toContain("Northgate's Portfolio deployment")
  })
})

describe('GET', () => {
  it('is still refused: the server is stateless JSON, with no stream to open', async () => {
    expect((await GET()).status).toBe(405)
  })
})
