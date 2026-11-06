import { describe, it, expect } from 'vitest'
import {
  authServerMetadataUrls, buildAuthorizationUrl, createPkce, discoverAuth, exchangeCode,
  isAllowedEndpoint, protectedResourceMetadataUrls, refreshTokens, registerClient, McpOAuthError,
  type FetchLike,
} from './oauth'
import { createHash } from 'crypto'

const RESOURCE = 'https://mcp.data.example/mcp'

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
}

/** A fake server keyed by URL, recording what was asked. */
function fakeFetch(routes: Record<string, (init?: RequestInit) => Response>) {
  const calls: Array<{ url: string; init?: RequestInit }> = []
  const impl: FetchLike = async (url, init) => {
    calls.push({ url, init })
    const handler = routes[url]
    return handler ? handler(init) : new Response('not found', { status: 404 })
  }
  return { impl, calls }
}

const AS_META = {
  issuer: 'https://auth.data.example',
  authorization_endpoint: 'https://auth.data.example/authorize',
  token_endpoint: 'https://auth.data.example/token',
  registration_endpoint: 'https://auth.data.example/register',
  scopes_supported: ['openid', 'offline_access'],
  code_challenge_methods_supported: ['S256'],
}

describe('well-known URLs', () => {
  it('tries the path-specific resource metadata first', () => {
    expect(protectedResourceMetadataUrls(RESOURCE)).toEqual([
      'https://mcp.data.example/.well-known/oauth-protected-resource/mcp',
      'https://mcp.data.example/.well-known/oauth-protected-resource',
    ])
  })

  it('covers RFC 8414 and OpenID locations for an issuer with and without a path', () => {
    expect(authServerMetadataUrls('https://auth.data.example')).toEqual([
      'https://auth.data.example/.well-known/oauth-authorization-server',
      'https://auth.data.example/.well-known/openid-configuration',
    ])
    expect(authServerMetadataUrls('https://auth.data.example/tenant')).toEqual([
      'https://auth.data.example/.well-known/oauth-authorization-server/tenant',
      'https://auth.data.example/.well-known/openid-configuration/tenant',
      'https://auth.data.example/tenant/.well-known/openid-configuration',
    ])
  })

  it('only allows https endpoints, or http on localhost', () => {
    expect(isAllowedEndpoint('https://auth.data.example/token')).toBe(true)
    expect(isAllowedEndpoint('http://localhost:4000/token')).toBe(true)
    expect(isAllowedEndpoint('http://auth.data.example/token')).toBe(false)
    expect(isAllowedEndpoint('javascript:alert(1)')).toBe(false)
    expect(isAllowedEndpoint(42)).toBe(false)
  })
})

describe('discoverAuth', () => {
  it('follows the resource metadata to its authorization server', async () => {
    const { impl } = fakeFetch({
      'https://mcp.data.example/.well-known/oauth-protected-resource/mcp': () => json({
        resource: RESOURCE,
        authorization_servers: ['https://auth.data.example'],
        scopes_supported: ['read'],
      }),
      'https://auth.data.example/.well-known/oauth-authorization-server': () => json(AS_META),
    })
    const auth = await discoverAuth(RESOURCE, impl)
    expect(auth).toEqual({
      resource: RESOURCE,
      authorizationEndpoint: AS_META.authorization_endpoint,
      tokenEndpoint: AS_META.token_endpoint,
      registrationEndpoint: AS_META.registration_endpoint,
      scope: 'read offline_access',
    })
  })

  it('falls back to the MCP origin as its own authorization server', async () => {
    const { impl } = fakeFetch({
      'https://mcp.data.example/.well-known/oauth-authorization-server': () => json({
        ...AS_META,
        scopes_supported: undefined,
        authorization_endpoint: 'https://mcp.data.example/authorize',
        token_endpoint: 'https://mcp.data.example/token',
      }),
    })
    const auth = await discoverAuth(RESOURCE, impl)
    expect(auth.authorizationEndpoint).toBe('https://mcp.data.example/authorize')
    expect(auth.scope).toBeNull()
  })

  it('refuses a server with no usable metadata, or one without S256', async () => {
    await expect(discoverAuth(RESOURCE, fakeFetch({}).impl)).rejects.toMatchObject({ code: 'discovery_failed' })
    const { impl } = fakeFetch({
      'https://mcp.data.example/.well-known/oauth-authorization-server': () => json({ ...AS_META, code_challenge_methods_supported: ['plain'] }),
    })
    await expect(discoverAuth(RESOURCE, impl)).rejects.toMatchObject({ code: 'pkce_unsupported' })
  })

  it('ignores endpoints that are not https', async () => {
    const { impl } = fakeFetch({
      'https://mcp.data.example/.well-known/oauth-authorization-server': () => json({ ...AS_META, token_endpoint: 'http://auth.data.example/token' }),
    })
    await expect(discoverAuth(RESOURCE, impl)).rejects.toBeInstanceOf(McpOAuthError)
  })
})

describe('registration, authorize and tokens', () => {
  const auth = {
    resource: RESOURCE,
    authorizationEndpoint: AS_META.authorization_endpoint,
    tokenEndpoint: AS_META.token_endpoint,
    registrationEndpoint: AS_META.registration_endpoint,
    scope: 'read offline_access',
  }

  it('registers a public client with the callback URL', async () => {
    const { impl, calls } = fakeFetch({ [AS_META.registration_endpoint]: () => json({ client_id: 'client-1' }, 201) })
    const client = await registerClient(auth, { redirectUri: 'https://app.fund.example/cb', clientName: 'Portfolio' }, impl)
    expect(client).toEqual({ clientId: 'client-1', clientSecret: null })
    const sent = JSON.parse(String(calls[0].init?.body))
    expect(sent).toMatchObject({ redirect_uris: ['https://app.fund.example/cb'], token_endpoint_auth_method: 'none', scope: 'read offline_access' })
  })

  it('says so when the server offers no registration', async () => {
    await expect(registerClient({ ...auth, registrationEndpoint: null }, { redirectUri: 'x', clientName: 'y' }, fakeFetch({}).impl))
      .rejects.toMatchObject({ code: 'registration_unsupported' })
  })

  it('builds a PKCE authorization URL naming the resource', () => {
    const pkce = createPkce()
    expect(pkce.challenge).toBe(createHash('sha256').update(pkce.verifier).digest('base64url'))
    const url = new URL(buildAuthorizationUrl({
      auth, client: { clientId: 'client-1', clientSecret: null }, redirectUri: 'https://app.fund.example/cb', state: 'nonce', codeChallenge: pkce.challenge,
    }))
    expect(url.origin + url.pathname).toBe(AS_META.authorization_endpoint)
    expect(Object.fromEntries(url.searchParams)).toEqual({
      response_type: 'code', client_id: 'client-1', redirect_uri: 'https://app.fund.example/cb', state: 'nonce',
      code_challenge: pkce.challenge, code_challenge_method: 'S256', resource: RESOURCE, scope: 'read offline_access',
    })
  })

  it('exchanges a code and computes the expiry', async () => {
    const { impl, calls } = fakeFetch({
      [AS_META.token_endpoint]: () => json({ access_token: 'at-1', refresh_token: 'rt-1', expires_in: 3600, scope: 'read' }),
    })
    const tokens = await exchangeCode({
      tokenEndpoint: AS_META.token_endpoint, client: { clientId: 'client-1', clientSecret: 'shh' }, code: 'code-1',
      codeVerifier: 'v', redirectUri: 'https://app.fund.example/cb', resource: RESOURCE, fetchImpl: impl, now: 1_000,
    })
    expect(tokens).toEqual({ accessToken: 'at-1', refreshToken: 'rt-1', expiresAt: 1_000 + 3_600_000, scope: 'read' })
    const body = new URLSearchParams(String(calls[0].init?.body))
    expect(Object.fromEntries(body)).toMatchObject({ grant_type: 'authorization_code', code: 'code-1', code_verifier: 'v', resource: RESOURCE, client_id: 'client-1', client_secret: 'shh' })
  })

  it('keeps the old refresh token when the server does not rotate it', async () => {
    const { impl } = fakeFetch({ [AS_META.token_endpoint]: () => json({ access_token: 'at-2', expires_in: 60 }) })
    const tokens = await refreshTokens({ tokenEndpoint: AS_META.token_endpoint, client: { clientId: 'c', clientSecret: null }, refreshToken: 'rt-1', resource: RESOURCE, fetchImpl: impl, now: 0 })
    expect(tokens.refreshToken).toBe('rt-1')
  })

  it('carries the OAuth error code on a refused refresh', async () => {
    const { impl } = fakeFetch({ [AS_META.token_endpoint]: () => json({ error: 'invalid_grant' }, 400) })
    await expect(refreshTokens({ tokenEndpoint: AS_META.token_endpoint, client: { clientId: 'c', clientSecret: null }, refreshToken: 'rt', resource: RESOURCE, fetchImpl: impl }))
      .rejects.toMatchObject({ code: 'invalid_grant' })
  })
})
