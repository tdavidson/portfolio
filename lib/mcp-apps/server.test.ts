import { describe, it, expect } from 'vitest'
import type { AccessContext, AccessLevel } from '@/lib/access/effective'
import type { Domain } from '@/lib/access/domains'
import type { ResolvedKey } from '@/lib/accounting/api-keys'
import { DEFAULT_FEATURE_VISIBILITY, type FeatureVisibilityMap } from '@/lib/types/features'
import { AGENT_TOOLS } from '@/lib/accounting/agent-tools'
import {
  DASHBOARD_RESOURCE_URI, MCP_TOOLS, SUPPORTED_PROTOCOL_VERSIONS, UI_MIME_TYPE, authorizeMcpTool,
  describeTool, getMcpTool, listResources, listableTools, negotiateProtocolVersion, readResource, toolResult,
} from './server'
import { DASHBOARD_HTML, DASHBOARD_HTML_HASH } from './dashboard-html.generated'
import { portfolio } from './fixtures'

const access = (role: 'admin' | 'member' | 'viewer', grants: Partial<Record<Domain, AccessLevel>> = {}): AccessContext => ({
  fundId: 'f', userId: 'u', vehicles: { all: true, ids: [] }, role,
  features: Object.fromEntries(Object.keys(DEFAULT_FEATURE_VISIBILITY).map(k => [k, 'everyone'])) as FeatureVisibilityMap,
  grants, defaults: {},
})
const key = (role: string, scopes: string[]): ResolvedKey => ({ fundId: 'f', keyId: 'k', userId: 'u', role, scopes })
const tool = (name: string) => getMcpTool(name)!

describe('protocol version', () => {
  it('answers in the client\'s version when it speaks it', () => {
    for (const v of SUPPORTED_PROTOCOL_VERSIONS) expect(negotiateProtocolVersion(v)).toBe(v)
  })

  it('offers its newest for a version it does not know, or none', () => {
    expect(negotiateProtocolVersion('2099-01-01')).toBe(SUPPORTED_PROTOCOL_VERSIONS[0])
    expect(negotiateProtocolVersion(undefined)).toBe(SUPPORTED_PROTOCOL_VERSIONS[0])
    expect(negotiateProtocolVersion({ evil: true })).toBe(SUPPORTED_PROTOCOL_VERSIONS[0])
  })
})

describe('the view resource', () => {
  it('is listed under an address that carries the build\'s hash', () => {
    const [resource] = listResources().resources
    expect(resource.uri).toBe(DASHBOARD_RESOURCE_URI)
    expect(resource.uri).toBe(`ui://portfolio/dashboard-${DASHBOARD_HTML_HASH}.html`)
    expect(resource.mimeType).toBe('text/html;profile=mcp-app')
  })

  it('is served as an MCP App document that may load nothing from the network', () => {
    const { contents } = readResource(DASHBOARD_RESOURCE_URI)!
    expect(contents[0]).toMatchObject({ uri: DASHBOARD_RESOURCE_URI, mimeType: UI_MIME_TYPE, text: DASHBOARD_HTML })
    expect(contents[0]._meta.ui.csp).toEqual({ connectDomains: [], resourceDomains: [] })
  })

  it('answers a previous build\'s address with the current view, under the address asked for', () => {
    // A host holding a tool list from before a deploy must not get a not-found mid-conversation.
    const old = 'ui://portfolio/dashboard-000000000000.html'
    expect(readResource(old)!.contents[0]).toMatchObject({ uri: old, text: DASHBOARD_HTML })
  })

  it('serves nothing else', () => {
    for (const uri of ['ui://other/thing.html', 'file:///etc/passwd', 'ui://portfolio/dashboard-x.css', '', null, 7]) {
      expect(readResource(uri)).toBeNull()
    }
  })
})

describe('the view itself', () => {
  it('is one self-contained document: no external script, stylesheet, image, font or request', () => {
    expect(DASHBOARD_HTML.startsWith('<!doctype html>')).toBe(true)
    expect(DASHBOARD_HTML).not.toMatch(/<script[^>]+src=/i)
    expect(DASHBOARD_HTML).not.toMatch(/<link\b/i)
    expect(DASHBOARD_HTML).not.toMatch(/@import|url\(\s*['"]?https?:/i)
    expect(DASHBOARD_HTML).not.toMatch(/\bfetch\(|XMLHttpRequest|WebSocket|EventSource|sendBeacon/)
    // The one URL in the bundle is the SVG namespace, which is an identifier, not a request.
    const urls = Array.from(DASHBOARD_HTML.matchAll(/https?:\/\/[^\s"'`)]+/g)).map(m => m[0])
    expect(urls.filter(u => u !== 'http://www.w3.org/2000/svg')).toEqual([])
  })

  it('never parses a value as HTML, and never evaluates one', () => {
    // Company, investor and account names come from the fund's data; they reach the DOM as text.
    expect(DASHBOARD_HTML).not.toMatch(/innerHTML|outerHTML|insertAdjacentHTML|document\.write/)
    expect(DASHBOARD_HTML).not.toMatch(/\beval\(|new Function\(/)
  })

  it('stays small enough to return from every resources/read', () => {
    expect(DASHBOARD_HTML.length).toBeLessThan(120_000)
  })
})

describe('describeTool', () => {
  it('points every drawing tool at the view, in each key a host reads', () => {
    for (const name of ['show_portfolio_dashboard', 'show_company_dashboard', 'show_financial_statements', 'show_lp_dashboard', 'open_dashboard']) {
      const meta = describeTool(tool(name))._meta as any
      expect(meta.ui.resourceUri, name).toBe(DASHBOARD_RESOURCE_URI)
      expect(meta['ui/resourceUri'], name).toBe(DASHBOARD_RESOURCE_URI)
      expect(meta['openai/outputTemplate'], name).toBe(DASHBOARD_RESOURCE_URI)
    }
  })

  it('gives no view to a tool that does not draw', () => {
    for (const name of ['list_dashboards', 'save_dashboard', 'portfolio_summary', 'post_entry']) {
      expect(describeTool(tool(name))._meta, name).toBeUndefined()
    }
  })

  it('annotates every tool, read-only exactly when its scope is read', () => {
    for (const t of MCP_TOOLS) {
      const a = describeTool(t).annotations as any
      expect(a.readOnlyHint, t.name).toBe(t.scope === 'read')
      expect(a.openWorldHint, t.name).toBe(false)
    }
    expect((describeTool(tool('delete_dashboard')).annotations as any).destructiveHint).toBe(true)
    expect((describeTool(tool('save_dashboard')).annotations as any).destructiveHint).toBe(false)
  })

  it('still describes the whole shared registry', () => {
    expect(MCP_TOOLS.length).toBeGreaterThan(AGENT_TOOLS.length)
    for (const t of AGENT_TOOLS) expect(getMcpTool(t.name), t.name).toBe(t)
    expect(getMcpTool('nope')).toBeUndefined()
    expect(getMcpTool({ name: 'post_entry' })).toBeUndefined()
  })
})

describe('listableTools', () => {
  const names = (a: AccessContext) => listableTools(a).map(t => t.name)

  it('shows a view only to a member who holds its domain', () => {
    const portfolioOnly = names(access('member', { portfolio: 'read' }))
    expect(portfolioOnly).toContain('show_portfolio_dashboard')
    expect(portfolioOnly).toContain('show_company_dashboard')
    expect(portfolioOnly).not.toContain('show_financial_statements')
    expect(portfolioOnly).not.toContain('show_lp_dashboard')

    const lpOnly = names(access('member', { lp_capital: 'read' }))
    expect(lpOnly).toContain('show_lp_dashboard')
    expect(lpOnly).not.toContain('show_portfolio_dashboard')
  })

  it('shows the saved-dashboard tools to every member, whatever single domain they hold', () => {
    for (const grants of [{ portfolio: 'read' }, { lp_capital: 'read' }, { accounting: 'read' }, {}] as Partial<Record<Domain, AccessLevel>>[]) {
      const listed = names(access('member', grants))
      for (const n of ['list_dashboards', 'open_dashboard', 'save_dashboard', 'delete_dashboard']) expect(listed).toContain(n)
    }
  })

  it('hides saving and deleting from the read-only demo', () => {
    const demo = names(access('viewer'))
    expect(demo).toContain('list_dashboards')
    expect(demo).toContain('open_dashboard')
    expect(demo).not.toContain('save_dashboard')
    expect(demo).not.toContain('delete_dashboard')
  })

  it('filters the shared registry exactly as before', () => {
    const listed = names(access('member', { portfolio: 'read' }))
    expect(listed).toContain('portfolio_summary')
    expect(listed).not.toContain('post_entry')
    expect(listed).not.toContain('run_waterfall')
  })
})

describe('authorizeMcpTool', () => {
  it('holds a view to its domain like any other read tool', () => {
    expect(authorizeMcpTool(tool('show_financial_statements'), key('member', ['read']), access('member', { accounting: 'read' }), {})).toBeNull()
    expect(authorizeMcpTool(tool('show_financial_statements'), key('member', ['read']), access('member', { portfolio: 'read' }), {}))
      .toMatch(/Fund accounting/)
    expect(authorizeMcpTool(tool('show_lp_dashboard'), key('member', ['read', 'write']), access('member', { portfolio: 'write' }), {}))
      .toMatch(/does not have access/)
  })

  it('lets any member list and open their dashboards on a read-only credential', () => {
    for (const name of ['list_dashboards', 'open_dashboard']) {
      expect(authorizeMcpTool(tool(name), key('member', ['read']), access('member', {}), {}), name).toBeNull()
    }
  })

  it('will not save or delete through a read-only credential, even an admin\'s', () => {
    // The consent screen told this connection it "cannot change anything".
    for (const name of ['save_dashboard', 'delete_dashboard']) {
      expect(authorizeMcpTool(tool(name), key('admin', ['read']), access('admin'), {}), name).toMatch(/read-only/)
    }
  })

  it('asks a save for a write-scoped credential and nothing more: no write grant in the view\'s domain', () => {
    // A bookmark is not fund data, so the domain's WRITE grant is not consulted. The credential's
    // own scope still is; the sign-in only issues it to a member who can write somewhere
    // (grantableScope), which is why a member with read-only grants throughout cannot save.
    expect(authorizeMcpTool(tool('save_dashboard'), key('member', ['read', 'write']), access('member', { portfolio: 'read' }), {})).toBeNull()
  })

  it('never lets the read-only demo save, whatever its token says', () => {
    expect(authorizeMcpTool(tool('save_dashboard'), key('viewer', ['read', 'write']), access('viewer'), {})).toMatch(/demo/)
  })

  it('still elevates a call by its input for the shared registry', () => {
    const ops = access('member', { accounting: 'write' })
    expect(authorizeMcpTool(tool('allocation'), key('member', ['read', 'write']), ops, { action: 'management_fee' })).toBeNull()
    expect(authorizeMcpTool(tool('allocation'), key('member', ['read', 'write']), ops, { action: 'carry' })).toMatch(/GP economics/)
  })
})

describe('toolResult', () => {
  it('sends a dashboard twice: whole to the view, as figures to the model', () => {
    const result = toolResult(tool('show_portfolio_dashboard'), portfolio) as any
    expect(result.structuredContent).toBe(portfolio)
    const forModel = JSON.parse(result.content[0].text)
    expect(forModel).toMatchObject({ dashboard: 'Portfolio overview', view: 'portfolio', arguments: {} })
    expect(forModel.data.totals).toEqual(portfolio.data.totals)
    // The theme is presentation, not something for the model to reason over.
    expect(forModel.branding).toBeUndefined()
  })

  it('sends anything else as text only', () => {
    expect(toolResult(tool('list_dashboards'), { dashboards: [] })).toEqual({ content: [{ type: 'text', text: '{"dashboards":[]}' }] })
    expect(toolResult(tool('portfolio_summary'), portfolio)).not.toHaveProperty('structuredContent')
    // A drawing tool whose handler returned something that is not a dashboard does not pretend.
    expect(toolResult(tool('open_dashboard'), { nope: true })).not.toHaveProperty('structuredContent')
  })
})
