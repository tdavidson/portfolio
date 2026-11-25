/**
 * How to connect each assistant or coding agent to this deployment's MCP server.
 *
 * One list, so Settings → API and MCP, the Support page and the docs give the same steps. Every
 * entry is built for the deployment's own MCP URL: a fund connects its own install as a custom
 * connector, so there is no shared address to publish.
 */

export interface ConnectStep {
  /** The client, as people know it. */
  client: string
  /** One sentence on what to do, in plain words. */
  how: string
  /** A command or config to copy, already filled in with the MCP URL. */
  command?: string
}

/** The server name the commands register. Short and neutral; a fund can rename it. */
export const CONNECTOR_NAME = 'portfolio'

export function connectSteps(mcpUrl: string): ConnectStep[] {
  const url = mcpUrl || '<MCP URL>'
  return [
    {
      client: 'Claude (claude.ai and Claude Desktop)',
      how: 'Upload the Claude plugin below, or add the MCP URL as a custom connector under Settings → Connectors. Sign in to your fund and approve; leave the OAuth Client ID empty.',
    },
    {
      client: 'ChatGPT',
      how: 'In Plugins, choose +, then Add custom MCP server, paste the MCP URL, connect, sign in and approve.',
    },
    {
      client: 'Every MCP client on this computer',
      how: 'Adds the connector to each coding agent and desktop app it finds (Claude Code, Codex, Cursor, VS Code and others).',
      command: `npx add-mcp ${url} --name ${CONNECTOR_NAME}`,
    },
    {
      client: 'Claude Code',
      how: 'Then run /mcp and choose Authenticate. With an API key, add --header "Authorization: Bearer YOUR_KEY" instead.',
      command: `claude mcp add --transport http ${CONNECTOR_NAME} ${url}`,
    },
    {
      client: 'Codex',
      how: 'Adds the server, then signs you in.',
      command: `codex mcp add ${CONNECTOR_NAME} --url ${url} && codex mcp login ${CONNECTOR_NAME}`,
    },
    {
      client: 'VS Code',
      how: 'Adds the server to VS Code; it asks you to sign in the first time a tool runs.',
      command: `code --add-mcp '${JSON.stringify({ name: CONNECTOR_NAME, type: 'http', url })}'`,
    },
    {
      client: 'Cursor',
      how: 'Add this to ~/.cursor/mcp.json (or the project\'s .cursor/mcp.json), then sign in from Cursor\'s MCP settings.',
      command: JSON.stringify({ mcpServers: { [CONNECTOR_NAME]: { url } } }, null, 2),
    },
    {
      client: 'A script or your own agent',
      how: 'Create an API key below and send it as a bearer token to the MCP URL, or to /api/agent to run one tool per request.',
      command: `curl -s ${url} -H "Authorization: Bearer YOUR_KEY" -H "Content-Type: application/json" -H "Accept: application/json, text/event-stream" -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'`,
    },
  ]
}
