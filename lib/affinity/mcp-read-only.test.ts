import { describe, it, expect, beforeEach, vi } from 'vitest'
import { affinityMcpServerReadOnly, clearAffinityReadToolCache } from './tools'

/** A fake MCP server answering initialize and tools/list with these tools. */
function server(tools: Array<{ name: string; annotations?: Record<string, boolean> }>) {
  return vi.fn(async (_url: string, init: { body: string }) => {
    const msg = JSON.parse(init.body)
    const result = msg.method === 'tools/list' ? { tools } : {}
    return new Response(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result }), { status: 200, headers: { 'content-type': 'application/json' } })
  }) as any
}

describe('affinityMcpServerReadOnly — the hosted Affinity server never gets its write tools', () => {
  beforeEach(() => clearAffinityReadToolCache())

  it('enables only the tools that read', async () => {
    const fetchImpl = server([
      { name: 'search_companies', annotations: { readOnlyHint: true } },
      { name: 'create_note', annotations: { readOnlyHint: false } },
      { name: 'get_list_entries' },
      { name: 'update_field_value' },
    ])
    const config = await affinityMcpServerReadOnly('key-1', { fetchImpl })
    expect(config?.allowedTools).toEqual(['get_list_entries', 'search_companies'])
    expect(config?.authorizationToken).toBe('key-1')
  })

  it('is null when the tool list cannot be read, or has nothing read-only, so the caller falls back to the built-in tools', async () => {
    const failing = vi.fn(async () => { throw new Error('offline') }) as any
    expect(await affinityMcpServerReadOnly('key-2', { fetchImpl: failing })).toBeNull()
    expect(await affinityMcpServerReadOnly('key-3', { fetchImpl: server([{ name: 'create_note' }]) })).toBeNull()
  })

  it('lists the tools once an hour per key', async () => {
    const fetchImpl = server([{ name: 'search_companies' }])
    await affinityMcpServerReadOnly('key-4', { fetchImpl, now: 0 })
    const calls = fetchImpl.mock.calls.length
    await affinityMcpServerReadOnly('key-4', { fetchImpl, now: 30 * 60 * 1000 })
    expect(fetchImpl.mock.calls.length).toBe(calls)
    await affinityMcpServerReadOnly('key-4', { fetchImpl, now: 61 * 60 * 1000 })
    expect(fetchImpl.mock.calls.length).toBeGreaterThan(calls)
  })
})
