import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { getClient, redirectUriAllowed, issueAuthorizationCode, grantableScope } from '@/lib/oauth/store'
import { canWriteAnywhere, loadAccessContext } from '@/lib/access/effective'
import { agentApiEnabled } from '@/lib/oauth/enabled'
import { issuerFor } from '@/lib/oauth/metadata'

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
  const { data: { user } } = await supabase.auth.getUser()
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

  const { data: membership } = await admin
    .from('fund_members')
    .select('fund_id, role')
    .eq('user_id', user.id)
    .maybeSingle()

  if (!membership) return NextResponse.json({ error: 'No fund found' }, { status: 403 })
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
    resource,
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
