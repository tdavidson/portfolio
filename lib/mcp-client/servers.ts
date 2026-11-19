/**
 * Outside MCP servers the app can connect to on a member's behalf.
 *
 * Each entry is a hosted MCP server that signs people in with OAuth. A member connects their own
 * account in Settings (lib/mcp-client/oauth.ts runs the sign-in), and features that use the server
 * hand Claude that member's token through Anthropic's MCP connector (lib/ai/anthropic.ts). Nobody
 * reaches data they couldn't open in the outside service themselves.
 *
 * The list is fixed in code on purpose. Letting a member type a server URL would let anyone make
 * this deployment send requests to an address of their choosing, internal ones included. Adding a
 * server is a one-entry change here.
 */

export interface McpServerDefinition {
  /** Stable id, used in routes and as the MCP server name Claude sees. Lowercase, no spaces. */
  id: string
  /** Shown in Settings. */
  name: string
  /** The server's MCP endpoint (streamable HTTP). */
  url: string
  /** One sentence for the Settings card: what connecting does. */
  description: string
  /** Where the app uses it, for the Settings card. */
  usedFor: string
  /** 'fund_admin': a fund administrator's server, which an admin-reported vehicle can pull from. */
  kind?: 'research' | 'fund_admin'
  /**
   * For a fund administrator: which built-in pull reads its figures (lib/admin-reporting/adapters.ts).
   * Absent = none yet; the assistant pulls with the server's own tools, or a CSV is uploaded.
   */
  adapter?: string
}

/**
 * Fund administrators' MCP servers, for admin-reported vehicles (lib/admin-reporting). Any number,
 * from the deployment's FUND_ADMIN_MCP_SERVERS setting: a JSON list of { id, name, url }, for example
 *
 *   [{"id":"carta","name":"Carta","url":"https://…/mcp","adapter":"carta"},
 *    {"id":"acme-admin","name":"Acme Fund Services","url":"https://…/mcp"}]
 *
 * `adapter` names a built-in pull for that administrator (lib/admin-reporting/adapters.ts); without
 * one, the server still connects, and the assistant reads it with the server's own tools.
 *
 * An operator setting like any other env var, never a member's input, so the reasoning above holds.
 * A member connects their own account at each one; a vehicle then names the server its figures come
 * from. Entries that aren't https, or reuse an id, are ignored.
 */
export function fundAdminServers(raw: string | undefined = process.env.FUND_ADMIN_MCP_SERVERS): McpServerDefinition[] {
  if (!raw?.trim()) return []
  let list: unknown
  try { list = JSON.parse(raw) } catch { return [] }
  if (!Array.isArray(list)) return []
  const out: McpServerDefinition[] = []
  for (const e of list) {
    const id = typeof e?.id === 'string' ? e.id.trim().toLowerCase() : ''
    const name = typeof e?.name === 'string' ? e.name.trim().slice(0, 80) : ''
    const url = typeof e?.url === 'string' ? e.url.trim() : ''
    if (!/^[a-z0-9][a-z0-9_-]{0,39}$/.test(id) || !name || !/^https:\/\/[^\s]+$/.test(url)) continue
    if (RESERVED_IDS.has(id) || out.some(s => s.id === id)) continue
    const adapter = typeof e?.adapter === 'string' && /^[a-z0-9_-]{1,40}$/.test(e.adapter) ? e.adapter : undefined
    out.push({
      id, name, url, kind: 'fund_admin', ...(adapter ? { adapter } : {}),
      description: `Fund administration data at ${name}: partners' capital, NAV and the fund's net returns.`,
      usedFor: `Pulls the figures for vehicles ${name} administers, for the LP report cards.`,
    })
  }
  return out
}

/** Ids a fund administrator can't take: the built-in servers', and the manual sources'. */
const RESERVED_IDS = new Set(['specter', 'csv', 'other'])

export const MCP_SERVERS: readonly McpServerDefinition[] = [
  {
    id: 'specter',
    name: 'Specter',
    url: 'https://mcp.tryspecter.com/mcp',
    description:
      'Company, people and investor data: funding rounds, competitors, revenue and headcount signals, team backgrounds.',
    usedFor: 'The diligence assistant can look up a deal’s company, founders and investors in Specter.',
  },
  ...fundAdminServers(),
]

export function getMcpServer(id: string): McpServerDefinition | null {
  return MCP_SERVERS.find(s => s.id === id) ?? null
}

/** The fund administrators' servers this deployment knows. */
export function fundAdminMcpServers(): McpServerDefinition[] {
  return MCP_SERVERS.filter(s => s.kind === 'fund_admin')
}
