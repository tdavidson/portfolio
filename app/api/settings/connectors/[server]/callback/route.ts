import { NextRequest, NextResponse } from 'next/server'
import { getMcpServer } from '@/lib/mcp-client/servers'
import { exchangeCode, McpOAuthError } from '@/lib/mcp-client/oauth'
import { consumeMcpOAuthState, MCP_OAUTH_STATE_COOKIE } from '@/lib/mcp-client/oauth-state'
import { isMcpServerEnabled, readOnlyToolNames, saveMcpConnection } from '@/lib/mcp-client/connections'
import { connectorMember, connectorRedirectUri } from '@/lib/mcp-client/route-helpers'
import { requestOrigin } from '@/lib/site-links'

/**
 * Finish a member's sign-in to an outside MCP server: check the state, redeem the code, read the
 * server's tool list to find the read-only tools, and store the connection.
 */

type Ctx = { params: Promise<{ server: string }> }

export async function GET(req: NextRequest, ctx: Ctx) {
  const { server: serverId } = await ctx.params
  const server = getMcpServer(serverId)
  if (!server) return NextResponse.json({ error: 'Unknown connector' }, { status: 404 })

  const done = (query: string) => {
    const response = NextResponse.redirect(new URL(`/settings?connector=${server.id}&${query}`, requestOrigin(req)))
    response.cookies.set(MCP_OAUTH_STATE_COOKIE, '', {
      httpOnly: true,
      maxAge: 0,
      path: `/api/settings/connectors/${server.id}/callback`,
      sameSite: 'lax',
      secure: process.env.NODE_ENV === 'production',
    })
    return response
  }

  const guard = await connectorMember()
  if ('error' in guard) return NextResponse.redirect(new URL('/auth', requestOrigin(req)))

  const encryptionKey = process.env.ENCRYPTION_KEY
  if (!encryptionKey) return done('connector_error=server_error')

  const transaction = consumeMcpOAuthState({
    cookie: req.cookies.get(MCP_OAUTH_STATE_COOKIE)?.value,
    encryptionKey,
    state: req.nextUrl.searchParams.get('state'),
    serverId: server.id,
    userId: guard.userId,
  })
  if (!transaction || transaction.fundId !== guard.fundId) return done('connector_error=invalid_state')
  if (!(await isMcpServerEnabled(guard.admin, guard.fundId, server.id))) return done('connector_error=disabled')
  if (req.nextUrl.searchParams.get('error')) return done('connector_error=consent_denied')
  const code = req.nextUrl.searchParams.get('code')
  if (!code) return done('connector_error=missing_params')

  const client = { clientId: transaction.clientId, clientSecret: transaction.clientSecret }
  try {
    const tokens = await exchangeCode({
      tokenEndpoint: transaction.tokenEndpoint,
      client,
      code,
      codeVerifier: transaction.codeVerifier,
      redirectUri: connectorRedirectUri(server.id),
      resource: transaction.resource,
    })

    // Which tools are safe to hand the assistant. If the list can't be read now it's read again
    // on first use; until then the assistant simply doesn't get this server.
    let readTools: string[] = []
    try {
      readTools = await readOnlyToolNames(server.url, tokens.accessToken)
    } catch (err) {
      console.error(`[connectors/${server.id}] could not read the tool list:`, err instanceof Error ? err.message : err)
    }

    await saveMcpConnection(guard.admin, {
      userId: guard.userId,
      fundId: guard.fundId,
      serverId: server.id,
      clientId: client.clientId,
      clientSecret: client.clientSecret,
      tokenEndpoint: transaction.tokenEndpoint,
      tokens,
      readTools,
    })
  } catch (err) {
    const reason = err instanceof McpOAuthError ? 'token_exchange_failed' : 'save_failed'
    console.error(`[connectors/${server.id}] sign-in failed:`, err instanceof Error ? err.message : err)
    return done(`connector_error=${reason}`)
  }

  return done('connector_connected=true')
}
