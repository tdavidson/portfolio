import { randomBytes, timingSafeEqual } from 'crypto'
import { decrypt, encrypt } from '@/lib/crypto'

/**
 * The in-flight state of one connector sign-in, kept in an encrypted, HttpOnly cookie between the
 * connect route and the callback. The browser only sees the opaque nonce in the authorization URL.
 * The cookie also carries the client this sign-in registered, so the callback can redeem the code
 * without storing anything before the member has finished signing in.
 *
 * Same shape as lib/google/oauth-state.ts.
 */

export const MCP_OAUTH_STATE_COOKIE = 'mcp_oauth_state'
export const MCP_OAUTH_STATE_TTL_SECONDS = 10 * 60

export interface McpOAuthTransaction {
  serverId: string
  userId: string
  fundId: string
  codeVerifier: string
  clientId: string
  clientSecret: string | null
  tokenEndpoint: string
  resource: string
}

interface Payload extends McpOAuthTransaction {
  nonce: string
  expiresAt: number
}

function equal(left: string, right: string): boolean {
  const a = Buffer.from(left)
  const b = Buffer.from(right)
  return a.length === b.length && timingSafeEqual(a, b)
}

export function createMcpOAuthState(input: McpOAuthTransaction & { encryptionKey: string; now?: number }): { state: string; cookie: string } {
  const { encryptionKey, now, ...transaction } = input
  const nonce = randomBytes(32).toString('base64url')
  const payload: Payload = {
    ...transaction,
    nonce,
    expiresAt: (now ?? Date.now()) + MCP_OAUTH_STATE_TTL_SECONDS * 1000,
  }
  return { state: nonce, cookie: encrypt(JSON.stringify(payload), encryptionKey) }
}

/** Validate the state the sign-in server carried back. Null when anything doesn't match. */
export function consumeMcpOAuthState(input: {
  cookie: string | null | undefined
  encryptionKey: string
  state: string | null | undefined
  serverId: string
  userId: string
  now?: number
}): McpOAuthTransaction | null {
  if (!input.cookie || !input.state) return null
  try {
    const p = JSON.parse(decrypt(input.cookie, input.encryptionKey)) as Partial<Payload>
    const strings = [p.nonce, p.serverId, p.userId, p.fundId, p.codeVerifier, p.clientId, p.tokenEndpoint, p.resource]
    if (strings.some(v => typeof v !== 'string') || typeof p.expiresAt !== 'number') return null
    if (p.clientSecret !== null && typeof p.clientSecret !== 'string') return null
    if (p.expiresAt < (input.now ?? Date.now())) return null
    if (!equal(p.nonce!, input.state) || !equal(p.userId!, input.userId) || p.serverId !== input.serverId) return null
    return {
      serverId: p.serverId!,
      userId: p.userId!,
      fundId: p.fundId!,
      codeVerifier: p.codeVerifier!,
      clientId: p.clientId!,
      clientSecret: p.clientSecret ?? null,
      tokenEndpoint: p.tokenEndpoint!,
      resource: p.resource!,
    }
  } catch {
    return null
  }
}
