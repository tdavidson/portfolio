import { describe, it, expect } from 'vitest'
import { isReadOnlyTool, listMcpTools, parseRpcReply } from './tools'
import type { FetchLike } from './oauth'

describe('isReadOnlyTool', () => {
  it('trusts the server’s readOnlyHint either way', () => {
    expect(isReadOnlyTool({ name: 'create_list', annotations: { readOnlyHint: true } })).toBe(true)
    expect(isReadOnlyTool({ name: 'get_lists', annotations: { readOnlyHint: false } })).toBe(false)
  })

  it('falls back to names that plainly read', () => {
    expect(isReadOnlyTool({ name: 'find_company' })).toBe(true)
    expect(isReadOnlyTool({ name: 'get_company_competitors', annotations: {} })).toBe(true)
    expect(isReadOnlyTool({ name: 'create_list' })).toBe(false)
    expect(isReadOnlyTool({ name: 'add_to_list' })).toBe(false)
    expect(isReadOnlyTool({ name: 'company' })).toBe(false)
  })
})

describe('parseRpcReply', () => {
  it('reads plain JSON and SSE replies', () => {
    expect(parseRpcReply('application/json', '{"jsonrpc":"2.0","id":2,"result":{"ok":true}}', 2)?.result).toEqual({ ok: true })
    const sse = 'event: message\ndata: {"jsonrpc":"2.0","method":"notifications/progress"}\n\nevent: message\ndata: {"jsonrpc":"2.0","id":3,"result":{"tools":[]}}\n\n'
    expect(parseRpcReply('text/event-stream', sse, 3)?.result).toEqual({ tools: [] })
    expect(parseRpcReply('application/json', 'nope', 1)).toBeNull()
  })
})

describe('listMcpTools', () => {
  it('initializes, keeps the session id and pages through tools/list', async () => {
    const seen: Array<{ method: string; session: string | null; auth: string | null }> = []
    const impl: FetchLike = async (_url, init) => {
      const msg = JSON.parse(String(init?.body))
      const headers = new Headers(init?.headers)
      seen.push({ method: msg.method, session: headers.get('mcp-session-id'), auth: headers.get('authorization') })
      if (msg.method === 'initialize') {
        return new Response(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { protocolVersion: '2025-06-18' } }), {
          headers: { 'content-type': 'application/json', 'mcp-session-id': 'sess-1' },
        })
      }
      if (msg.method === 'notifications/initialized') return new Response(null, { status: 202 })
      const page = msg.params?.cursor
        ? { tools: [{ name: 'create_list', annotations: { readOnlyHint: false } }] }
        : { tools: [{ name: 'find_company', annotations: { readOnlyHint: true } }], nextCursor: 'p2' }
      return new Response(`event: message\ndata: ${JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: page })}\n\n`, {
        headers: { 'content-type': 'text/event-stream' },
      })
    }
    const tools = await listMcpTools('https://mcp.data.example/mcp', 'token-1', impl)
    expect(tools.map(t => t.name)).toEqual(['find_company', 'create_list'])
    expect(seen.map(s => s.method)).toEqual(['initialize', 'notifications/initialized', 'tools/list', 'tools/list'])
    expect(seen.slice(1).every(s => s.session === 'sess-1')).toBe(true)
    expect(seen.every(s => s.auth === 'Bearer token-1')).toBe(true)
  })

  it('fails loudly on an HTTP error', async () => {
    const impl: FetchLike = async () => new Response('no', { status: 401 })
    await expect(listMcpTools('https://mcp.data.example/mcp', 't', impl)).rejects.toMatchObject({ status: 401 })
  })
})
