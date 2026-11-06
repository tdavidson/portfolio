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
}

export const MCP_SERVERS: readonly McpServerDefinition[] = [
  {
    id: 'specter',
    name: 'Specter',
    url: 'https://mcp.tryspecter.com/mcp',
    description:
      'Company, people and investor data: funding rounds, competitors, revenue and headcount signals, team backgrounds.',
    usedFor: 'The diligence assistant can look up a deal’s company, founders and investors in Specter.',
  },
]

export function getMcpServer(id: string): McpServerDefinition | null {
  return MCP_SERVERS.find(s => s.id === id) ?? null
}
