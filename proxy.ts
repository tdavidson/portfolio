import { createServerClient } from '@supabase/ssr'
import { sessionUser } from '@/lib/supabase/session-user'
import { isGpAppPath } from '@/lib/gp-app-routes'
import { NextResponse, type NextRequest } from 'next/server'
import { matchRoute } from '@/lib/access/match-route'
import { ROUTE_DOMAINS, UNGATED_ROUTES, requiredLevel } from '@/lib/access/route-domains'
import { hasAccess, resolveAccessContext } from '@/lib/access/effective'
import { DOMAIN_META } from '@/lib/access/domains'
import { adminOnlyMessage, adminOnlyRule, adminRuleNeedsBody, UNREADABLE } from '@/lib/access/admin-only'
import { buildReportOnlyCsp, generateNonce, NONCE_HEADER, REPORT_ONLY_HEADER } from '@/lib/security/csp'
import { buildEnforcingCsp } from '@/lib/security/csp-enforcing.mjs'
import { companyEntityDenial, dealEntityDenial, rlsRowDenial, rowCompanyDenial } from '@/lib/access/entity-gate'

// The ENFORCING policy, on every response this proxy produces, carrying the page's nonce.
//
// Next reads its render nonce from the request's `content-security-policy`, and every header the
// proxy sets on its response is copied onto the request too (resolve-routes.js; Vercel does the
// same with next.config.mjs `headers()`). So whatever enforcing policy a page response carries is
// what the render reads, and when it carried no nonce every script and chunk went out un-nonced
// (found with the `[csp-nonce]` log in app/layout.tsx). Hence the nonce goes IN the enforcing
// policy, the pattern Next's own CSP guide uses. next.config.mjs sends the nonce-less policy only on
// the paths this matcher skips; tests/csp-enforcing-coverage.test.ts pins that split.
const enforcingCsp = (nonce: string | null) => buildEnforcingCsp({
  development: process.env.NODE_ENV === 'development',
  supabaseUrl: process.env.NEXT_PUBLIC_SUPABASE_URL,
  nonce,
})

export async function proxy(request: NextRequest) {
  // A per-response nonce. Pages only: an API response carries no scripts.
  const nonce = request.nextUrl.pathname.startsWith('/api') ? null : generateNonce()
  const response = await route(request, nonce)
  response.headers.set('Content-Security-Policy', enforcingCsp(nonce))
  return response
}

async function route(request: NextRequest, nonce: string | null) {
  const { pathname } = request.nextUrl
  const isApiRoute = pathname.startsWith('/api')

  // The strict policy (lib/security/csp.ts), report-only, with the same nonce as the enforcing one.
  // Set on the REQUEST so the layouts can read the nonce, and on the RESPONSE so the browser
  // evaluates it.
  const reportOnlyCsp = nonce
    ? buildReportOnlyCsp(nonce, { development: process.env.NODE_ENV === 'development' })
    : null

  // Built fresh each time rather than once: Supabase's cookie refresh below mutates
  // `request.cookies`, and a Headers object snapshotted before that would carry the stale cookie.
  const forward = () => {
    if (!nonce || !reportOnlyCsp) return NextResponse.next({ request })
    const headers = new Headers(request.headers)
    // Next takes the nonce from the request's `content-security-policy` header FIRST and falls
    // back to the report-only one (app-render.js). A client can send the enforcing header on its
    // own request, so drop it: the nonce the app sees must be the one minted here, never one the
    // caller chose. Self-only today; load-bearing the day the strict policy is promoted.
    headers.delete('content-security-policy')
    headers.set(NONCE_HEADER, nonce)
    headers.set(REPORT_ONLY_HEADER, reportOnlyCsp)
    // The enforcing policy, nonce included, under the name Next reads first. proxy() puts the same
    // value on the response, which Next copies over this anyway; setting it here too keeps the
    // render right should that copy ever stop. Setting it after the delete above is what makes the
    // delete matter.
    headers.set('content-security-policy', enforcingCsp(nonce))
    const response = NextResponse.next({ request: { headers } })
    response.headers.set(REPORT_ONLY_HEADER, reportOnlyCsp)
    return response
  }

  let supabaseResponse = forward()

  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() {
          return request.cookies.getAll()
        },
        setAll(cookiesToSet: { name: string; value: string; options?: Record<string, unknown> }[]) {
          cookiesToSet.forEach(({ name, value }) => request.cookies.set(name, value))
          supabaseResponse = forward()
          cookiesToSet.forEach(({ name, value, options }) =>
            supabaseResponse.cookies.set(name, value, options)
          )
        },
      },
    }
  )

  // Always resolve the user first: it refreshes the session token when it has expired.
  // Do not add logic between createServerClient and this call.
  //
  // Verified locally against the project's signing keys, not by a round trip to Supabase Auth on
  // every request (lib/supabase/session-user.ts says what that trades).
  const { data: { user } } = await sessionUser(supabase.auth)

  const isAuthRoute = pathname.startsWith('/auth')

  // The marketing page is not here any more (www.hemrock.com serves it), so `/` is only the
  // post-login destination: a signed-out visitor is bounced to /auth like any app route, and the
  // signed-in redirect below decides where a member begins.
  const isRootRoute = pathname === '/'

  // Token-gated public surfaces — always reachable regardless of the marketing
  // site flag. The token in the URL is the auth: a fund admin generates it
  // in Settings and shares the resulting link with founders. The page itself
  // 404s if the token doesn't resolve or `deal_intake_enabled` is false on the
  // fund, so the URL alone isn't enough to abuse the endpoint.
  const isPublicTokenRoute = pathname.startsWith('/submit/')

  const isSetupRoute = pathname === '/setup' && process.env.ENABLE_SETUP_PAGE === 'true'
  const isPortalRoute = pathname.startsWith('/portal')

  // OAuth discovery (RFC 8414 / RFC 9728). An MCP client fetches these BEFORE it
  // has any credential, so they must answer to an anonymous caller — bouncing them
  // to /auth would return an HTML login page where JSON metadata was expected, and
  // the connector would fail with an opaque registration error. They contain no
  // secrets: they advertise endpoints and capabilities, nothing more.
  const isOAuthDiscovery = pathname.startsWith('/.well-known/')
  // Onboarding begins before the LP has a session, so it must be reachable unauthenticated.
  const isPortalWelcome = pathname === '/portal/welcome'

  // The installable-app shell. A browser fetches a manifest WITHOUT credentials unless
  // it is marked use-credentials, and a service worker script is fetched by the worker
  // registration rather than the page — so a redirect here does not send anyone to a
  // login screen, it just fails the install with an opaque error. Worse for /sw.js:
  // the redirect answers with HTML where JavaScript was asked for, and the browser
  // refuses it on MIME type.
  //
  // Nothing here is fund data. The manifest carries the deployment's fund name and
  // accent, which the sign-in page already shows, and /offline is a static string.
  //
  // The portal's manifest is in here for a second reason: /portal/* is otherwise run
  // through the LP/GP split below, which redirects anyone who is not an active LP.
  // A prospective LP on /portal/welcome has no active account yet, and that is
  // precisely where they are most likely to install.
  const isPwaShell =
    pathname === '/manifest.webmanifest' ||
    pathname === '/portal/manifest.webmanifest' ||
    pathname === '/sw.js' ||
    pathname === '/offline'

  // Unauthenticated users can only access /auth, API, the demo (if configured), the token-gated public submit form, and setup routes.
  if (!user && !isAuthRoute && !isApiRoute && !isPublicTokenRoute && !isSetupRoute && !isPortalWelcome && !isOAuthDiscovery && !isPwaShell) {
    const url = request.nextUrl.clone()
    url.pathname = '/auth'
    // Carry where they were headed, so signing in RESUMES it.
    //
    // This used to clone the URL and only swap the pathname, which left the original
    // query string dangling on /auth as junk and set no `next` at all. That silently
    // broke the OAuth consent flow: /oauth/authorize builds its own `?next=` for exactly
    // this case, but it never gets to run — middleware intercepts first — so a signed-out
    // user connecting an agent landed on the dashboard afterwards and the app that sent
    // them never received its code.
    //
    // /auth validates this through safeNextPath (a redirect fired straight after login is
    // a phishing primitive), so an origin-relative path is all we may pass.
    const target = pathname + request.nextUrl.search
    url.search = ''
    url.searchParams.set('next', target)
    return NextResponse.redirect(url)
  }

  // Enforce MFA: redirect to verify page if user has enrolled TOTP but hasn't completed AAL2
  // isPwaShell is exempt here too: a user who has signed in but not yet passed TOTP
  // still needs the worker script to load as JavaScript, and bouncing /sw.js to the
  // verify page breaks it in exactly the way described above. None of these three
  // paths reveal anything AAL2 is protecting.
  if (user && !isAuthRoute && !isPublicTokenRoute && !isOAuthDiscovery && !isPwaShell) {
    const { data: aal } = await supabase.auth.mfa.getAuthenticatorAssuranceLevel()
    if (aal && aal.nextLevel === 'aal2' && aal.currentLevel !== 'aal2') {
      if (isApiRoute) {
        return NextResponse.json({ error: 'MFA verification required' }, { status: 403 })
      }
      const url = request.nextUrl.clone()
      url.pathname = '/auth/mfa-verify'
      return NextResponse.redirect(url)
    }
  }

  // ── Where a signed-in GP begins ──────────────────────────────────────────
  //
  // `/` is the post-login destination — both auth callbacks default `next` to it — and it has no
  // page of its own since the marketing page moved out (app/page.tsx is a redirect to /start).
  // The redirect is decided here so a GP never renders that page at all.
  //
  // It belongs here and not in the auth routes because those are not the only way in: a bookmark,
  // the PWA start_url and the address bar all arrive at `/` with the session already set. The
  // extra membership read costs one query on one path.
  //
  // GPs only. An LP is not a fund member; the LP/GP split below owns where they go.
  if (user && isRootRoute) {
    const { data: startMembership } = await supabase
      .from('fund_members').select('fund_id').eq('user_id', user.id).maybeSingle()
    if (startMembership) {
      const url = request.nextUrl.clone()
      url.pathname = '/start'
      return NextResponse.redirect(url)
    }
  }

  // ── Per-domain access gate for the API ───────────────────────────────────
  //
  // THE choke point. Every /api request resolves to a route in lib/access/route-domains.ts and is
  // checked against the caller's grants before the handler runs.
  //
  // It lives here rather than in 263 route files because that is exactly what failed: 137 of them
  // checked only "are you in this fund" and never looked at role — not by decision, but because
  // nothing made them. A gate a route must remember to call is a gate that gets forgotten. Routes
  // keep their own helpers as defence in depth; this is the boundary.
  //
  // Reads use the caller's own session (RLS-scoped), so the edge never holds a service-role key:
  // fund_settings, fund_member_access, and fund_domain_defaults are all readable by their owner.
  if (user && isApiRoute) {
    const denial = await gateApiRequest(supabase, request, user.id)
    if (denial) return denial
  }

  // ── LP / GP route separation ─────────────────────────────────────────────
  // The GP (fund_members) and LP (lp_accounts) access graphs are independent;
  // route context decides which applies. /portal is LP-only; the GP app is for
  // members. A dual GP+LP user is allowed in both. Resolved from the user's OWN
  // rows (RLS-scoped) — never cross-referenced.
  //
  // isPwaShell sits outside this entirely. The manifest, the worker and the offline
  // page are the same bytes for every caller, so there is no LP/GP question to ask —
  // and asking it would redirect an LP-only user's /sw.js to /portal/overview, which
  // the worker rejects on MIME type. It also saves two queries per shell fetch.
  //
  // The OAuth consent screen is outside it too: an investor connecting an assistant to their portal
  // (app/api/portal/mcp) is an LP-only user on /oauth/authorize, and must not be sent to the portal
  // midway. The page decides which consent applies, and refuses anyone it doesn't fit.
  const isOAuthConsent = pathname.startsWith('/oauth/')
  //
  // GP app pages are left to app/(app)/layout.tsx, which resolves the caller's membership anyway
  // (one RPC) and sends a non-member who is an active LP to their portal. Asking here as well cost
  // every GP navigation two more queries before the page could start.
  const isGpApp = isGpAppPath(pathname)
  if (user && !isApiRoute && !isAuthRoute && !isPublicTokenRoute && !isSetupRoute && !isOAuthDiscovery && !isPwaShell && !isOAuthConsent && !isGpApp) {
    const [{ data: membership }, { data: lpAccount }] = await Promise.all([
      supabase.from('fund_members').select('fund_id').eq('user_id', user.id).maybeSingle(),
      supabase.from('lp_accounts').select('status').eq('auth_user_id', user.id).maybeSingle(),
    ])
    const isGp = !!membership
    const lpStatus = (lpAccount as { status?: string } | null)?.status ?? null
    const isActiveLp = lpStatus === 'active'

    if (isPortalRoute) {
      // An already-active LP has no business on the onboarding page.
      if (isActiveLp && isPortalWelcome) {
        const url = request.nextUrl.clone()
        url.pathname = '/portal/overview'
        return NextResponse.redirect(url)
      }
      // Only active LPs (incl. active LPs who are also GPs) belong in the portal.
      if (!isActiveLp) {
        const url = request.nextUrl.clone()
        // A GP here goes straight to /start. Sending them to '/' worked, but only by way of the
        // marketing redirect above — two hops to reach one page.
        url.pathname = lpStatus === 'invited' ? '/portal/welcome' : (isGp ? '/start' : '/auth')
        if (url.pathname !== pathname) return NextResponse.redirect(url)
      }
    } else if (isActiveLp && !isGp) {
      // LP-only user on a GP route → their portal.
      const url = request.nextUrl.clone()
      url.pathname = '/portal/overview'
      return NextResponse.redirect(url)
    }
  }

  return supabaseResponse
}

/**
 * Deny an API request the caller has no grant for; null lets it through.
 *
 * Fail-closed on an unrecognised /api path: an unmapped route is an unanswered question, not an
 * open door. lib/access/route-domains.test.ts makes that safe by failing CI when a route has no
 * entry, and match-route.test.ts round-trips every entry, so "unrecognised" means "not ours".
 */
async function gateApiRequest(
  supabase: ReturnType<typeof createServerClient>,
  request: NextRequest,
  userId: string,
): Promise<NextResponse | null> {
  const key = matchRoute(request.nextUrl.pathname)

  if (!key) {
    console.error(`[access] unmapped API route: ${request.nextUrl.pathname} — denying`)
    return NextResponse.json({ error: 'Not found' }, { status: 404 })
  }
  // Authenticates by some other means (API key, cron secret, webhook token, LP portal account) or
  // serves no fund data. Each entry carries its reason.
  if (key in UNGATED_ROUTES) return null

  const entry = ROUTE_DOMAINS[key]
  const level = requiredLevel(entry, request.method)

  // Membership is the whole test — the caller's own data, or a route that gates per domain itself.
  // Checked before the query so those routes cost nothing here.
  if (level === 'any') return null

  // ONE round trip: fund, role, feature switches, grants and defaults together. This runs on every
  // /api request, so it resolves live (a revoked grant bites on the next request, with no token to
  // hunt down and no cache to wait out) — which is exactly why the one call has to be cheap.
  const access = await resolveAccessContext(supabase as never, userId)

  // No access context: not a fund member (an LP-portal-only user, a pending join request), a member
  // whose access_expires_at has passed (the RPC returns NULL before the hourly sweep deletes the
  // row), or an RPC error. Every route that serves non-members is UNGATED or `level: 'any'` and has
  // returned above, so a domain route has nothing to offer here — and letting it through would hand
  // an expired member to handlers that only check fund_members and rely on this gate for the domain.
  if (!access) return NextResponse.json({ error: 'No fund access' }, { status: 403 })

  // Domains say WHAT; entities say WHOSE. A route about one company also needs that company to be
  // linked to one of the caller's entities (lib/access/entity-gate.ts).
  if (hasAccess(access, entry.domain, level, entry.feature)) {
    // The tier above write (lib/access/admin-only.ts): deletes, undoing the books, moving money,
    // telling LPs, and the fund's structure. Read from a clone, so the handler still gets its body.
    if (access.role !== 'admin') {
      const body = adminRuleNeedsBody(key, request.method)
        ? await request.clone().json().catch(() => UNREADABLE)
        : undefined
      const rule = adminOnlyRule(key, request.method, body)
      if (rule) return NextResponse.json({ error: adminOnlyMessage(rule.label) }, { status: 403 })
    }
    return (await companyEntityDenial(supabase as never, key, request.nextUrl.pathname, access))
      ?? (await dealEntityDenial(supabase as never, key, request.nextUrl.pathname, access))
      ?? (await rlsRowDenial(supabase as never, key, request.nextUrl.pathname, access))
      ?? rowCompanyDenial(supabase as never, key, request.nextUrl.pathname, access)
  }

  if (access.role === 'viewer' && level === 'write') {
    return NextResponse.json({ error: 'This is a read-only demo. Changes are not allowed.' }, { status: 403 })
  }
  const label = DOMAIN_META[entry.domain].label
  return NextResponse.json(
    { error: level === 'write' ? `You do not have write access to ${label}.` : `You do not have access to ${label}.` },
    { status: 403 },
  )
}

export const config = {
  matcher: [
    // Exclude: Next.js internals, static assets, the inbound email webhook, and
    // BotId's challenge endpoints.
    //
    // The webhook receives large Postmark payloads (base64 attachments) that must
    // not pass through the Edge middleware layer, which has a tight body-size limit.
    //
    // The UUID is BotId's own path prefix (withBotId rewrites `/149e9513-…/…/c.js`
    // to the challenge and `/149e9513-…/:path*` to the proxy — see
    // botid/dist/next/config). Middleware runs BEFORE next.config rewrites, so
    // without this the challenge script is just an unauthenticated request: it gets
    // redirected to /auth, the browser is handed HTML where it asked for
    // JavaScript, and refuses it on MIME type. BotId then has no token to issue and
    // `checkBotId()` fails every caller closed — which looks exactly like the demo
    // being switched off. Hardcoded because `matcher` must be statically analysable;
    // BOTID_PATH_PREFIX in lib/botid-routes.ts pins the same string for the test.
    //
    // NOTHING under /api may fall out of this matcher except the webhook itself: a path the
    // matcher skips never reaches gateApiRequest or the AAL2 check. Hence `api/inbound-email`
    // is anchored to a segment boundary (else `/api/inbound-emailfoo` slips past), and the
    // image-extension exclusion carries `(?!api/)` (else `/api/emails/<id>/attachment/0.png`
    // — a dynamic segment the caller chooses — skips the gate). tests/security-proxy-matcher
    // compiles this with Next's own getMiddlewareMatchers and pins both.
    '/((?!_next/static|_next/image|favicon.ico|api/inbound-email(?:/|$)|149e9513-01fa-4fb0-aad4-566afd725d1b|(?!api/).*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)',
  ],
}
