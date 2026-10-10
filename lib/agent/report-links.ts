// Download links for documents an assistant hands over — a capital account statement, an LP
// report card. An MCP tool result is JSON text, and hosts disagree on embedded binaries, so the
// tool returns a LINK, and the document is rendered when the link is opened.
//
// The link is self-authenticating, because whoever opens it is a browser with no credential: the
// conversation's OAuth token never leaves the host. So it is a signed, short-lived token naming
// the member, the fund and the document. That makes it a bearer token for one document for an
// hour — and so the download route does NOT trust it beyond identifying the request: it re-reads
// the member's live access and refuses if they have since lost the grant, the entity or the fund
// (app/api/agent/reports/[token]/route.ts). Nothing is stored; there is nothing to clean up.
//
// The key is derived from ENCRYPTION_KEY with a purpose label, so it is never the key that
// wraps stored credentials (lib/crypto.ts), and rotating ENCRYPTION_KEY voids every link.

import { createHmac, hkdfSync, timingSafeEqual } from 'crypto'

export type ReportKind = 'lp_statement' | 'lp_report_card'

export interface ReportLinkClaims {
  fundId: string
  userId: string
  kind: ReportKind
  /** What to render: vehicle, LP entity and period for a statement; investor ids for a report card. */
  args: Record<string, string | string[] | null>
  /** Unix seconds. */
  exp: number
}

/** One hour: long enough to click from the conversation, short enough to be worthless when forwarded. */
export const REPORT_LINK_TTL_SECONDS = 60 * 60

function key(): Buffer {
  const secret = process.env.ENCRYPTION_KEY
  if (!secret) throw new Error('ENCRYPTION_KEY environment variable is not set')
  return Buffer.from(hkdfSync('sha256', secret, 'portfolio', 'agent-report-link-v1', 32))
}

const b64 = (b: Buffer | string) => Buffer.from(b).toString('base64url')
const mac = (body: string) => createHmac('sha256', key()).update(body).digest()

export function signReportLink(claims: Omit<ReportLinkClaims, 'exp'>, now = Date.now()): { token: string; expiresAt: string } {
  const exp = Math.floor(now / 1000) + REPORT_LINK_TTL_SECONDS
  const body = b64(JSON.stringify({ ...claims, exp }))
  return { token: `${body}.${b64(mac(body))}`, expiresAt: new Date(exp * 1000).toISOString() }
}

/** The claims, or null for anything forged, malformed or expired. */
export function verifyReportLink(token: string, now = Date.now()): ReportLinkClaims | null {
  const [body, sig, extra] = String(token ?? '').split('.')
  if (!body || !sig || extra !== undefined) return null
  const given = Buffer.from(sig, 'base64url')
  const expected = mac(body)
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null
  let claims: ReportLinkClaims
  try {
    claims = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'))
  } catch {
    return null
  }
  if (!claims || typeof claims.exp !== 'number' || claims.exp * 1000 <= now) return null
  if (typeof claims.fundId !== 'string' || typeof claims.userId !== 'string') return null
  if (claims.kind !== 'lp_statement' && claims.kind !== 'lp_report_card') return null
  return claims
}

export function reportLinkUrl(origin: string, token: string): string {
  return `${origin.replace(/\/$/, '')}/api/agent/reports/${token}`
}
