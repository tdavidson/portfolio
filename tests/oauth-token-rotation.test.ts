import { beforeEach, describe, expect, it } from 'vitest'
import { hashToken, issueTokens, resolveAccessToken, rotateRefreshToken } from '@/lib/oauth/store'

/**
 * The refresh boundary, which is where a leaked credential either dies or becomes permanent.
 *
 * Four properties, and none of them are visible from the happy path: a rotated refresh token stops
 * working; a token presented by a client it was not issued to is refused; presenting an
 * already-rotated token revokes everything for that (client, user) pair rather than quietly minting
 * a new pair for whoever asked; and a refresh re-derives the scope ceiling from the user's CURRENT
 * role, so a demotion cannot be laundered into another hour of write access.
 *
 * The last two are why this file exists — both were implemented and neither was covered.
 */

interface TokenRow {
  id: string
  token_hash: string
  kind: 'access' | 'refresh'
  client_id: string
  user_id: string
  fund_id: string
  scope: string
  resource: string | null
  expires_at: string
  revoked_at: string | null
  last_used_at: string | null
}

/** An in-memory oauth_tokens + fund_members, honest enough about filters to be worth trusting. */
function db() {
  const tokens: TokenRow[] = []
  let memberRows: Record<string, { fund_id: string; user_id: string; role: string }> = {
    'fund-1|user-1': { fund_id: 'fund-1', user_id: 'user-1', role: 'admin' },
  }
  let seq = 0

  function builder(table: string) {
    const filters: Array<(row: any) => boolean> = []
    let patch: Record<string, unknown> | null = null

    const rowsFor = () => {
      const source =
        table === 'oauth_tokens'
          ? tokens
          : Object.keys(memberRows).map(k => memberRows[k])
      return source.filter(row => filters.every(f => f(row)))
    }

    const chain: any = {
      select: () => chain,
      eq: (col: string, value: unknown) => {
        filters.push(row => row[col] === value)
        return chain
      },
      is: (col: string, value: unknown) => {
        filters.push(row => (row[col] ?? null) === value)
        return chain
      },
      update: (values: Record<string, unknown>) => {
        patch = values
        return chain
      },
      insert: async (rows: Record<string, unknown>[]) => {
        for (const row of rows) tokens.push({ id: `t${++seq}`, revoked_at: null, last_used_at: null, ...(row as any) })
        return { error: null }
      },
      maybeSingle: async () => {
        // Like PostgREST: an update's filters pick the rows BEFORE the patch, and those rows come back.
        const matched = rowsFor()
        if (patch) for (const row of matched) Object.assign(row, patch)
        return { data: matched[0] ?? null, error: null }
      },
      // Awaiting the chain applies a pending update — how the store issues its revokes.
      then: (resolve: (v: unknown) => unknown, reject: (r: unknown) => unknown) => {
        if (patch) for (const row of rowsFor()) Object.assign(row, patch)
        return Promise.resolve({ data: null, error: null }).then(resolve, reject)
      },
    }
    return chain
  }

  return {
    admin: { from: (table: string) => builder(table) } as any,
    tokens,
    setRole: (role: string) => {
      memberRows = { 'fund-1|user-1': { fund_id: 'fund-1', user_id: 'user-1', role } }
    },
    removeMember: () => {
      memberRows = {}
    },
    find: (token: string) => tokens.find(t => t.token_hash === hashToken(token)),
  }
}

let store: ReturnType<typeof db>

async function issue(scope = 'read write') {
  return issueTokens(store.admin, {
    clientId: 'client-1',
    userId: 'user-1',
    fundId: 'fund-1',
    scope,
    resource: 'https://reporting.test/api/mcp',
  })
}

beforeEach(() => {
  store = db()
})

describe('refresh-token rotation', () => {
  it('mints a new pair and revokes the presented refresh token', async () => {
    const first = await issue()
    const rotated = await rotateRefreshToken(store.admin, {
      clientId: 'client-1',
      refreshToken: first.refreshToken,
    })

    expect(rotated).not.toBeNull()
    expect(rotated!.refreshToken).not.toBe(first.refreshToken)
    expect(rotated!.accessToken).not.toBe(first.accessToken)
    expect(store.find(first.refreshToken)!.revoked_at).not.toBeNull()
    expect(store.find(rotated!.refreshToken)!.revoked_at).toBeNull()
  })

  it('carries the resource indicator onto the new pair', async () => {
    const first = await issue()
    const rotated = await rotateRefreshToken(store.admin, { clientId: 'client-1', refreshToken: first.refreshToken })
    expect(store.find(rotated!.refreshToken)!.resource).toBe('https://reporting.test/api/mcp')
  })

  it('refuses a refresh token presented by a DIFFERENT client', async () => {
    const first = await issue()
    const rotated = await rotateRefreshToken(store.admin, {
      clientId: 'client-2',
      refreshToken: first.refreshToken,
    })
    expect(rotated).toBeNull()
    // …and refusing must not have burned the honest client's token.
    expect(store.find(first.refreshToken)!.revoked_at).toBeNull()
  })

  it('refuses an unknown refresh token', async () => {
    await issue()
    expect(await rotateRefreshToken(store.admin, { clientId: 'client-1', refreshToken: 'mcp_rt_nope' })).toBeNull()
  })

  it('refuses an access token presented where a refresh token belongs', async () => {
    const first = await issue()
    expect(
      await rotateRefreshToken(store.admin, { clientId: 'client-1', refreshToken: first.accessToken }),
    ).toBeNull()
  })

  it('refuses an expired refresh token', async () => {
    const first = await issue()
    store.find(first.refreshToken)!.expires_at = new Date(Date.now() - 1000).toISOString()
    expect(
      await rotateRefreshToken(store.admin, { clientId: 'client-1', refreshToken: first.refreshToken }),
    ).toBeNull()
  })

  it('treats a replayed refresh token as a leak and revokes every live token for that client and user', async () => {
    const first = await issue()
    const second = await rotateRefreshToken(store.admin, {
      clientId: 'client-1',
      refreshToken: first.refreshToken,
    })
    expect(second).not.toBeNull()

    // The attacker (or the honest client, indistinguishably) presents the old one again.
    const replay = await rotateRefreshToken(store.admin, {
      clientId: 'client-1',
      refreshToken: first.refreshToken,
    })
    expect(replay).toBeNull()

    expect(store.find(second!.refreshToken)!.revoked_at).not.toBeNull()
    expect(store.find(second!.accessToken)!.revoked_at).not.toBeNull()
    expect(await resolveAccessToken(store.admin, second!.accessToken)).toBeNull()
  })

  it('re-derives the scope ceiling from the user’s CURRENT role, so a demotion cannot be refreshed away', async () => {
    const first = await issue('read write')
    store.setRole('viewer')
    const rotated = await rotateRefreshToken(store.admin, {
      clientId: 'client-1',
      refreshToken: first.refreshToken,
    })
    expect(rotated!.scope).toBe('read')
    expect((await resolveAccessToken(store.admin, rotated!.accessToken))!.scope).toBe('read')
  })

  it('revokes everything when the user has left the fund', async () => {
    const first = await issue()
    store.removeMember()
    expect(
      await rotateRefreshToken(store.admin, { clientId: 'client-1', refreshToken: first.refreshToken }),
    ).toBeNull()
    expect(store.find(first.accessToken)!.revoked_at).not.toBeNull()
  })
})

describe('access-token resolution fails uniformly', () => {
  it('resolves a live token', async () => {
    const first = await issue()
    expect(await resolveAccessToken(store.admin, first.accessToken)).toMatchObject({
      userId: 'user-1',
      fundId: 'fund-1',
      clientId: 'client-1',
      scope: 'read write',
    })
  })

  it('returns null — not a distinguishable error — for unknown, expired, and revoked tokens alike', async () => {
    const first = await issue()
    const expired = await issue()
    const revoked = await issue()
    store.find(expired.accessToken)!.expires_at = new Date(Date.now() - 1000).toISOString()
    store.find(revoked.accessToken)!.revoked_at = new Date().toISOString()

    expect(await resolveAccessToken(store.admin, 'mcp_at_unknown')).toBeNull()
    expect(await resolveAccessToken(store.admin, expired.accessToken)).toBeNull()
    expect(await resolveAccessToken(store.admin, revoked.accessToken)).toBeNull()
    expect(await resolveAccessToken(store.admin, first.refreshToken)).toBeNull()
  })
})

describe('SEC-009 — a token is bound to the boundary it was issued for', () => {
  /**
   * The `resource` parameter was honoured at the authorization endpoint and persisted onto the
   * token, and then never read. A token obtained for the MCP endpoint — the resource the discovery
   * document advertises — authenticated against /api/v1 too, where conversations and
   * pending-action approvals live.
   */
  async function issueFor(resource: string | null) {
    return issueTokens(store.admin, {
      clientId: 'client-1',
      userId: 'user-1',
      fundId: 'fund-1',
      scope: 'read write',
      resource,
    })
  }

  it('accepts an MCP token at the MCP boundary and refuses it at /api/v1', async () => {
    const tokens = await issueFor('https://reporting.test/api/mcp')
    expect(await resolveAccessToken(store.admin, tokens.accessToken, 'mcp')).not.toBeNull()
    expect(await resolveAccessToken(store.admin, tokens.accessToken, 'v1')).toBeNull()
  })

  it('accepts a v1 token at /api/v1 and refuses it at the MCP endpoint', async () => {
    const tokens = await issueFor('https://reporting.test/api/v1')
    expect(await resolveAccessToken(store.admin, tokens.accessToken, 'v1')).not.toBeNull()
    expect(await resolveAccessToken(store.admin, tokens.accessToken, 'mcp')).toBeNull()
  })

  it('ignores the host, which differs per deployment, and compares the path', async () => {
    const tokens = await issueFor('https://some-preview-deploy.vercel.app/api/v1/chat')
    expect(await resolveAccessToken(store.admin, tokens.accessToken, 'v1')).not.toBeNull()
  })

  it('refuses a resource naming something this server does not serve', async () => {
    const tokens = await issueFor('https://evil.example.com/api/whatever')
    expect(await resolveAccessToken(store.admin, tokens.accessToken, 'v1')).toBeNull()
    expect(await resolveAccessToken(store.admin, tokens.accessToken, 'mcp')).toBeNull()
  })

  it('refuses a malformed resource rather than treating it as unclaimed', async () => {
    const tokens = await issueFor('not-a-url')
    expect(await resolveAccessToken(store.admin, tokens.accessToken, 'v1')).toBeNull()
  })

  it('still accepts a token that claimed NO resource, which is the transitional case', async () => {
    // Deliberate: tokens issued before this check exist with resource null, and rejecting them
    // would sign out every current client to close a gap they are not the ones exploiting. The
    // attack in the finding is closed regardless, because that token carries the WRONG resource
    // rather than none. Tighten once no null-resource tokens remain.
    const tokens = await issueFor(null)
    expect(await resolveAccessToken(store.admin, tokens.accessToken, 'v1')).not.toBeNull()
    expect(await resolveAccessToken(store.admin, tokens.accessToken, 'mcp')).not.toBeNull()
  })

  it('reports the resource it resolved, so a caller can log what was presented', async () => {
    const tokens = await issueFor('https://reporting.test/api/mcp')
    expect((await resolveAccessToken(store.admin, tokens.accessToken, 'mcp'))!.resource)
      .toBe('https://reporting.test/api/mcp')
  })
})
