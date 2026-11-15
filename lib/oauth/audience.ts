/**
 * Which protected boundary an OAuth token was issued for (RFC 8707 `resource`).
 *
 * SEC-009: the `resource` parameter was honoured at the authorization endpoint and persisted onto
 * both the code and the token — and then never read again. A token a client obtained for the MCP
 * endpoint, which is the resource the discovery document advertises, authenticated just as well
 * against `/api/v1`. The two surfaces are not equivalent: one is the agent tool boundary, the other
 * is the native-app boundary with conversations and pending-action approvals behind it. A token
 * scoped to one should not open the other.
 *
 * Resources are absolute URLs whose host varies by deployment (preview URLs, a bare *.vercel.app,
 * localhost on some port — see `issuerFor`), so the host is deliberately NOT part of the
 * comparison. What identifies the boundary is the path.
 */

export type OAuthAudience = 'mcp' | 'v1' | 'portal'

const PATH_PREFIXES: Record<OAuthAudience, string> = {
  mcp: '/api/mcp',
  v1: '/api/v1',
  // The investor connector: an LP's own portal, over MCP (app/api/portal/mcp). A different
  // identity model from the fund's (lp_accounts, not fund_members), so its tokens must never open
  // the fund's boundaries, nor theirs this one.
  portal: '/api/portal/mcp',
}

/**
 * The boundary a stored `resource` names, or null when it names none we recognise.
 *
 * Null covers a token issued with no `resource` at all and a token issued for something we do not
 * serve. `tokenAllowedAt` refuses both.
 */
export function audienceOf(resource: string | null | undefined): OAuthAudience | null {
  if (!resource) return null
  let pathname: string
  try {
    pathname = new URL(resource).pathname
  } catch {
    // Not a URL. RFC 8707 requires an absolute URI, so this is a malformed request that got
    // stored; treat it as naming nothing rather than as naming everything.
    return null
  }
  const entries = Object.entries(PATH_PREFIXES) as [OAuthAudience, string][]
  const match = entries.find(([, prefix]) => pathname === prefix || pathname.startsWith(`${prefix}/`))
  return match ? match[0] : null
}

/**
 * May a token carrying this `resource` be used at this boundary?
 *
 * A token must name the boundary it was issued for. Tokens with no resource were accepted anywhere
 * while ones issued before this check existed were still live; none remain, and the consent route
 * now stamps the fund's MCP resource on a request that names none, so a token without one is
 * refused everywhere. An unrecognised resource is refused too: something was claimed, and it was
 * not this.
 */
export function tokenAllowedAt(resource: string | null | undefined, boundary: OAuthAudience): boolean {
  if (!resource) return false
  const audience = audienceOf(resource)
  if (audience === null) return false
  return audience === boundary
}
