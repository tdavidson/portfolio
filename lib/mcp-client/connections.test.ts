import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { memoryAdmin } from '../../tests/helpers/memory-admin'
import { encrypt, decrypt } from '@/lib/crypto'
import { getMcpServerForUser, isMcpServerEnabled, setMcpServerEnabled } from './connections'
import type { FetchLike } from './oauth'

const KEK = 'b'.repeat(64)
const DEK = 'c'.repeat(64)
const NOW = Date.parse('2026-11-06T12:00:00Z')
const SPECTER = 'https://mcp.tryspecter.com/mcp'

function setup(row: Record<string, unknown> = {}, enabled: string[] = ['specter']) {
  return memoryAdmin({
    fund_settings: [{ fund_id: 'fund-1', encryption_key_encrypted: encrypt(DEK, KEK), mcp_servers_enabled: enabled }],
    mcp_connections: [{
      id: 'conn-1', user_id: 'user-1', fund_id: 'fund-1', server_id: 'specter',
      client_id: 'client-1', client_secret_encrypted: null, token_endpoint: 'https://auth.data.example/token',
      access_token_encrypted: encrypt('at-old', DEK), refresh_token_encrypted: encrypt('rt-old', DEK),
      expires_at: new Date(NOW + 60 * 60 * 1000).toISOString(),
      read_tools: ['find_company'], tools_checked_at: new Date(NOW - 60 * 1000).toISOString(),
      last_error: null, created_at: new Date(NOW).toISOString(), last_used_at: null,
      ...row,
    }],
  })
}

const noNetwork: FetchLike = async () => { throw new Error('no network expected') }

describe('getMcpServerForUser', () => {
  let saved: string | undefined
  beforeEach(() => { saved = process.env.ENCRYPTION_KEY; process.env.ENCRYPTION_KEY = KEK })
  afterEach(() => { process.env.ENCRYPTION_KEY = saved })

  it('returns the member’s token and read-only allowlist', async () => {
    const { admin } = setup()
    const server = await getMcpServerForUser(admin as any, 'user-1', 'specter', { fetchImpl: noNetwork, now: NOW })
    expect(server).toEqual({ name: 'specter', url: SPECTER, authorizationToken: 'at-old', allowedTools: ['find_company'] })
  })

  it('is null when an admin has not turned the server on for the fund', async () => {
    const { admin } = setup({}, [])
    expect(await getMcpServerForUser(admin as any, 'user-1', 'specter', { fetchImpl: noNetwork, now: NOW })).toBeNull()
  })

  it('is null for a member who has not connected, or an unknown server', async () => {
    const { admin } = setup()
    expect(await getMcpServerForUser(admin as any, 'user-2', 'specter', { fetchImpl: noNetwork, now: NOW })).toBeNull()
    expect(await getMcpServerForUser(admin as any, 'user-1', 'nope', { fetchImpl: noNetwork, now: NOW })).toBeNull()
  })

  it('refreshes a token about to expire and stores the new one', async () => {
    const { admin, tables } = setup({ expires_at: new Date(NOW + 30 * 1000).toISOString() })
    const fetchImpl: FetchLike = async () => new Response(JSON.stringify({ access_token: 'at-new', refresh_token: 'rt-new', expires_in: 3600 }), { headers: { 'content-type': 'application/json' } })
    const server = await getMcpServerForUser(admin as any, 'user-1', 'specter', { fetchImpl, now: NOW })
    expect(server?.authorizationToken).toBe('at-new')
    const row = tables.mcp_connections[0]
    expect(decrypt(row.access_token_encrypted, DEK)).toBe('at-new')
    expect(decrypt(row.refresh_token_encrypted, DEK)).toBe('rt-new')
    expect(row.expires_at).toBe(new Date(NOW + 3_600_000).toISOString())
  })

  it('flags the connection when the refresh is refused', async () => {
    const { admin, tables } = setup({ expires_at: new Date(NOW - 1000).toISOString() })
    const fetchImpl: FetchLike = async () => new Response(JSON.stringify({ error: 'invalid_grant' }), { status: 400, headers: { 'content-type': 'application/json' } })
    expect(await getMcpServerForUser(admin as any, 'user-1', 'specter', { fetchImpl, now: NOW })).toBeNull()
    expect(tables.mcp_connections[0].last_error).toMatch(/revoked or expired/)
  })

  it('gives the assistant nothing when the server has no read-only tools', async () => {
    const { admin } = setup({ read_tools: [] })
    expect(await getMcpServerForUser(admin as any, 'user-1', 'specter', { fetchImpl: noNetwork, now: NOW })).toBeNull()
  })

  it('keeps the old tool list when a stale one can’t be re-read', async () => {
    const { admin } = setup({ tools_checked_at: new Date(NOW - 2 * 24 * 60 * 60 * 1000).toISOString() })
    const server = await getMcpServerForUser(admin as any, 'user-1', 'specter', { fetchImpl: noNetwork, now: NOW })
    expect(server?.allowedTools).toEqual(['find_company'])
  })
})

describe('fund switch', () => {
  it('turns a server on and off without touching others', async () => {
    const { admin, tables } = setup({}, ['other'])
    await setMcpServerEnabled(admin as any, 'fund-1', 'specter', true)
    expect(tables.fund_settings[0].mcp_servers_enabled).toEqual(['other', 'specter'])
    expect(await isMcpServerEnabled(admin as any, 'fund-1', 'specter')).toBe(true)
    await setMcpServerEnabled(admin as any, 'fund-1', 'specter', false)
    expect(tables.fund_settings[0].mcp_servers_enabled).toEqual(['other'])
    expect(await isMcpServerEnabled(admin as any, 'fund-1', 'specter')).toBe(false)
  })
})
