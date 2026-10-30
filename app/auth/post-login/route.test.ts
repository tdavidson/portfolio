import { beforeEach, describe, expect, it, vi } from 'vitest'
import { NextRequest } from 'next/server'

const mocks = vi.hoisted(() => ({ user: null as { id: string } | null }))
vi.mock('@/lib/supabase/server', () => ({ createClient: async () => ({ auth: { getUser: async () => ({ data: { user: mocks.user } }) } }) }))
vi.mock('@/lib/supabase/admin', () => ({
  createAdminClient: () => ({ from: () => ({ select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: null }) }) }) }) }),
}))
vi.mock('@/lib/activity', () => ({ logActivity: () => {} }))
import { GET } from './route'
import { requestOrigin } from '@/lib/site-links'

// `next start -H 127.0.0.1 -p 3100` behind a TLS proxy: request.url carries the listen address,
// while the proxy passes on the address the browser used.
const behindProxy = (path: string, headers: Record<string, string>) =>
  new NextRequest(`https://localhost:3100${path}`, { headers })

beforeEach(() => { mocks.user = null })

describe('requestOrigin', () => {
  it("prefers the proxy's forwarded host and protocol", () => {
    const req = behindProxy('/', { host: 'localhost:3100', 'x-forwarded-host': 'portal.example', 'x-forwarded-proto': 'https' })
    expect(requestOrigin(req)).toBe('https://portal.example')
  })
  it('uses the Host header a proxy passes on', () => {
    expect(requestOrigin(behindProxy('/', { host: 'portal.example:8443', 'x-forwarded-proto': 'https' }))).toBe('https://portal.example:8443')
  })
  it('takes the first value of a forwarded list', () => {
    const req = behindProxy('/', { 'x-forwarded-host': 'portal.example, inner.example', 'x-forwarded-proto': 'https, http' })
    expect(requestOrigin(req)).toBe('https://portal.example')
  })
  it('keeps plain http for local development', () => {
    expect(requestOrigin(new NextRequest('http://localhost:3000/', { headers: { host: 'localhost:3000' } }))).toBe('http://localhost:3000')
  })
  it("falls back to the request's own origin", () => {
    expect(requestOrigin(new NextRequest('https://fund.example/auth'))).toBe('https://fund.example')
  })
})

describe('GET /auth/post-login behind a proxy', () => {
  it('redirects to the address the browser used, not the listen address', async () => {
    const res = await GET(behindProxy('/auth/post-login?next=%2Fdashboard', { host: 'portal.example:8443', 'x-forwarded-proto': 'https' }))
    expect(res.headers.get('location')).toMatch(/^https:\/\/portal\.example:8443\/auth\?error=/)
  })
  it('sends a signed-in member on to the requested page there', async () => {
    mocks.user = { id: 'synthetic-user' }
    const res = await GET(behindProxy('/auth/post-login?next=%2Fdashboard', { host: 'portal.example:8443', 'x-forwarded-proto': 'https' }))
    expect(res.headers.get('location')).toBe('https://portal.example:8443/dashboard')
  })
})
