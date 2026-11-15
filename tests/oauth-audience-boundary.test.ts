import { beforeEach, describe, expect, it, vi } from 'vitest'
import { hashToken } from '@/lib/oauth/store'

/**
 * SEC-009 / Phase 4.5 item 4 — the audience boundary, exercised through the resolvers the routes
 * actually call rather than through `resolveAccessToken` alone.
 *
 * The finding was that `resource` was honoured at the authorization endpoint, persisted onto the
 * token, and then never read: a token a client obtained for the advertised MCP resource
 * authenticated against `/api/v1` too. Conversations, chat and pending-action approvals live behind
 * that boundary, so the two are not interchangeable.
 */

const rows: Record<string, any>[] = []

vi.mock('@/lib/supabase/admin', () => ({ createAdminClient: () => admin }))
vi.mock('@/lib/oauth/enabled', () => ({ agentApiEnabled: async () => true }))
vi.mock('@/lib/access/effective', async importOriginal => ({
  ...(await importOriginal<typeof import('@/lib/access/effective')>()),
  loadAccessContext: async () => ({
    fundId: 'fund-1',
    userId: 'user-1',
    role: 'member',
    features: {},
    grants: {},
    defaults: {},
  }),
}))

const admin: any = {
  from(table: string) {
    const filters: Array<(r: any) => boolean> = []
    const source = () => (table === 'oauth_tokens' ? rows : [{ fund_id: 'fund-1', user_id: 'user-1', role: 'member' }])
    const chain: any = {
      select: () => chain,
      eq: (column: string, value: unknown) => {
        filters.push(r => r[column] === value)
        return chain
      },
      maybeSingle: async () => ({ data: source().filter(r => filters.every(f => f(r)))[0] ?? null, error: null }),
    }
    return chain
  },
}

import { resolveV1Principal, V1PrincipalError } from '@/lib/api-v1/principal'
import { resolveAgentAuth } from '@/lib/accounting/api-keys'

function issue(token: string, resource: string | null) {
  rows.push({
    token_hash: hashToken(token),
    kind: 'access',
    client_id: 'client-1',
    user_id: 'user-1',
    fund_id: 'fund-1',
    scope: 'read write',
    resource,
    expires_at: new Date(Date.now() + 3_600_000).toISOString(),
    revoked_at: null,
  })
}

const bearer = (token: string) =>
  new Request('https://reporting.test/api/v1/me', { headers: { Authorization: `Bearer ${token}` } })

beforeEach(() => {
  rows.length = 0
  vi.clearAllMocks()
})

describe('a token issued for /api/v1', () => {
  beforeEach(() => issue('mcp_at_native', 'https://reporting.test/api/v1'))

  it('is accepted at the v1 boundary', async () => {
    const principal = await resolveV1Principal(admin, bearer('mcp_at_native'))
    expect(principal.fundId).toBe('fund-1')
    expect(principal.credentialKind).toBe('oauth')
  })

  it('is refused at the MCP boundary', async () => {
    expect(await resolveAgentAuth(admin, bearer('mcp_at_native'))).toBeNull()
  })
})

describe('a token issued for the advertised MCP resource', () => {
  beforeEach(() => issue('mcp_at_agent', 'https://reporting.test/api/mcp'))

  it('is accepted at the MCP boundary', async () => {
    const resolved = await resolveAgentAuth(admin, bearer('mcp_at_agent'))
    expect(resolved?.fundId).toBe('fund-1')
  })

  it('is refused at /api/v1 — the finding, closed', async () => {
    await expect(resolveV1Principal(admin, bearer('mcp_at_agent'))).rejects.toThrow(V1PrincipalError)
  })

  it('is refused with the SAME error as an unknown token, so neither can be told from the other', async () => {
    const wrongAudience = await resolveV1Principal(admin, bearer('mcp_at_agent')).catch(e => e)
    const unknown = await resolveV1Principal(admin, bearer('mcp_at_nonexistent')).catch(e => e)
    expect(wrongAudience.status).toBe(unknown.status)
    expect(wrongAudience.code).toBe(unknown.code)
    expect(wrongAudience.message).toBe(unknown.message)
  })
})

describe('a token that claimed no resource', () => {
  beforeEach(() => issue('mcp_at_legacy', null))

  it('is refused at both boundaries now that no such tokens remain', async () => {
    // The transitional allowance for tokens predating the check is gone: consent stamps the fund's
    // MCP resource on a request that names none, so a token without one is refused everywhere.
    await expect(resolveV1Principal(admin, bearer('mcp_at_legacy'))).rejects.toThrow(V1PrincipalError)
    expect(await resolveAgentAuth(admin, bearer('mcp_at_legacy'))).toBeNull()
  })
})

describe('the investor connector boundary', () => {
  it('refuses an investor token at the fund MCP and at /api/v1', async () => {
    issue('mcp_at_investor', 'https://reporting.test/api/portal/mcp')
    expect(await resolveAgentAuth(admin, bearer('mcp_at_investor'))).toBeNull()
    await expect(resolveV1Principal(admin, bearer('mcp_at_investor'))).rejects.toThrow(V1PrincipalError)
  })

  it('accepts only an investor token there: never a fund token, never one that claimed no resource', async () => {
    const { resolveAccessToken } = await import('@/lib/oauth/store')
    issue('mcp_at_investor', 'https://reporting.test/api/portal/mcp')
    issue('mcp_at_agent', 'https://reporting.test/api/mcp')
    issue('mcp_at_legacy', null)
    expect((await resolveAccessToken(admin, 'mcp_at_investor', 'portal'))?.fundId).toBe('fund-1')
    expect(await resolveAccessToken(admin, 'mcp_at_agent', 'portal')).toBeNull()
    expect(await resolveAccessToken(admin, 'mcp_at_legacy', 'portal')).toBeNull()
  })
})
