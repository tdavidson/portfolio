import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { authServerUser } from '@/lib/supabase/session-user'
import { createAdminClient } from '@/lib/supabase/admin'
import { getClient, redirectUriAllowed, issueAuthorizationCode, grantableScope } from '@/lib/oauth/store'
import { canWriteAnywhere, loadAccessContext } from '@/lib/access/effective'
import { agentApiEnabled } from '@/lib/oauth/enabled'
import { issuerFor, resourceFor, PORTAL_MCP_PATH } from '@/lib/oauth/metadata'
import { audienceOf } from '@/lib/oauth/audience'
import { connectorPrincipal, lpConnectorEnabled, lpGrantableScope } from '@/lib/portal/principal'
import { createFund, fundCreationRefusal } from '@/lib/onboarding/create-fund'
import { rateLimit } from '@/lib/rate-limit'

/**
 * The user's decision on the consent screen. This is the ONLY place an
 * authorization code is minted, and it requires a live Supabase session — the
 * human granting access must be the human who is signed in.
 *
 * Everything the form sends is re-validated here from scratch. The consent page
 * already checked the client and redirect_uri, but the form is a client-side
 * artifact and a caller can POST whatever they like straight at this route; the
 * page's checks are for the human's benefit, these are the ones that matter.
 */

export const dynamic = 'force-dynamic'

export async function POST(req: NextRequest) {
  const supabase = await createClient()
  // Asked of the Auth server, not the local token check: this issues a long-lived refresh token, so a
  // session that was just signed out must not be able to.
  const { data: { user } } = await authServerUser(supabase)
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const body = await req.json().catch(() => ({}))
  const clientId = str(body.client_id)
  const redirectUri = str(body.redirect_uri)
  const codeChallenge = str(body.code_challenge)
  const state = str(body.state)
  const resource = str(body.resource)
  const requestedScope = str(body.scope)
  const approve = body.approve === true

  if (!clientId || !redirectUri) {
    return NextResponse.json({ error: 'Missing client_id or redirect_uri' }, { status: 400 })
  }

  const admin = createAdminClient()
  const client = await getClient(admin, clientId)
  if (!client) return NextResponse.json({ error: 'Unknown client' }, { status: 400 })

  // Exact match against the registered set. If this fails we must NOT redirect to
  // the supplied URI — that is precisely the open-redirect we're guarding against.
  // Fail closed, in our own response.
  if (!redirectUriAllowed(client, redirectUri)) {
    return NextResponse.json({ error: 'redirect_uri is not registered for this client' }, { status: 400 })
  }

  // Denial is a normal OAuth outcome, and it DOES redirect back — the client needs
  // to learn the user said no. (Safe: the URI is now known-registered.)
  if (!approve) {
    return NextResponse.json({ redirect: withParams(redirectUri, { error: 'access_denied', state, iss: issuerFor(req) }) })
  }

  if (!codeChallenge) {
    return NextResponse.json({ error: 'code_challenge is required (PKCE S256)' }, { status: 400 })
  }

  // The investor connector. Decided on investor grounds alone: the code is for the signed-in
  // person's own portal in one fund they invest in, so a `investor: true` flag from the form opens
  // nothing they couldn't already see on the web. The resource is forced to the investor endpoint,
  // so the token can never open the fund's boundaries (lib/oauth/audience.ts).
  if (audienceOf(resource) === 'portal' || body.investor === true) {
    const fundId = str(body.fund_id)
    if (!fundId) return NextResponse.json({ error: 'Choose a fund to connect.' }, { status: 400 })
    if (!(await lpConnectorEnabled(admin, fundId))) {
      return NextResponse.json({ error: "This fund hasn't turned on connecting an assistant to the investor portal." }, { status: 403 })
    }
    if (!(await connectorPrincipal(admin, user.id, fundId, user.email))) {
      return NextResponse.json({ error: 'You have no active investment in this fund.' }, { status: 403 })
    }
    const code = await issueAuthorizationCode(admin, {
      clientId,
      userId: user.id,
      fundId,
      redirectUri,
      scope: lpGrantableScope(requestedScope),
      codeChallenge,
      resource: resourceFor(req, PORTAL_MCP_PATH),
    })
    return NextResponse.json({ redirect: withParams(redirectUri, { code, state, iss: issuerFor(req) }) })
  }

  let { data: membership } = await admin
    .from('fund_members')
    .select('fund_id, role')
    .eq('user_id', user.id)
    .maybeSingle()

  // No fund yet: the consent screen asked them to name one, so an assistant can set it up from
  // here. Same creation path as the web wizard (lib/onboarding/create-fund.ts), with agent access
  // on, since connecting this assistant is the point. Only on approve, so "Deny" creates nothing.
  if (!membership) {
    const fundName = str(body.fund_name)
    if (!fundName) return NextResponse.json({ error: 'Name your fund to connect.' }, { status: 400 })
    const limited = await rateLimit({ key: `onboard-fund:${user.id}`, limit: 5, windowSeconds: 300 })
    if (limited) return limited
    const refusal = await fundCreationRefusal(admin, user.id)
    if (refusal) return NextResponse.json({ error: refusal }, { status: 403 })
    const created = await createFund(admin, { userId: user.id, email: user.email, fundName, agentApiEnabled: true })
    if (!created.ok) return NextResponse.json({ error: created.error }, { status: created.status })
    // The funds insert trigger made them its admin.
    membership = { fund_id: created.fundId, role: 'admin' }
  }
  const { fund_id: fundId, role } = membership as { fund_id: string; role: string }

  // The read-only demo may not hand an agent the keys to a fund.
  if (role === 'viewer') {
    return NextResponse.json({ error: 'The read-only demo cannot authorize agents' }, { status: 403 })
  }

  if (!(await agentApiEnabled(admin, fundId))) {
    return NextResponse.json({ error: 'Agent access is disabled for this fund' }, { status: 403 })
  }

  // Cap the grant at what this person can actually hand out — by ROLE (the demo may not authorize
  // agents at all) and by their GRANTS (someone read-only everywhere gets a read-only token, not a
  // write token whose every write is then refused). Asking for more is downgraded, not refused:
  // OAuth's model is that the server grants a subset and tells the client what it got.
  const access = await loadAccessContext(admin, fundId, user.id, role)
  const scope = grantableScope(requestedScope, role, canWriteAnywhere(access))

  const code = await issueAuthorizationCode(admin, {
    clientId,
    userId: user.id,
    fundId,
    redirectUri,
    scope,
    codeChallenge,
    // A client that names no resource gets the fund's MCP endpoint, the one the metadata
    // advertises: a token always names the boundary it may be used at (lib/oauth/audience.ts).
    resource: resource ?? resourceFor(req),
  })

  // RFC 9207: the issuer rides on every authorization response. The metadata promises it
  // (`authorization_response_iss_parameter_supported`), and a client that checks — ChatGPT does —
  // rejects a response without it as a possible mix-up attack ("missing the expected issuer").
  return NextResponse.json({ redirect: withParams(redirectUri, { code, state, iss: issuerFor(req) }) })
}

function withParams(uri: string, params: Record<string, string | null>): string {
  const url = new URL(uri)
  for (const [k, v] of Object.entries(params)) {
    if (v) url.searchParams.set(k, v)
  }
  return url.toString()
}

function str(v: unknown): string | null {
  return typeof v === 'string' && v.trim() ? v.trim() : null
}
