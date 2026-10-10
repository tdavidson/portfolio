// The MCP endpoint's side of MCP Apps: which tools carry a view, how their results are shaped,
// and the `ui://` resource a host fetches to draw them.
//
// MCP Apps is an extension to MCP (https://modelcontextprotocol.io/extensions/apps/overview) that
// Claude and ChatGPT both implement. Three things make a tool render:
//   1. its `tools/list` entry names a `ui://` resource in `_meta.ui.resourceUri`;
//   2. the server serves that resource from `resources/read` as `text/html;profile=mcp-app`;
//   3. its result carries `structuredContent` for the view, beside the text for the model.
// A host that does not speak the extension ignores (1) and (3) and shows the text. Nothing here
// is conditional on the client, which is what lets this endpoint stay stateless.

import type { AccessContext } from '@/lib/access/effective'
import { hasAccess } from '@/lib/access/effective'
import { authorizeToolUse, type ResolvedKey } from '@/lib/accounting/api-keys'
import {
  AGENT_TOOLS, accessDomainFor, accessDomainForCall, accessFeatureFor,
  type AgentTool,
} from '@/lib/accounting/agent-tools'
import { DASHBOARD_TOOLS, type DashboardTool } from '@/lib/agent/dashboard-tools'
import { DASHBOARD_HTML, DASHBOARD_HTML_HASH } from './dashboard-html.generated'
import { isDashboardPayload } from './payload'

export type McpTool = AgentTool | DashboardTool

/** Everything the MCP endpoint serves: the shared registry, then the dashboard tools. */
export const MCP_TOOLS: McpTool[] = [...AGENT_TOOLS, ...DASHBOARD_TOOLS]

export function getMcpTool(name: unknown): McpTool | undefined {
  return typeof name === 'string' ? MCP_TOOLS.find(t => t.name === name) : undefined
}

const isUi = (tool: McpTool) => (tool as DashboardTool).ui === true
const isPersonal = (tool: McpTool) => (tool as DashboardTool).personal === true

// ---------------------------------------------------------------------------------------------
// Protocol version
// ---------------------------------------------------------------------------------------------

/**
 * The MCP revisions this endpoint speaks, newest first.
 *
 * It used to answer every `initialize` with 2024-11-05 whatever the client asked for. That
 * revision has no `structuredContent`, so a host negotiating down to it has no reason to hand a
 * result's structured half to a view. Everything this server does (stateless JSON over Streamable
 * HTTP, 202 for notifications, 405 on GET) is valid in each revision listed.
 */
export const SUPPORTED_PROTOCOL_VERSIONS = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'] as const

/** The client's version when we speak it; otherwise our newest, which the client may refuse. */
export function negotiateProtocolVersion(requested: unknown): string {
  return typeof requested === 'string' && (SUPPORTED_PROTOCOL_VERSIONS as readonly string[]).includes(requested)
    ? requested
    : SUPPORTED_PROTOCOL_VERSIONS[0]
}

// ---------------------------------------------------------------------------------------------
// The view resource
// ---------------------------------------------------------------------------------------------

export const UI_MIME_TYPE = 'text/html;profile=mcp-app'
const UI_URI_PREFIX = 'ui://portfolio/dashboard'

/**
 * One view for every dashboard tool: the payload's `view` field picks the layout, which is what
 * lets a company drill-in or a period change redraw in place.
 *
 * The content hash is in the URI because hosts cache a `ui://` resource by its address. A new
 * build is a new address, so no host keeps showing the previous release's view.
 */
export const DASHBOARD_RESOURCE_URI = `${UI_URI_PREFIX}-${DASHBOARD_HTML_HASH}.html`

/**
 * What the view may load from the network: nothing. It is one self-contained document that talks
 * only to its host over postMessage, so every CSP list is empty. If that ever stops being true,
 * the origin has to be declared here or the host will block it.
 */
const UI_RESOURCE_META = {
  ui: {
    csp: { connectDomains: [] as string[], resourceDomains: [] as string[] },
    prefersBorder: true,
  },
}

export function listResources() {
  return {
    resources: [{
      uri: DASHBOARD_RESOURCE_URI,
      name: 'portfolio-dashboard',
      title: 'Portfolio dashboards',
      description: 'The interactive view for the portfolio, company, financial statement and LP dashboards.',
      mimeType: UI_MIME_TYPE,
      _meta: UI_RESOURCE_META,
    }],
  }
}

/**
 * The view's HTML, or null for a URI that is not ours.
 *
 * Any `ui://portfolio/dashboard…` address is answered with the CURRENT build, under the address
 * that was asked for: a host holding a tool list from before a deploy still gets a view that
 * understands today's payloads, instead of a not-found in the middle of a conversation.
 */
export function readResource(uri: unknown) {
  if (typeof uri !== 'string' || !uri.startsWith(UI_URI_PREFIX) || !uri.endsWith('.html')) return null
  return {
    contents: [{ uri, mimeType: UI_MIME_TYPE, text: DASHBOARD_HTML, _meta: UI_RESOURCE_META }],
  }
}

// ---------------------------------------------------------------------------------------------
// tools/list
// ---------------------------------------------------------------------------------------------

/** Dashboard writes touch only the caller's own saved list; say which of them removes something. */
const DESTRUCTIVE: Record<string, boolean> = { save_dashboard: false, delete_dashboard: true }

/**
 * A tool as `tools/list` describes it.
 *
 * `annotations` are hints for the host's approval prompts (ChatGPT requires them). `readOnlyHint`
 * follows the tool's scope; `openWorldHint` is false throughout because every tool here reads or
 * writes this fund's own records and nothing beyond them.
 */
export function describeTool(tool: McpTool) {
  const annotations: Record<string, boolean> = { readOnlyHint: tool.scope === 'read', openWorldHint: false }
  if (tool.name in DESTRUCTIVE) annotations.destructiveHint = DESTRUCTIVE[tool.name]

  const described: Record<string, unknown> = {
    name: tool.name,
    description: tool.description,
    inputSchema: tool.inputSchema,
    annotations,
  }
  if (isUi(tool)) {
    described._meta = {
      ui: { resourceUri: DASHBOARD_RESOURCE_URI },
      // The flat key the extension used before `_meta.ui`, still read by some hosts.
      'ui/resourceUri': DASHBOARD_RESOURCE_URI,
      // ChatGPT's alias for the same thing, and the status line it shows while the tool runs.
      'openai/outputTemplate': DASHBOARD_RESOURCE_URI,
      'openai/toolInvocation/invoking': 'Loading dashboard',
      'openai/toolInvocation/invoked': 'Dashboard ready',
    }
  }
  return described
}

/**
 * Filtered by what the credential's owner may actually reach, so an agent is never shown a tool
 * it would be refused, and the list is not a map of the fund's contents to someone who cannot
 * read them.
 */
export function listableTools(access: AccessContext): McpTool[] {
  return MCP_TOOLS.filter(tool => {
    // A member's own saved dashboards: every member lists and opens them; changing them needs a
    // role that may change things, which the read-only demo (`viewer`) is not.
    if (isPersonal(tool)) return tool.scope === 'read' || access.role !== 'viewer'
    return hasAccess(access, accessDomainFor(tool), tool.scope, accessFeatureFor(tool))
  })
}

// ---------------------------------------------------------------------------------------------
// tools/call
// ---------------------------------------------------------------------------------------------

/** Null when the call may run; otherwise the refusal. The one authorization path for MCP. */
export function authorizeMcpTool(tool: McpTool, auth: ResolvedKey, access: AccessContext, args: unknown): string | null {
  if (isPersonal(tool)) {
    if (tool.scope === 'write') {
      // The credential's own ceiling still holds: a read-only connection was told it "cannot
      // change anything", and that includes its owner's list of dashboards.
      if (!auth.scopes.includes('write')) return 'This credential is read-only.'
      if (access.role === 'viewer') return 'The read-only demo cannot save or delete dashboards.'
    }
    return null
  }
  // The CALL's domain, not just the tool's: `allocation` is ordinary accounting until its action
  // is 'carry'.
  return authorizeToolUse(tool.scope, auth, access, accessDomainForCall(tool, args), accessFeatureFor(tool))
}

/**
 * A handler's return value as an MCP tool result.
 *
 * For a dashboard tool the payload goes out twice. `structuredContent` is the whole payload, for
 * the view. `content` is the figures as JSON text, for the model: hosts disagree on whether the
 * model reads `structuredContent`, and the text is also everything a host without MCP Apps shows.
 * The fund's theme is left out of the text; it is presentation, not something to reason over.
 */
export function toolResult(tool: McpTool, result: unknown) {
  if (isUi(tool) && isDashboardPayload(result)) {
    const forModel = {
      dashboard: result.title,
      view: result.view,
      scope: result.subtitle,
      arguments: result.args,
      data: result.data,
    }
    return {
      content: [{ type: 'text', text: JSON.stringify(forModel) }],
      structuredContent: result,
    }
  }
  return { content: [{ type: 'text', text: JSON.stringify(result) }] }
}
