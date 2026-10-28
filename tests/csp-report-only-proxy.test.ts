import { beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * The proxy's half of the report-only CSP: a fresh nonce on every page response, set on the
 * REQUEST (so Next nonces its own bootstrap and the layouts can read it) and on the RESPONSE (so
 * the browser evaluates it). Never on an API response, which carries no scripts.
 *
 * The enforcing policy is set here too, on every response the proxy produces, and on a page it
 * carries the same nonce: Next copies the proxy's response headers onto the request and reads its
 * render nonce from `content-security-policy` first, so the enforcing policy is what the render sees.
 * next.config.mjs sends it only on paths the proxy skips (tests/csp-enforcing-coverage.test.ts).
 */

const getUser = vi.hoisted(() => vi.fn())
const from = vi.hoisted(() => vi.fn())
const rpc = vi.hoisted(() => vi.fn())
const getAuthenticatorAssuranceLevel = vi.hoisted(() => vi.fn(async () => ({ data: null })))

vi.mock('@supabase/ssr', () => ({
  createServerClient: () => ({
    auth: { getUser, getClaims: async () => { const { data } = await getUser(); return { data: data?.user ? { claims: { sub: data.user.id, email: data.user.email } } : null, error: null } }, mfa: { getAuthenticatorAssuranceLevel } },
    from,
    rpc,
  }),
}))

import { proxy } from '@/proxy'
import { NONCE_HEADER, REPORT_ONLY_HEADER } from '@/lib/security/csp'

const req = (pathname: string) =>
  ({
    nextUrl: { pathname, search: '', clone: () => new URL(`https://x${pathname}`) },
    cookies: { getAll: () => [], set: () => {} },
    method: 'GET',
    headers: new Headers({ host: 'x' }),
  }) as any

const nonceIn = (csp: string) => /'nonce-([^']+)'/.exec(csp)?.[1]

beforeEach(() => {
  vi.clearAllMocks()
  // Signed out on a public page: the proxy forwards rather than redirects.
  getUser.mockResolvedValue({ data: { user: null } })
})

describe('report-only CSP on page responses', () => {
  it('sets the header with a nonce on a page response', async () => {
    const res = await proxy(req('/auth'))
    const csp = res.headers.get(REPORT_ONLY_HEADER)
    expect(csp).toBeTruthy()
    expect(nonceIn(csp!)).toBeTruthy()
    expect(csp).toContain("'strict-dynamic'")
    expect(csp).not.toContain("'unsafe-inline' 'nonce")
  })

  it('forwards the SAME nonce to the app in the request headers', async () => {
    const res = await proxy(req('/auth'))
    const responseNonce = nonceIn(res.headers.get(REPORT_ONLY_HEADER)!)
    // NextResponse.next({ request: { headers } }) records the overridden request headers under
    // `x-middleware-request-*` for the app to receive; that is where the nonce must be.
    expect(res.headers.get(`x-middleware-request-${NONCE_HEADER}`)).toBe(responseNonce)
    expect(res.headers.get(`x-middleware-request-${REPORT_ONLY_HEADER.toLowerCase()}`)).toContain(`'nonce-${responseNonce}'`)
  })

  it('mints a different nonce for every response', async () => {
    const a = nonceIn((await proxy(req('/auth'))).headers.get(REPORT_ONLY_HEADER)!)
    const b = nonceIn((await proxy(req('/auth'))).headers.get(REPORT_ONLY_HEADER)!)
    expect(a).not.toBe(b)
  })

  it('does not set it on an API response', async () => {
    const res = await proxy(req('/api/v1/meta'))
    expect(res.headers.get(REPORT_ONLY_HEADER)).toBeNull()
    expect(res.headers.get(`x-middleware-request-${NONCE_HEADER}`)).toBeNull()
  })

  it('discards a client-sent Content-Security-Policy request header, so the nonce is always ours', async () => {
    // Next reads the nonce from the enforcing header before the report-only one. A caller who
    // could smuggle one in would pick the nonce the app renders with.
    const r = req('/auth')
    r.headers.set('content-security-policy', "script-src 'nonce-ATTACKER'")
    const res = await proxy(r)
    const ours = nonceIn(res.headers.get(REPORT_ONLY_HEADER)!)
    expect(ours).not.toBe('ATTACKER')
    expect(nonceIn(res.headers.get('x-middleware-request-content-security-policy')!)).toBe(ours)
  })

  it('hands the render the enforcing policy with our nonce, on the request and the response', async () => {
    // Next copies every proxy response header onto the request and reads its nonce from
    // `content-security-policy` before `-report-only`. When the enforcing policy carried no nonce,
    // production rendered every script un-nonced. Both copies must name the report-only nonce.
    const res = await proxy(req('/auth'))
    const ours = nonceIn(res.headers.get(REPORT_ONLY_HEADER)!)
    expect(nonceIn(res.headers.get('content-security-policy')!)).toBe(ours)
    expect(res.headers.get('x-middleware-request-content-security-policy')).toBe(res.headers.get('content-security-policy'))
  })

  it('keeps the enforcing policy loose where it was: unsafe-inline stays, no strict-dynamic', async () => {
    const csp = (await proxy(req('/auth'))).headers.get('content-security-policy')!
    expect(csp).toContain("script-src 'self' 'unsafe-inline' 'nonce-")
    expect(csp).not.toContain('strict-dynamic')
  })

  it('puts the enforcing policy on every response, pages, APIs and redirects alike', async () => {
    const page = await proxy(req('/auth'))
    const api = await proxy(req('/api/v1/meta'))
    const redirect = await proxy(req('/dashboard'))
    expect(redirect.status).toBe(307)
    for (const res of [page, api, redirect]) {
      expect(res.headers.get('content-security-policy')).toContain("script-src 'self' 'unsafe-inline'")
    }
    // A redirect renders nothing, but a nonce on it is harmless; an API response gets none.
    expect(api.headers.get('content-security-policy')).not.toContain('nonce-')
  })

  it('does not put unsafe-eval in the production policy', async () => {
    const res = await proxy(req('/auth'))
    expect(res.headers.get(REPORT_ONLY_HEADER)).not.toContain('unsafe-eval')
  })
})
