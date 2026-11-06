import { NextRequest, NextResponse } from 'next/server'
import { getMcpServer } from '@/lib/mcp-client/servers'
import { setMcpServerEnabled } from '@/lib/mcp-client/connections'
import { connectorMember } from '@/lib/mcp-client/route-helpers'

/**
 * Turn an outside MCP server on or off for the fund. Admin only: while it's off, members can't
 * connect and nothing uses the connections they already made.
 */

type Ctx = { params: Promise<{ server: string }> }

export async function PATCH(req: NextRequest, ctx: Ctx) {
  const { server: serverId } = await ctx.params
  const server = getMcpServer(serverId)
  if (!server) return NextResponse.json({ error: 'Unknown connector' }, { status: 404 })
  const guard = await connectorMember()
  if ('error' in guard) return guard.error
  if (!guard.isAdmin) return NextResponse.json({ error: 'Admin access required' }, { status: 403 })

  const body = await req.json().catch(() => ({}))
  if (typeof body.enabled !== 'boolean') return NextResponse.json({ error: 'enabled must be true or false' }, { status: 400 })

  try {
    await setMcpServerEnabled(guard.admin, guard.fundId, server.id, body.enabled)
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : 'Save failed' }, { status: 500 })
  }
  return NextResponse.json({ enabled: body.enabled })
}
