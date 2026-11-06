import { NextRequest, NextResponse } from 'next/server'
import { getMcpServer } from '@/lib/mcp-client/servers'
import { buildAuthorizationUrl, createPkce, discoverAuth, McpOAuthError, registerClient } from '@/lib/mcp-client/oauth'
import { createMcpOAuthState, MCP_OAUTH_STATE_COOKIE, MCP_OAUTH_STATE_TTL_SECONDS } from '@/lib/mcp-client/oauth-state'
import { connectorMember, connectorRedirectUri } from '@/lib/mcp-client/route-helpers'
import { PRODUCT_NAME, requestOrigin } from '@/lib/site-links'

/**
 * Start a member's sign-in to an outside MCP server: discover its sign-in server, register this
 * deployment as a client, and send the browser there. The callback finishes it.
 */

type Ctx = { params: Promise<{ server: string }> }

function backToSettings(req: NextRequest, query: string) {
  return NextResponse.redirect(new URL(`/settings?${query}`, requestOrigin(req)))
}

export async function GET(req: NextRequest, ctx: Ctx) {
  const { server: serverId } = await ctx.params
  const server = getMcpServer(serverId)
  if (!server) return NextResponse.json({ error: 'Unknown connector' }, { status: 404 })
  const guard = await connectorMember()
  if ('error' in guard) return guard.error

  const encryptionKey = process.env.ENCRYPTION_KEY
  if (!encryptionKey) return NextResponse.json({ error: 'Server misconfiguration: ENCRYPTION_KEY not set' }, { status: 500 })

  const redirectUri = connectorRedirectUri(server.id)
  let authorizationUrl: string
  let cookie: string
  try {
    const auth = await discoverAuth(server.url)
    const client = await registerClient(auth, { redirectUri, clientName: PRODUCT_NAME })
    const pkce = createPkce()
    const state = createMcpOAuthState({
      encryptionKey,
      serverId: server.id,
      userId: guard.userId,
      fundId: guard.fundId,
      codeVerifier: pkce.verifier,
      clientId: client.clientId,
      clientSecret: client.clientSecret,
      tokenEndpoint: auth.tokenEndpoint,
      resource: auth.resource,
    })
    cookie = state.cookie
    authorizationUrl = buildAuthorizationUrl({ auth, client, redirectUri, state: state.state, codeChallenge: pkce.challenge })
  } catch (err) {
    const code = err instanceof McpOAuthError ? err.code : 'connect_failed'
    console.error(`[connectors/${server.id}] could not start sign-in:`, err instanceof Error ? err.message : err)
    return backToSettings(req, `connector=${server.id}&connector_error=${encodeURIComponent(code)}`)
  }

  const response = NextResponse.redirect(authorizationUrl)
  response.cookies.set(MCP_OAUTH_STATE_COOKIE, cookie, {
    httpOnly: true,
    maxAge: MCP_OAUTH_STATE_TTL_SECONDS,
    path: `/api/settings/connectors/${server.id}/callback`,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
  })
  return response
}
