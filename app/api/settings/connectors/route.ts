import { NextResponse } from 'next/server'
import { MCP_SERVERS } from '@/lib/mcp-client/servers'
import { connectorMember } from '@/lib/mcp-client/route-helpers'

/**
 * The outside MCP servers this deployment knows (lib/mcp-client/servers.ts), for the Settings cards.
 * Fund administrators' servers come from a server-side setting, so the browser asks for the list
 * rather than reading it from its own bundle. URLs are left out: the browser never calls them.
 */
export async function GET() {
  const guard = await connectorMember()
  if ('error' in guard) return guard.error
  return NextResponse.json({
    servers: MCP_SERVERS.map(s => ({ id: s.id, name: s.name, description: s.description, usedFor: s.usedFor, kind: s.kind ?? 'research' })),
  })
}
