import { AffinityClient, AffinityError, renderNoteAsMarkdown } from '@/lib/affinity/client'
import type { ToolDefinition, ToolExecutor, ToolInvocation, McpServerConfig } from '@/lib/ai/types'
import { createHash } from 'crypto'
import { isReadOnlyTool, listMcpTools } from '@/lib/mcp-client/tools'
import type { FetchLike } from '@/lib/mcp-client/oauth'

/**
 * Affinity tools for the diligence assistant.
 *
 * These are READ-ONLY by construction. The assistant answers questions about
 * relationship history ("what did we discuss with Acme last quarter?", "who
 * introduced us?") — it has no reason to write to the fund's CRM, and giving a
 * model write access to a system of record is a much larger blast radius than
 * the feature needs.
 *
 * The alternative path is Affinity's hosted MCP server (see `affinityMcpServer`
 * below), which exposes their full tool surface INCLUDING writes. That's opt-in
 * per fund precisely because of the above.
 */

export const AFFINITY_TOOLS: ToolDefinition[] = [
  {
    name: 'affinity_search_companies',
    description:
      'Search the fund\'s Affinity CRM for companies by name or domain. Use this to find the ' +
      'Affinity record for a company before looking up its notes. Returns company names, ' +
      'domains, and Affinity organization IDs.',
    inputSchema: {
      type: 'object',
      properties: {
        term: {
          type: 'string',
          description: 'Company name or domain to search for, e.g. "Acme" or "acme.com".',
        },
      },
      required: ['term'],
      additionalProperties: false,
    },
  },
  {
    name: 'affinity_get_notes',
    description:
      'Fetch the notes the fund has written in Affinity about a company — call notes, meeting ' +
      'summaries, AI notetaker transcripts, partner commentary. This is the fund\'s relationship ' +
      'history with the company. Requires an Affinity organization ID from affinity_search_companies ' +
      '(or the one already linked to this deal).',
    inputSchema: {
      type: 'object',
      properties: {
        organization_id: {
          type: 'number',
          description: 'The Affinity organization ID.',
        },
        limit: {
          type: 'number',
          description: 'Maximum number of notes to return, most recent first. Default 20, max 50.',
        },
      },
      required: ['organization_id'],
      additionalProperties: false,
    },
  },
  {
    name: 'affinity_list_files',
    description:
      'List the files attached to a company in Affinity (decks, models, memos someone uploaded ' +
      'to the CRM). Returns file names and sizes — not contents. Use it to tell the partner what ' +
      'exists in Affinity that is not yet in the deal data room.',
    inputSchema: {
      type: 'object',
      properties: {
        organization_id: {
          type: 'number',
          description: 'The Affinity organization ID.',
        },
      },
      required: ['organization_id'],
      additionalProperties: false,
    },
  },
]

/**
 * Build an executor bound to one user's Affinity key. What the assistant can see
 * is exactly what that user can see in Affinity — the key carries their
 * permissions, so this cannot be used to read past them.
 */
export function makeAffinityExecutor(apiKey: string): ToolExecutor {
  const client = new AffinityClient(apiKey)

  return async (call: ToolInvocation): Promise<string> => {
    try {
      switch (call.name) {
        case 'affinity_search_companies': {
          const term = String(call.input.term ?? '').trim()
          if (!term) return 'No search term provided.'
          const orgs = await client.searchOrganizations(term)
          if (orgs.length === 0) return `No companies in Affinity match "${term}".`
          return orgs
            .slice(0, 10)
            .map(o => `- ${o.name} (organization_id: ${o.id}${o.domain ? `, domain: ${o.domain}` : ''})`)
            .join('\n')
        }

        case 'affinity_get_notes': {
          const organizationId = Number(call.input.organization_id)
          if (!Number.isFinite(organizationId)) return 'A valid organization_id is required.'
          const limit = Math.min(Number(call.input.limit) || 20, 50)

          const { notes } = await client.listNotes({ organizationId }, limit)
          if (notes.length === 0) return 'No notes found in Affinity for this company.'

          // Newest first — a partner asking "what did we discuss last quarter"
          // cares about recent history, and the model reads top-down.
          const sorted = [...notes].sort(
            (a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime()
          )

          return sorted
            .slice(0, limit)
            .map(n => renderNoteAsMarkdown(n, {}))
            .join('\n\n---\n\n')
            // Hard cap the payload: a chatty CRM can hold hundreds of KB of
            // notes, which would blow the context window and the bill.
            .slice(0, 40_000)
        }

        case 'affinity_list_files': {
          const organizationId = Number(call.input.organization_id)
          if (!Number.isFinite(organizationId)) return 'A valid organization_id is required.'
          const files = await client.listEntityFiles({ organizationId })
          if (files.length === 0) return 'No files are attached to this company in Affinity.'
          return files
            .map(f => `- ${f.name} (${formatSize(f.size)}, uploaded ${f.created_at?.slice(0, 10) ?? 'unknown'})`)
            .join('\n')
        }

        default:
          return `Unknown tool: ${call.name}`
      }
    } catch (err) {
      // Surfaced back to the model as a tool error so it can tell the partner
      // "I couldn't reach Affinity" instead of inventing an answer.
      if (err instanceof AffinityError) return `Affinity error: ${err.message}`
      return err instanceof Error ? `Affinity error: ${err.message}` : 'Affinity lookup failed.'
    }
  }
}

/**
 * Affinity's hosted MCP server. Opt-in per fund.
 *
 * Trade-offs vs. the custom tools above:
 *   + Full Affinity tool surface, maintained by Affinity, zero tool code here.
 *   - Anthropic-only (the MCP connector is an Anthropic API feature).
 *   - Requires an Affinity Scale/Advanced/Enterprise plan.
 *   - Its tool list includes WRITE tools. Only the read-only ones are turned on
 *     (`affinityMcpServerReadOnly`): the model reads data-room files the fund didn't write, and an
 *     instruction planted in one must not be able to change the CRM.
 */
export const AFFINITY_MCP_URL = 'https://mcp.affinity.co/mcp'

export function affinityMcpServer(apiKey: string, allowedTools: string[]): McpServerConfig {
  return {
    name: 'affinity',
    url: AFFINITY_MCP_URL,
    authorizationToken: apiKey,
    allowedTools,
  }
}

/** Read-only tool names per key, for an hour, so each question doesn't list Affinity's tools again. */
const readToolCache = new Map<string, { names: string[]; at: number }>()
const READ_TOOL_TTL_MS = 60 * 60 * 1000

/**
 * Affinity's hosted MCP server with only its read-only tools enabled, or null when the tool list
 * can't be read or has no read-only tools. The caller then falls back to the custom read-only tools
 * above, never to the full surface.
 */
export async function affinityMcpServerReadOnly(
  apiKey: string,
  opts: { fetchImpl?: FetchLike; now?: number } = {},
): Promise<McpServerConfig | null> {
  const now = opts.now ?? Date.now()
  const cacheKey = createHash('sha256').update(apiKey).digest('hex')
  const cached = readToolCache.get(cacheKey)
  let names = cached && now - cached.at < READ_TOOL_TTL_MS ? cached.names : null
  if (!names) {
    try {
      names = (await listMcpTools(AFFINITY_MCP_URL, apiKey, opts.fetchImpl)).filter(isReadOnlyTool).map(t => t.name).sort()
    } catch (err) {
      console.error('[affinity-mcp] could not read the tool list:', err instanceof Error ? err.message : err)
      return null
    }
    readToolCache.set(cacheKey, { names, at: now })
  }
  return names.length > 0 ? affinityMcpServer(apiKey, names) : null
}

/** Tests only. */
export function clearAffinityReadToolCache() {
  readToolCache.clear()
}

function formatSize(bytes: number): string {
  if (!bytes) return 'unknown size'
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}
