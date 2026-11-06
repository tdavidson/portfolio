import { describe, it, expect } from 'vitest'
import type Anthropic from '@anthropic-ai/sdk'
import { withCachedTail } from './anthropic'

const EPHEMERAL = { type: 'ephemeral' }

describe('withCachedTail', () => {
  it('turns a string tail into a marked text block and leaves the input untouched', () => {
    const messages: Anthropic.MessageParam[] = [
      { role: 'user', content: 'first' },
      { role: 'assistant', content: 'reply' },
      { role: 'user', content: 'follow-up' },
    ]
    const out = withCachedTail(messages)
    expect(out[2]).toEqual({ role: 'user', content: [{ type: 'text', text: 'follow-up', cache_control: EPHEMERAL }] })
    expect(out[0]).toBe(messages[0])
    expect(messages[2].content).toBe('follow-up')
  })

  it('marks the last tool_result of a tool round', () => {
    const messages: Anthropic.MessageParam[] = [
      { role: 'user', content: 'q' },
      { role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'x', input: {} }, { type: 'tool_use', id: 't2', name: 'x', input: {} }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'a' }, { type: 'tool_result', tool_use_id: 't2', content: 'b' }] },
    ]
    const out = withCachedTail(messages)
    const blocks = out[2].content as Anthropic.ToolResultBlockParam[]
    expect(blocks[0].cache_control).toBeUndefined()
    expect(blocks[1].cache_control).toEqual(EPHEMERAL)
    expect((messages[2].content as Anthropic.ToolResultBlockParam[])[1].cache_control).toBeUndefined()
  })

  it('adds at most one marker however many rounds reuse the same history', () => {
    const messages: Anthropic.MessageParam[] = [{ role: 'user', content: 'q' }]
    withCachedTail(messages)
    messages.push({ role: 'assistant', content: 'a' }, { role: 'user', content: 'b' })
    const out = withCachedTail(messages)
    const marked = JSON.stringify(out).split('cache_control').length - 1
    expect(marked).toBe(1)
  })

  it('leaves empty and already-marked tails alone', () => {
    const empty: Anthropic.MessageParam[] = [{ role: 'user', content: '' }]
    expect(withCachedTail(empty)).toBe(empty)
    const marked: Anthropic.MessageParam[] = [
      { role: 'user', content: [{ type: 'text', text: 'doc', cache_control: { type: 'ephemeral' } }] },
    ]
    expect(withCachedTail(marked)).toBe(marked)
    expect(withCachedTail([])).toEqual([])
  })
})

describe('createToolLoop with MCP servers', () => {
  async function run(mcpServers: Array<{ name: string; url: string; authorizationToken?: string; allowedTools?: string[] }>, content: any[]) {
    const { AnthropicProvider } = await import('./anthropic')
    const provider = new AnthropicProvider('test-key')
    const requests: any[] = []
    ;(provider as any).client = {
      beta: {
        messages: {
          stream: (req: any) => {
            requests.push(req)
            return { finalMessage: async () => ({ content, stop_reason: 'end_turn', usage: { input_tokens: 1, output_tokens: 1 } }) }
          },
        },
      },
    }
    const result = await provider.createToolLoop({ model: 'claude-test', maxTokens: 100, content: 'q', mcpServers })
    return { request: requests[0], result }
  }

  it('turns on only the allowlisted tools', async () => {
    const { request } = await run([{ name: 'specter', url: 'https://mcp.data.example/mcp', authorizationToken: 't', allowedTools: ['find_company', 'get_company_funding'] }], [{ type: 'text', text: 'ok' }])
    expect(request.tools).toEqual([{
      type: 'mcp_toolset',
      mcp_server_name: 'specter',
      default_config: { enabled: false },
      configs: { find_company: { enabled: true }, get_company_funding: { enabled: true } },
    }])
    expect(request.mcp_servers).toEqual([{ type: 'url', name: 'specter', url: 'https://mcp.data.example/mcp', authorization_token: 't' }])
  })

  it('leaves every tool on when there is no allowlist', async () => {
    const { request } = await run([{ name: 'affinity', url: 'https://crm.example/mcp' }], [{ type: 'text', text: 'ok' }])
    expect(request.tools).toEqual([{ type: 'mcp_toolset', mcp_server_name: 'affinity' }])
  })

  it('records the calls the connector made', async () => {
    const { result } = await run([{ name: 'specter', url: 'https://mcp.data.example/mcp', allowedTools: ['find_company'] }], [
      { type: 'mcp_tool_use', id: 'm1', name: 'find_company', server_name: 'specter', input: { domain: 'acme.example' } },
      { type: 'mcp_tool_result', tool_use_id: 'm1', is_error: false, content: [{ type: 'text', text: 'Acme' }] },
      { type: 'text', text: 'Acme is…' },
    ])
    expect(result.toolCalls).toEqual([{ name: 'find_company', input: { domain: 'acme.example' }, resultPreview: 'Acme', isError: false, server: 'specter' }])
    expect(result.text).toBe('Acme is…')
  })
})
