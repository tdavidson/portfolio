// Two entry points that never change: `search_tools` and `call_tool`.
//
// The MCP endpoint rebuilds its tool list on every request, but a chat host fetches `tools/list`
// once per conversation and keeps it. This server is stateless JSON (GET is 405), so it cannot send
// `notifications/tools/list_changed` either. A tool added by a deploy (update_investment, say) is
// therefore invisible to every conversation already open until someone starts a new one.
//
// These two tools close that gap from the inside. Their names and schemas are fixed, so every
// cached list already holds them: `search_tools` reads the CURRENT list, filtered exactly as
// `tools/list` is, and `call_tool` runs any tool on it by name through the same path a direct
// `tools/call` takes (lib/mcp-apps/call.ts). They are an MCP concern only: /api/agent's manifest is
// fetched per request and its POST takes any tool by name, so it has nothing to cache.

import { createHash } from 'node:crypto'
import type { AccessContext } from '@/lib/access/effective'
import type { ResolvedKey } from '@/lib/accounting/api-keys'
import { getTool } from '@/lib/accounting/agent-tools'
import { hasDraftMode, isAssistantCredential } from '@/lib/agent/dispatch'
import { CALL_TOOL, SEARCH_TOOLS } from './gateway-names'
import { describeTool, listableTools, type McpTool } from './server'

export { CALL_TOOL, SEARCH_TOOLS, isGatewayTool } from './gateway-names'

/**
 * The gateway tools as `tools/list` describes them.
 *
 * Neither carries a `scope` like the registry's tools, on purpose. `search_tools` only reads the
 * tool list. `call_tool` has no authority of its own: the scope of a call through it is the scope
 * of the tool it names, and that tool is authorized at call time exactly as a direct call would be
 * (read-only credential, grants, admin-only, staging). It is listed for every credential, as a read
 * would be, so that a read-only connection can still reach a read tool it does not have cached;
 * and it is annotated as possibly destructive, so a host asks before running it rather than
 * treating it as a read. The rate limit buckets it by the named tool too (gatewayTargetName).
 */
export const GATEWAY_TOOLS = [
  {
    name: SEARCH_TOOLS,
    description:
      'Find tools on this server, including ones added since this conversation started (your tool list may be cached). ' +
      'With no query, lists every tool you may use with a one-line description. With query, ranks tools by keyword. ' +
      'With names, returns those tools in full: description, inputSchema, scope (read or write), whether a write from ' +
      'this connection is staged for approval, and annotations. Also returns toolListVersion, which changes whenever the ' +
      'list does. Run a tool you found with call_tool.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Keywords matched against tool names and descriptions, e.g. "update investment".' },
        names: { type: 'array', items: { type: 'string' }, description: 'Exact tool names to describe in full.' },
        limit: { type: 'integer', minimum: 1, maximum: 50, description: 'Most results to return for a query (default 10).' },
      },
    },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  {
    name: CALL_TOOL,
    description:
      'Run any tool on this server by name, with the same checks, approvals and results as calling it directly. ' +
      'Use it for a tool search_tools found that is not in your own tool list. Pass the tool\'s arguments as "arguments". ' +
      'A change may come back staged for approval, as a direct call would.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'The tool to run, e.g. "update_investment".' },
        arguments: { type: 'object', description: 'The tool\'s own arguments, per its inputSchema from search_tools.' },
      },
      required: ['name'],
    },
    // Not read-only: what it does is whatever the named tool does.
    annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false },
  },
] as const

/**
 * The tool a `tools/call` will actually run: the named one, or for `call_tool` the one it names.
 * The rate limiter reads this, so a write through `call_tool` is metered as a write.
 */
export function gatewayTargetName(params: any): unknown {
  return params?.name === CALL_TOOL ? params?.arguments?.name : params?.name
}

/** Everything `tools/list` serves this caller: the tools they may reach, then the gateway. */
export function listedTools(access: AccessContext): Record<string, unknown>[] {
  return [...listableTools(access).map(describeTool), ...GATEWAY_TOOLS]
}

const versions = new Map<string, string>()

/**
 * A short hash of the tool list this caller is served (names, descriptions, schemas, annotations).
 * It changes when a deploy changes a tool and when the caller's grants change what they see, so a
 * client holding an older value knows its cached list is stale. Memoized per set of tool names:
 * within one build, the names decide the rest.
 */
export function toolListVersion(access: AccessContext): string {
  const names = listableTools(access).map(t => t.name).join(',')
  let version = versions.get(names)
  if (!version) {
    version = createHash('sha256').update(JSON.stringify(listedTools(access))).digest('hex').slice(0, 12)
    versions.set(names, version)
  }
  return version
}

/** The first sentence of a description, for the compact listing. */
function oneLine(description: string): string {
  const first = description.split(/(?<=[.!?])\s/)[0] ?? description
  return first.length > 160 ? `${first.slice(0, 157)}...` : first
}

/** What a call would do from this credential, so the model can tell the person before it asks. */
function effectFor(tool: McpTool, auth: ResolvedKey): Record<string, unknown> {
  if (tool.scope === 'read') return { staged: false }
  if (!auth.scopes.includes('write')) return { staged: false, refused: 'This credential is read-only.' }
  // Only the shared registry's writes stage (lib/agent/dispatch.ts); approving a pending action or
  // saving one's own dashboard applies at once. A destructive one stages from every credential.
  const agentTool = getTool(tool.name)
  if (agentTool?.destructive) return { staged: true, destructive: true, note: 'Always waits for an admin\'s approval, from any connection or key.' }
  if (!agentTool || !isAssistantCredential(auth)) return { staged: false }
  if (agentTool.runsDirectly) return { staged: false, note: 'Changes no record; the tool that takes its result in waits for approval.' }
  return hasDraftMode(tool.name)
    ? { staged: true, note: 'Calls that only make drafts or previews run directly; the rest wait for approval.' }
    : { staged: true }
}

function detailed(tool: McpTool, auth: ResolvedKey) {
  const described = describeTool(tool)
  return {
    name: tool.name,
    description: tool.description,
    inputSchema: tool.inputSchema,
    scope: tool.scope,
    ...effectFor(tool, auth),
    annotations: described.annotations,
    ...(described._meta ? { _meta: described._meta } : {}),
  }
}

const words = (s: string) => s.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean)

/** Keyword score: a word in the name counts far more than one in the description. */
function score(tool: McpTool, terms: string[]): number {
  const name = tool.name.toLowerCase()
  const nameWords = new Set(words(tool.name))
  const description = tool.description.toLowerCase()
  let total = 0
  for (const term of terms) {
    if (name === term) total += 20
    else if (nameWords.has(term)) total += 6
    else if (name.includes(term)) total += 3
    if (description.includes(term)) total += 1
  }
  return total
}

function editDistance(a: string, b: string): number {
  const row = Array.from({ length: b.length + 1 }, (_, i) => i)
  for (let i = 1; i <= a.length; i++) {
    let prev = row[0]
    row[0] = i
    for (let j = 1; j <= b.length; j++) {
      const next = Math.min(row[j] + 1, row[j - 1] + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1))
      prev = row[j]
      row[j] = next
    }
  }
  return row[b.length]
}

/**
 * The names this caller may use that look most like `name`: a small edit distance, or sharing a
 * word with it. Only listable tools, so a refusal never names a tool the caller cannot see.
 */
export function closeMatches(name: string, access: AccessContext, max = 5): string[] {
  const wanted = name.toLowerCase()
  const terms = words(name)
  return listableTools(access)
    .map(t => {
      const distance = editDistance(wanted, t.name)
      const shared = words(t.name).filter(w => terms.includes(w)).length
      return { name: t.name, distance, shared }
    })
    .filter(m => m.distance <= Math.max(2, Math.floor(wanted.length / 4)) || m.shared > 0)
    .sort((a, b) => a.distance - b.distance || b.shared - a.shared || a.name.localeCompare(b.name))
    .slice(0, max)
    .map(m => m.name)
}

export interface SearchToolsInput { query?: unknown; names?: unknown; limit?: unknown }

/** `search_tools`: the current tool list, as this caller may use it. */
export function searchTools(input: SearchToolsInput, auth: ResolvedKey, access: AccessContext) {
  const tools = listableTools(access)
  const version = toolListVersion(access)
  const next = 'Run any of these with call_tool { name, arguments }.'

  const names = Array.isArray(input?.names) ? input.names.filter((n): n is string => typeof n === 'string') : []
  if (names.length) {
    const found = names.map(n => tools.find(t => t.name === n)).filter((t): t is McpTool => !!t)
    const notFound = names
      .filter(n => !tools.some(t => t.name === n))
      .map(n => ({ name: n, didYouMean: closeMatches(n, access) }))
    return { toolListVersion: version, tools: found.map(t => detailed(t, auth)), ...(notFound.length ? { notFound } : {}), next }
  }

  const query = typeof input?.query === 'string' ? input.query.trim() : ''
  if (!query) {
    return {
      toolListVersion: version,
      count: tools.length,
      tools: tools.map(t => ({ name: t.name, scope: t.scope, description: oneLine(t.description) })),
      next: 'Pass names to get a tool\'s full description and inputSchema, then run it with call_tool.',
    }
  }

  const limit = typeof input?.limit === 'number' && Number.isFinite(input.limit) ? Math.min(50, Math.max(1, Math.floor(input.limit))) : 10
  const terms = words(query)
  const ranked = tools
    .map(t => ({ t, s: score(t, terms) }))
    .filter(r => r.s > 0)
    .sort((a, b) => b.s - a.s || a.t.name.localeCompare(b.t.name))
    .slice(0, limit)
  return { toolListVersion: version, query, tools: ranked.map(r => detailed(r.t, auth)), next }
}
