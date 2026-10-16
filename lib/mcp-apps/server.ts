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
import { PENDING_TOOLS, type PendingTool } from '@/lib/agent/pending-tools'
import { isToolOffered } from '@/lib/agent/destructive'
import { DASHBOARD_HTML, DASHBOARD_HTML_HASH } from './dashboard-html.generated'
import { isDashboardPayload } from './payload'

export type McpTool = AgentTool | DashboardTool | PendingTool

/**
 * Everything the MCP endpoint serves: the shared registry, the dashboard tools, and the approval
 * tools a staged write is confirmed with (lib/agent/pending-tools.ts).
 */
export const MCP_TOOLS: McpTool[] = [...AGENT_TOOLS, ...DASHBOARD_TOOLS, ...PENDING_TOOLS]

export function getMcpTool(name: unknown): McpTool | undefined {
  return typeof name === 'string' ? MCP_TOOLS.find(t => t.name === name) : undefined
}

/** The access predicate the getting-started catalog filters by (lib/agent/getting-started.ts). */
export function canReadFor(access: AccessContext) {
  return (domain: Parameters<typeof hasAccess>[1], feature?: Parameters<typeof hasAccess>[3]) => hasAccess(access, domain, 'read', feature)
}

const isUi = (tool: McpTool) => (tool as DashboardTool).ui === true
const isPersonal = (tool: McpTool) => (tool as DashboardTool).personal === true
export const isPendingTool = (tool: McpTool): tool is PendingTool => (tool as PendingTool).pendingDecision === true

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
const DESTRUCTIVE: Record<string, boolean> = {
  save_dashboard: false, delete_dashboard: true,
  // Approving applies a change to the fund's records; hosts should ask before running it.
  approve_action: true, reject_action: false,
  // Staging a run writes nothing but the proposal; approving it is the destructive act.
  stage_run: false,
}

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
  // Deletes, merges and undoing posted books (lib/agent/destructive.ts).
  if ((tool as AgentTool).destructive) annotations.destructiveHint = true

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
    // The approval tools are offered to anyone who could have something waiting; which actions
    // they may see or decide is the service's question, per action.
    if (isPendingTool(tool)) return tool.scope === 'read' || access.role !== 'viewer'
    // A member's own saved dashboards: every member lists and opens them; changing them needs a
    // role that may change things, which the read-only demo (`viewer`) is not.
    if (isPersonal(tool)) return tool.scope === 'read' || access.role !== 'viewer'
    // Destructive tools only where the deployment turned them on (AGENT_DESTRUCTIVE_ACTIONS). This
    // list feeds tools/list, search_tools and call_tool's suggestions alike.
    if (!isToolOffered(tool as AgentTool)) return false
    return hasAccess(access, accessDomainFor(tool), tool.scope, accessFeatureFor(tool))
  })
}

// ---------------------------------------------------------------------------------------------
// tools/call
// ---------------------------------------------------------------------------------------------

/** Null when the call may run; otherwise the refusal. The one authorization path for MCP. */
export function authorizeMcpTool(tool: McpTool, auth: ResolvedKey, access: AccessContext, args: unknown): string | null {
  if (isPendingTool(tool)) {
    // The credential's ceiling holds here too: a read-only connection approves nothing. The
    // approver's write access to each action's own domain is checked by the service.
    if (tool.scope === 'write') {
      if (!auth.scopes.includes('write')) return 'This credential is read-only.'
      if (access.role === 'viewer') return 'The read-only demo cannot approve or reject changes.'
    }
    return null
  }
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
/**
 * A handler result that is MCP content itself: an image a tool hands the caller's own model to
 * read (`ocr_page`). Passed through as content blocks rather than JSON-encoded, which a model
 * cannot see as an image.
 */
export interface McpContentResult {
  mcpContent: ({ type: 'text'; text: string } | { type: 'image'; data: string; mimeType: string })[]
}

function isMcpContent(result: unknown): result is McpContentResult {
  return !!result && typeof result === 'object' && Array.isArray((result as McpContentResult).mcpContent)
}

export function toolResult(tool: McpTool, result: unknown) {
  if (isMcpContent(result)) return { content: result.mcpContent }
  if (isUi(tool) && isDashboardPayload(result) && result.view === 'home') {
    return { content: [{ type: 'text', text: result.data.help }], structuredContent: result }
  }
  // The model sent these figures; echoing them back would only double the context. A host without
  // MCP Apps shows this line, so it says what was drawn.
  if (isUi(tool) && isDashboardPayload(result) && result.view === 'chart') {
    const text = `Drew "${result.title}": ${result.data.points.length} ${result.data.kind === 'bar' ? 'bars' : 'points'} of ${result.data.measure}. ` +
      'If the chart does not appear, this host cannot draw it; give the figures as a table instead.'
    return { content: [{ type: 'text', text }], structuredContent: result }
  }
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
