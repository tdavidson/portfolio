import { NextRequest, NextResponse } from 'next/server'
import { getMcpServer } from '@/lib/mcp-client/servers'
import { deleteMcpConnection, getMcpConnectionStatus } from '@/lib/mcp-client/connections'
import { connectorMember } from '@/lib/mcp-client/route-helpers'

/**
 * A member's own connection to an outside MCP server (lib/mcp-client/servers.ts).
 * GET says whether they're connected; DELETE disconnects. Tokens are never returned.
 */

type Ctx = { params: Promise<{ server: string }> }

export async function GET(_req: NextRequest, ctx: Ctx) {
  const { server: serverId } = await ctx.params
  const server = getMcpServer(serverId)
  if (!server) return NextResponse.json({ error: 'Unknown connector' }, { status: 404 })
  const guard = await connectorMember()
  if ('error' in guard) return guard.error

  const status = await getMcpConnectionStatus(guard.admin, guard.userId, server.id)
  return NextResponse.json({ server: { id: server.id, name: server.name }, ...status })
}

export async function DELETE(_req: NextRequest, ctx: Ctx) {
  const { server: serverId } = await ctx.params
  const server = getMcpServer(serverId)
  if (!server) return NextResponse.json({ error: 'Unknown connector' }, { status: 404 })
  const guard = await connectorMember()
  if ('error' in guard) return guard.error

  await deleteMcpConnection(guard.admin, guard.userId, server.id)
  return NextResponse.json({ connected: false })
}
