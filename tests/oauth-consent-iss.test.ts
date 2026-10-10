import { describe, expect, it, vi } from 'vitest'
import { NextRequest } from 'next/server'

/**
 * RFC 9207. The authorization-server metadata advertises
 * `authorization_response_iss_parameter_supported`, so every redirect back to the client must carry
 * `iss`. ChatGPT checks it and refuses the sign-in otherwise ("OAuth authorization response is
 * missing the expected issuer"); Claude did not, which is how it went unnoticed.
 */

vi.mock('@/lib/supabase/server', () => ({ createClient: async () => ({ auth: { getUser: async () => ({ data: { user: { id: 'u1' } } }) } }) }))
vi.mock('@/lib/supabase/admin', () => ({
  createAdminClient: () => ({
    from: () => {
      const q: any = { select: () => q, eq: () => q, maybeSingle: async () => ({ data: { fund_id: 'f1', role: 'admin' } }) }
      return q
    },
  }),
}))
vi.mock('@/lib/oauth/store', () => ({
  getClient: async () => ({ id: 'c1', redirect_uris: ['https://chatgpt.com/connector_platform_oauth_redirect'] }),
  redirectUriAllowed: () => true,
  issueAuthorizationCode: async () => 'code-123',
  grantableScope: () => 'read write',
}))
vi.mock('@/lib/access/effective', () => ({ loadAccessContext: async () => ({}), canWriteAnywhere: () => true }))
vi.mock('@/lib/oauth/enabled', () => ({ agentApiEnabled: async () => true }))

import { POST } from '@/app/api/oauth/consent/route'
import { authorizationServerMetadata } from '@/lib/oauth/metadata'

const consent = (approve: boolean) =>
  POST(new NextRequest('https://fund.example.com/api/oauth/consent', {
    method: 'POST',
    headers: { host: 'fund.example.com', 'content-type': 'application/json' },
    body: JSON.stringify({
      client_id: 'c1', redirect_uri: 'https://chatgpt.com/connector_platform_oauth_redirect',
      code_challenge: 'x', state: 's1', scope: 'read write', approve,
    }),
  }))

describe('OAuth authorization responses carry the issuer (RFC 9207)', () => {
  it('on approval: code, state and iss, iss equal to the metadata issuer', async () => {
    const body = await (await consent(true)).json()
    const url = new URL(body.redirect)
    expect(url.searchParams.get('code')).toBe('code-123')
    expect(url.searchParams.get('state')).toBe('s1')
    const meta = authorizationServerMetadata(new NextRequest('https://fund.example.com/.well-known/oauth-authorization-server', { headers: { host: 'fund.example.com' } }))
    expect(meta.authorization_response_iss_parameter_supported).toBe(true)
    expect(url.searchParams.get('iss')).toBe(meta.issuer)
  })

  it('on denial too', async () => {
    const url = new URL((await (await consent(false)).json()).redirect)
    expect(url.searchParams.get('error')).toBe('access_denied')
    expect(url.searchParams.get('iss')).toBeTruthy()
  })
})
