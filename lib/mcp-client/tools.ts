import type { FetchLike } from './oauth'

/**
 * Asks an MCP server which tools it has, so the app can turn on only the read-only ones.
 *
 * The app never runs these tools itself: Anthropic's MCP connector calls them while Claude
 * answers, and the app doesn't see those calls. That means a write tool would skip the staged
 * approval and audit trail every other change goes through. So the app reads the tool list once
 * at connect time (and again when it goes stale), keeps the read-only names, and passes only
 * those to Claude (McpServerConfig.allowedTools).
 *
 * A minimal streamable-HTTP client: initialize, initialized, tools/list (paged). A reply can come
 * back as plain JSON or as a short server-sent-event stream; both are handled.
 */

export interface McpToolInfo {
  name: string
  annotations?: { readOnlyHint?: boolean; destructiveHint?: boolean } | null
}

const PROTOCOL_VERSION = '2025-06-18'
const TIMEOUT_MS = 15_000

/** Names that read, for a server that doesn't annotate its tools. */
const READ_NAME = /^(get|find|search|list|lookup|resolve|read|fetch|describe)_/

/**
 * Whether a tool may run without staging. The server's own readOnlyHint wins when it gives one;
 * otherwise only names that plainly read pass. Anything unclear is left off.
 */
export function isReadOnlyTool(tool: McpToolInfo): boolean {
  const hint = tool.annotations?.readOnlyHint
  if (typeof hint === 'boolean') return hint
  return READ_NAME.test(tool.name)
}

/** The JSON-RPC message with this id, from a JSON body or an SSE stream. */
export function parseRpcReply(contentType: string | null, text: string, id: number): Record<string, any> | null {
  const candidates: unknown[] = []
  if ((contentType ?? '').includes('text/event-stream')) {
    for (const event of text.split(/\r?\n\r?\n/)) {
      const data = event.split(/\r?\n/).filter(l => l.startsWith('data:')).map(l => l.slice(5).trimStart()).join('\n')
      if (!data) continue
      try { candidates.push(JSON.parse(data)) } catch { /* skip a malformed event */ }
    }
  } else {
    try {
      const parsed = JSON.parse(text)
      candidates.push(...(Array.isArray(parsed) ? parsed : [parsed]))
    } catch { /* not JSON */ }
  }
  for (const c of candidates) {
    if (c && typeof c === 'object' && (c as any).id === id) return c as Record<string, any>
  }
  return null
}

export class McpToolsError extends Error {
  constructor(public readonly status: number | null, message: string) {
    super(message)
    this.name = 'McpToolsError'
  }
}

export async function listMcpTools(url: string, accessToken: string, fetchImpl: FetchLike = fetch): Promise<McpToolInfo[]> {
  let sessionId: string | null = null
  let nextId = 1

  const post = async (message: Record<string, unknown>): Promise<Response> => {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
      Authorization: `Bearer ${accessToken}`,
      'MCP-Protocol-Version': PROTOCOL_VERSION,
    }
    if (sessionId) headers['Mcp-Session-Id'] = sessionId
    try {
      return await fetchImpl(url, {
        method: 'POST',
        headers,
        body: JSON.stringify(message),
        signal: AbortSignal.timeout(TIMEOUT_MS),
        redirect: 'error',
      })
    } catch {
      throw new McpToolsError(null, 'Could not reach the MCP server.')
    }
  }

  const call = async (method: string, params: Record<string, unknown>): Promise<Record<string, any>> => {
    const id = nextId++
    const res = await post({ jsonrpc: '2.0', id, method, params })
    if (!res.ok) throw new McpToolsError(res.status, `The MCP server answered ${method} with HTTP ${res.status}.`)
    sessionId = res.headers.get('mcp-session-id') ?? sessionId
    const reply = parseRpcReply(res.headers.get('content-type'), await res.text(), id)
    if (!reply) throw new McpToolsError(res.status, `The MCP server sent no reply to ${method}.`)
    if (reply.error) throw new McpToolsError(res.status, `The MCP server refused ${method}.`)
    return reply.result ?? {}
  }

  await call('initialize', {
    protocolVersion: PROTOCOL_VERSION,
    capabilities: {},
    clientInfo: { name: 'portfolio', version: '1.0.0' },
  })
  await post({ jsonrpc: '2.0', method: 'notifications/initialized' })

  const tools: McpToolInfo[] = []
  let cursor: string | undefined
  for (let page = 0; page < 20; page++) {
    const result = await call('tools/list', cursor ? { cursor } : {})
    for (const t of Array.isArray(result.tools) ? result.tools : []) {
      if (t && typeof t.name === 'string') tools.push({ name: t.name, annotations: t.annotations ?? null })
    }
    cursor = typeof result.nextCursor === 'string' && result.nextCursor ? result.nextCursor : undefined
    if (!cursor) break
  }
  return tools
}
