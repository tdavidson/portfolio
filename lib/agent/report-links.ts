// Download links for documents an assistant hands over — a capital account statement, an LP
// report card, the fund performance report, the financial statements, a K-1, the tax package. An MCP tool result is JSON text, and hosts disagree on embedded binaries, so the
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

// `portal_statement` and `portal_letter` are the investor connector's (app/api/portal/mcp): the LP's
// own live statement, and a letter shared with them.
// The rest are the fund's own documents (lib/reports/documents.ts), each re-gated at the click
// exactly as its web route gates it. `template_document` is a stored render of one of the fund's
// own document templates (lib/document-templates). `call_notice_preview` is one partner's notice for
// an issued capital call, marked DRAFT, before it is published (preview_call_notices). `close_bundle`
// is a closed period's reproducibility bundle as a ZIP (close_bundle; lib/accounting/close-bundle.ts).
// `forecast_workbook` is a plan as the Forecast page's Excel model (lib/forecast/workbook.ts).
export const REPORT_KINDS = [
  'lp_statement', 'lp_report_card', 'portal_statement', 'portal_letter',
  'fund_performance', 'financial_statements', 'k1', 'lp_snapshot', 'tax_package', 'lp_letter',
  'template_document', 'call_notice_preview', 'close_bundle', 'forecast_workbook',
] as const
export type ReportKind = typeof REPORT_KINDS[number]

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

/** The claims of a genuine token, expired or not; null for anything forged or malformed. */
function authenticClaims(token: string): ReportLinkClaims | null {
  const [body, sig, extra] = String(token ?? '').split('.')
  if (!body || !sig || extra !== undefined) return null
  const given = Buffer.from(sig, 'base64url')
  const expected = mac(body)
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null
  try {
    const claims = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'))
    return claims && typeof claims.exp === 'number' ? claims : null
  } catch {
    return null
  }
}

/** The claims, or null for anything forged, malformed or expired. */
export function verifyReportLink(token: string, now = Date.now()): ReportLinkClaims | null {
  const claims = authenticClaims(token)
  if (!claims || claims.exp * 1000 <= now) return null
  if (typeof claims.fundId !== 'string' || typeof claims.userId !== 'string') return null
  if (!(REPORT_KINDS as readonly string[]).includes(claims.kind)) return null
  return claims
}

/**
 * True only for a link THIS deployment issued whose hour is up — so the route can say "expired" and
 * mean it, where every other refusal shares one message. That reveals nothing: the expiry is in the
 * token body for anyone to read, and a forged token is still just "not available".
 */
export function isExpiredReportLink(token: string, now = Date.now()): boolean {
  const claims = authenticClaims(token)
  return !!claims && claims.exp * 1000 <= now
}

/**
 * Said with every download link a tool returns. The file behind the link is binary (PDF, Word, Excel
 * or ZIP). Hosts that keep a project's files as text (project docs, notes, memory) refuse it with a
 * "NUL bytes" error, and an assistant that fetches the link to save it there shows the person a
 * failed write instead of the document. So the link goes to the person, and text goes to text stores.
 */
export const DOWNLOAD_LINK_HANDOFF =
  'Give the person this link to open or download; don\'t fetch the file yourself to save it. It is a binary file, ' +
  'and a text-only store (a project\'s docs or notes, or memory) refuses it. If they want the content kept there, ' +
  'save the text form instead: a markdown or JSON export where the tool offers one, or the matching data tool\'s result.'

/** A link's note followed by the hand-off rule above. */
export function linkNote(note: string): string {
  return `${note.trim()} ${DOWNLOAD_LINK_HANDOFF}`
}

export function reportLinkUrl(origin: string, token: string): string {
  return `${origin.replace(/\/$/, '')}/api/agent/reports/${token}`
}
