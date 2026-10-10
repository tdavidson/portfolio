import Anthropic from '@anthropic-ai/sdk'
import { effortForModel } from './model-families'
import type {
  AIProvider, AIModel, AIResult, CreateMessageParams, CreateChatParams, ContentBlock,
  CreateToolLoopParams, ToolLoopResult, ToolCallRecord, AIEffort,
} from './types'

// Anthropic's MCP connector — lets the API connect to a remote MCP server
// (e.g. Affinity's hosted server) and run its tools server-side.
const MCP_BETA = 'mcp-client-2025-11-20'

export class AnthropicProvider implements AIProvider {
  private client: Anthropic

  readonly supportsToolLoop = true

  constructor(apiKey: string) {
    this.client = new Anthropic({ apiKey })
  }

  async createMessage(params: CreateMessageParams): Promise<AIResult> {
    const content = typeof params.content === 'string'
      ? params.content
      : toAnthropicContent(params.content)

    const tools = params.enableWebSearch
      ? [{
          type: 'web_search_20250305' as const,
          name: 'web_search',
          max_uses: params.webSearchMaxUses ?? 5,
        }]
      : undefined

    // Prompt caching: mark the (large, reused) system prompt as ephemeral. The
    // same system prompt — schemas, guidance, instructions — is resent across
    // every batched call within a stage (per-doc ingest, draft fills, checklist,
    // scoring), so caching it turns those into cache reads (~5 min TTL) instead
    // of re-billing the full prefix each time. One breakpoint on system also
    // caches the tools block ahead of it. Below the model's min cacheable size
    // the marker is simply ignored, so it's always safe to set.
    const systemBlocks = cacheableSystem(params.system)

    // Use the streaming endpoint via the SDK's `.stream()` helper. Anthropic
    // requires streaming for any request that may take longer than 10 minutes
    // (large max_tokens + slow models like Opus, or long web-search runs).
    // `finalMessage()` reassembles the complete response so the rest of the
    // pipeline sees the same shape as the legacy non-streaming call.
    const stream = this.client.messages.stream(
      {
        model: params.model,
        max_tokens: params.maxTokens,
        ...outputConfig(params.model, params.effort),
        ...(systemBlocks ? { system: systemBlocks } : {}),
        ...(tools ? { tools: tools as any } : {}),
        messages: [{ role: 'user', content }],
      },
      { signal: params.signal },
    )
    const response = await stream.finalMessage()

    // When web search runs server-side, the response interleaves
    // server_tool_use + web_search_tool_result blocks with text blocks. We
    // concatenate just the text — the model is instructed to bake any URLs
    // it relies on into the JSON output, so we don't need the tool results.
    const text = response.content
      .filter((b): b is Anthropic.TextBlock => b.type === 'text')
      .map(b => b.text)
      .join('')

    // Count actual web searches performed so callers can tell "tool attached
    // but model didn't search" from "model searched but found nothing".
    const webSearchCount = params.enableWebSearch
      ? response.content.filter((b: any) => b.type === 'web_search_tool_result').length
      : undefined

    // Anthropic attaches citations to text blocks as metadata (not in the text
    // itself). When the model produces JSON output, it usually doesn't echo
    // the citation URL into a JSON sources field — so we expose them here for
    // callers to merge in. Deduped by URL across blocks.
    let webSearchCitations: Array<{ url: string; title: string }> | undefined
    if (params.enableWebSearch) {
      const seen = new Set<string>()
      const out: Array<{ url: string; title: string }> = []
      for (const block of response.content) {
        if (block.type !== 'text') continue
        const cites = (block as any).citations as Array<{ type?: string; url?: string; title?: string }> | undefined
        if (!Array.isArray(cites)) continue
        for (const c of cites) {
          if (!c || typeof c.url !== 'string' || !c.url || seen.has(c.url)) continue
          seen.add(c.url)
          out.push({ url: c.url, title: typeof c.title === 'string' ? c.title : c.url })
        }
      }
      webSearchCitations = out
    }

    return {
      text,
      usage: {
        inputTokens: response.usage.input_tokens,
        outputTokens: response.usage.output_tokens,
        cacheReadTokens: response.usage.cache_read_input_tokens ?? 0,
        cacheCreationTokens: response.usage.cache_creation_input_tokens ?? 0,
      },
      truncated: response.stop_reason === 'max_tokens',
      webSearchCount,
      webSearchCitations,
    }
  }

  async createChat(params: CreateChatParams): Promise<AIResult> {
    const messages = params.messages.map(m => ({
      role: m.role as 'user' | 'assistant',
      content: m.content,
    }))

    const systemBlocks = cacheableSystem(params.system)

    // Same streaming-required reason as createMessage above.
    const stream = this.client.messages.stream(
      {
        model: params.model,
        max_tokens: params.maxTokens,
        ...outputConfig(params.model, params.effort),
        ...(systemBlocks ? { system: systemBlocks } : {}),
        messages,
      },
      { signal: params.signal },
    )
    const response = await stream.finalMessage()

    const text = response.content
      .filter((b): b is Anthropic.TextBlock => b.type === 'text')
      .map(b => b.text)
      .join('')

    return {
      text,
      usage: {
        inputTokens: response.usage.input_tokens,
        outputTokens: response.usage.output_tokens,
        cacheReadTokens: response.usage.cache_read_input_tokens ?? 0,
        cacheCreationTokens: response.usage.cache_creation_input_tokens ?? 0,
      },
      truncated: response.stop_reason === 'max_tokens',
    }
  }

  /**
   * Agentic tool-use loop.
   *
   * Two kinds of tools can be attached, and they execute in different places:
   *
   *   - Custom tools (`params.tools`) run HERE. The model emits tool_use, we run
   *     `executeTool`, and feed a tool_result back. This is the path used for
   *     Affinity by default: read-only, scoped to what we choose to expose.
   *
   *   - MCP servers (`params.mcpServers`) run on ANTHROPIC's side via the MCP
   *     connector. We never see the calls; they resolve before the response
   *     comes back. This is the path for Affinity's hosted MCP server, which
   *     exposes its full tool surface (including writes).
   *
   * The loop is bounded (`maxIterations`) so a model that keeps calling tools
   * can't spin forever on the user's dime.
   */
  async createToolLoop(params: CreateToolLoopParams): Promise<ToolLoopResult> {
    const customTools = params.tools ?? []
    const mcpServers = params.mcpServers ?? []
    const maxIterations = params.maxIterations ?? 6

    const toolDefs: any[] = [
      ...customTools.map(t => ({
        name: t.name,
        description: t.description,
        input_schema: t.inputSchema,
      })),
      // Each declared MCP server must be referenced by exactly one toolset entry,
      // or the API rejects the request.
      ...mcpServers.map(s => ({ type: 'mcp_toolset', mcp_server_name: s.name })),
    ]

    if (params.enableWebSearch) {
      toolDefs.push({
        type: 'web_search_20250305',
        name: 'web_search',
        max_uses: params.webSearchMaxUses ?? 5,
      })
    }

    const systemBlocks = cacheableSystem(params.system)

    // Seed from multi-turn history when the caller supplied it (chat surfaces); otherwise open
    // with the single `content` message (one-shot agentic calls).
    const messages: Anthropic.MessageParam[] = params.messages?.length
      ? params.messages.map(m => ({ role: m.role, content: m.content }))
      : [{
          role: 'user',
          content: typeof params.content === 'string' ? params.content : toAnthropicContent(params.content ?? []),
        }]

    const toolCalls: ToolCallRecord[] = []
    const usage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0 }
    let finalText = ''
    let truncated = false
    let stoppedAtLimit = false

    for (let i = 0; i < maxIterations; i++) {
      params.signal?.throwIfAborted()
      try { params.onRound?.(i) } catch { /* a broken progress transport must not fail the run */ }
      const request: any = {
        model: params.model,
        max_tokens: params.maxTokens,
        ...outputConfig(params.model, params.effort),
        ...(systemBlocks ? { system: systemBlocks } : {}),
        ...(toolDefs.length > 0 ? { tools: toolDefs } : {}),
        messages,
      }

      // The MCP connector is a beta surface and needs both the flag and the
      // server list; without the beta header the mcp_servers param is rejected.
      let response: Anthropic.Message
      if (mcpServers.length > 0) {
        const stream = (this.client as any).beta.messages.stream({
          ...request,
          betas: [MCP_BETA],
          mcp_servers: mcpServers.map(s => ({
            type: 'url',
            name: s.name,
            url: s.url,
            ...(s.authorizationToken ? { authorization_token: s.authorizationToken } : {}),
          })),
        }, { signal: params.signal })
        response = await stream.finalMessage()
      } else {
        const stream = this.client.messages.stream(request, { signal: params.signal })
        response = await stream.finalMessage()
      }

      // Usage accumulates across the loop — a single "answer" may cost several
      // round-trips, and billing the user for only the last one would understate
      // the true cost.
      usage.inputTokens += response.usage.input_tokens
      usage.outputTokens += response.usage.output_tokens
      usage.cacheReadTokens += response.usage.cache_read_input_tokens ?? 0
      usage.cacheCreationTokens += response.usage.cache_creation_input_tokens ?? 0

      const text = response.content
        .filter((b): b is Anthropic.TextBlock => b.type === 'text')
        .map(b => b.text)
        .join('')
      if (text) finalText = text

      if (response.stop_reason === 'max_tokens') truncated = true

      const pending = response.content.filter(
        (b): b is Anthropic.ToolUseBlock => b.type === 'tool_use'
      )

      // No client-side tool calls left to service — MCP and web-search calls have
      // already resolved server-side by the time we get here.
      if (pending.length === 0) break
      if (i === maxIterations - 1) stoppedAtLimit = true

      messages.push({ role: 'assistant', content: response.content })

      // Run the requested tools. All results go back in ONE user message —
      // splitting them across messages teaches the model to stop calling tools
      // in parallel.
      const results: Anthropic.ToolResultBlockParam[] = []
      for (const call of pending) {
        params.signal?.throwIfAborted()
        const input = (call.input ?? {}) as Record<string, unknown>
        let resultText: string
        let isError = false

        if (!params.executeTool) {
          resultText = 'No tool executor is configured.'
          isError = true
        } else {
          try {
            resultText = await params.executeTool({ name: call.name, input })
          } catch (err) {
            resultText = err instanceof Error ? err.message : 'Tool execution failed'
            isError = true
          }
        }

        toolCalls.push({
          name: call.name,
          input,
          resultPreview: resultText.slice(0, 500),
          isError,
        })

        results.push({
          type: 'tool_result',
          tool_use_id: call.id,
          content: resultText,
          // Returning the failure (rather than dropping it) lets the model
          // recover — say so, or try a different lookup — instead of hanging.
          ...(isError ? { is_error: true } : {}),
        })
      }

      messages.push({ role: 'user', content: results })
    }

    return { text: finalText, usage, truncated, toolCalls, stoppedAtLimit }
  }

  async testConnection(): Promise<void> {
    await this.client.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 10,
      messages: [{ role: 'user', content: 'Hi' }],
    })
  }

  async listModels(): Promise<AIModel[]> {
    const list = await this.client.models.list({ limit: 100 })

    return list.data
      .filter(m => m.type === 'model')
      .sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime())
      .map(m => ({ id: m.id, name: m.display_name }))
  }
}

// The effort knob, only for models that have one — older models reject the field, and the
// resolved "Auto" model may be any of them.
function outputConfig(model: string, effort: AIEffort | undefined): { output_config?: { effort: AIEffort } } {
  const accepted = effortForModel('anthropic', model, effort)
  return accepted ? { output_config: { effort: accepted } } : {}
}

// Turn a system-prompt string into a single cached text block. Returns
// undefined for empty/missing prompts so we don't send an empty system param.
function cacheableSystem(system: string | undefined): Anthropic.TextBlockParam[] | undefined {
  if (!system) return undefined
  return [{ type: 'text', text: system, cache_control: { type: 'ephemeral' } }]
}

function toAnthropicContent(blocks: ContentBlock[]): Anthropic.ContentBlockParam[] {
  return blocks.map(block => {
    switch (block.type) {
      case 'text':
        return {
          type: 'text' as const,
          text: block.text,
          ...(block.cacheControl ? { cache_control: { type: 'ephemeral' as const } } : {}),
        }
      case 'document':
        return {
          type: 'document' as const,
          source: {
            type: 'base64' as const,
            media_type: block.mediaType as 'application/pdf',
            data: block.data,
          },
        }
      case 'image':
        return {
          type: 'image' as const,
          source: {
            type: 'base64' as const,
            media_type: block.mediaType as Anthropic.Base64ImageSource['media_type'],
            data: block.data,
          },
        }
    }
  })
}
