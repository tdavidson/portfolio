import { describe, it, expect } from 'vitest'
import { consumeMcpOAuthState, createMcpOAuthState } from './oauth-state'

const KEY = 'a'.repeat(64)
const TX = {
  serverId: 'specter', userId: 'user-1', fundId: 'fund-1', codeVerifier: 'v', clientId: 'c',
  clientSecret: null, tokenEndpoint: 'https://auth.data.example/token', resource: 'https://mcp.data.example/mcp',
}

describe('connector sign-in state', () => {
  it('round-trips for the same user, server and nonce', () => {
    const { state, cookie } = createMcpOAuthState({ ...TX, encryptionKey: KEY, now: 0 })
    expect(consumeMcpOAuthState({ cookie, encryptionKey: KEY, state, serverId: 'specter', userId: 'user-1', now: 1 })).toEqual(TX)
  })

  it('refuses another user, another server, a wrong nonce or an expired cookie', () => {
    const { state, cookie } = createMcpOAuthState({ ...TX, encryptionKey: KEY, now: 0 })
    const base = { cookie, encryptionKey: KEY, state, serverId: 'specter', userId: 'user-1', now: 1 }
    expect(consumeMcpOAuthState({ ...base, userId: 'user-2' })).toBeNull()
    expect(consumeMcpOAuthState({ ...base, serverId: 'other' })).toBeNull()
    expect(consumeMcpOAuthState({ ...base, state: 'forged' })).toBeNull()
    expect(consumeMcpOAuthState({ ...base, now: 11 * 60 * 1000 })).toBeNull()
    expect(consumeMcpOAuthState({ ...base, cookie: 'garbage' })).toBeNull()
  })
})
