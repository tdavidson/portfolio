// Publishing a capital call's notices from a function that does not ship Chromium.
//
// Each notice is a rendered PDF, so publishing runs only where headless Chromium ships
// (lib/pdf-routes.mjs). The chat's functions (/api/mcp, /api/agent) do not, so they ask
// app/api/agent/call-notices/publish to do it, with a signed token naming the fund, the member and
// exactly what to publish:
//
//   * `staged` — an approved publish_call_notices (lib/pending-actions/call-notices.ts): the call,
//     the partners and the previewToken the person was shown. The route runs the same executor the
//     app's Approvals page does, which refuses a stale token and any blocker.
//   * `proposed_call` — the notices of a call just issued by approving a proposed call
//     (lp_proposed_call_approve), as the app's Approve button publishes them. The route checks the
//     proposal is approved and issued that call.
//
// The token is a bearer for that one publish for a few minutes, and the route trusts it only to say
// who asked for what: it re-checks, live, that the member is still an admin of the fund with the
// access the publish needs. It travels in the Authorization header, never in a URL. The key is
// derived from ENCRYPTION_KEY with its own purpose label, so it is neither a report link's key nor
// the one that wraps stored credentials, and a report link is never accepted here (or vice versa).

import { createHmac, hkdfSync, timingSafeEqual } from 'crypto'
import { currentChangeSource, type ChangeSource } from '@/lib/audit/source'
import { responseError, selfOrigin, selfRequestHeaders, type FetchLike } from './self-request'

export const NOTICE_PUBLISH_PATH = '/api/agent/call-notices/publish'

/** Five minutes: the route verifies it on arrival, so this only has to cover the hop. */
export const NOTICE_PUBLISH_TTL_SECONDS = 5 * 60

interface Base {
  fundId: string
  userId: string
  /** The vehicle (portfolio_group), as resolved for the caller. */
  vehicle: string
  callId: string
  /** Which door the change came through, for the audit trail (lib/audit/source.ts). */
  source?: ChangeSource
}

export type NoticePublishClaims =
  | (Base & { mode: 'staged'; lpEntityIds: string[] | null; previewToken: string; exp: number })
  | (Base & { mode: 'proposed_call'; proposedCallId: string; exp: number })

export type NoticePublishRequest =
  | Omit<Extract<NoticePublishClaims, { mode: 'staged' }>, 'exp'>
  | Omit<Extract<NoticePublishClaims, { mode: 'proposed_call' }>, 'exp'>

/** What the route returns: as executePublishCallNotices does. */
export interface NoticePublishResult {
  callId: string
  published: number
  reused: number
  errors: string[]
}

function key(): Buffer {
  const secret = process.env.ENCRYPTION_KEY
  if (!secret) throw new Error('ENCRYPTION_KEY environment variable is not set')
  return Buffer.from(hkdfSync('sha256', secret, 'portfolio', 'agent-notice-publish-v1', 32))
}

const b64 = (b: Buffer | string) => Buffer.from(b).toString('base64url')
const mac = (body: string) => createHmac('sha256', key()).update(body).digest()

export function signNoticePublish(req: NoticePublishRequest, now = Date.now()): string {
  const exp = Math.floor(now / 1000) + NOTICE_PUBLISH_TTL_SECONDS
  const body = b64(JSON.stringify({ ...req, exp }))
  return `${body}.${b64(mac(body))}`
}

const str = (v: unknown) => typeof v === 'string' && v.length > 0

/** The claims, or null for anything forged, malformed, expired or not naming a whole publish. */
export function verifyNoticePublish(token: string, now = Date.now()): NoticePublishClaims | null {
  const [body, sig, extra] = String(token ?? '').split('.')
  if (!body || !sig || extra !== undefined) return null
  const given = Buffer.from(sig, 'base64url')
  const expected = mac(body)
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null
  let c: any
  try { c = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) } catch { return null }
  if (!c || typeof c.exp !== 'number' || c.exp * 1000 <= now) return null
  if (!str(c.fundId) || !str(c.userId) || !str(c.vehicle) || !str(c.callId)) return null
  if (c.mode === 'staged') {
    if (!str(c.previewToken)) return null
    if (c.lpEntityIds !== null && !(Array.isArray(c.lpEntityIds) && c.lpEntityIds.every(str))) return null
    return c
  }
  if (c.mode === 'proposed_call') return str(c.proposedCallId) ? c : null
  return null
}

/** The token from `Authorization: Bearer <token>`. */
export function bearerToken(header: string | null): string | null {
  const m = /^Bearer\s+(\S+)$/i.exec(header ?? '')
  return m ? m[1] : null
}

/**
 * Ask the Chromium-bundled route to publish, and wait for it. Throws with the route's own words on
 * any refusal or failure, so the caller can say exactly what did not happen.
 */
export async function publishNoticesRemotely(
  req: NoticePublishRequest, opts: { origin?: string; fetch?: FetchLike } = {},
): Promise<NoticePublishResult> {
  const doFetch: FetchLike = opts.fetch ?? ((input, init) => fetch(input, init))
  const token = signNoticePublish({ ...req, source: req.source ?? currentChangeSource() })
  let res: Response
  try {
    res = await doFetch(`${selfOrigin(opts.origin)}${NOTICE_PUBLISH_PATH}`, {
      method: 'POST',
      headers: selfRequestHeaders({ authorization: `Bearer ${token}`, 'content-type': 'application/json' }),
      body: '{}',
      cache: 'no-store',
    })
  } catch (e) {
    throw new Error(`Could not reach the notice publisher: ${(e as Error)?.message ?? 'network error'}.`)
  }
  if (!res.ok) throw new Error(`The notices were not published (${await responseError(res)}).`)
  const body = await res.json().catch(() => null) as { result?: NoticePublishResult } | null
  if (!body?.result || typeof body.result.published !== 'number') {
    throw new Error('The notice publisher answered without a result. Check the call\'s notices in the app before retrying.')
  }
  return body.result
}

/**
 * The executor a chat's approve_action supplies for a staged publish_call_notices
 * (lib/pending-actions/service.ts, `personConfirms`): the same publish the app's Approvals page runs,
 * run by the Chromium-bundled route as the approving admin. The vehicle is the one pinned when it
 * was staged; the route resolves it again through the approver's access.
 */
export function remotePublishCallNoticesExecutor(opts: { origin?: string; fetch?: FetchLike } = {}) {
  return async (deps: { fundId: string; userId: string; origin?: string }, input: any): Promise<Record<string, unknown>> => {
    const vehicle = typeof input?.vehicle === 'string' ? input.vehicle : ''
    const callId = String(input?.callId ?? '')
    const previewToken = String(input?.previewToken ?? '')
    if (!vehicle || !callId || !previewToken) throw new Error('This request names no vehicle, call or preview token. Reject it and stage it again.')
    const lpEntityIds = Array.isArray(input?.lpEntityIds) ? input.lpEntityIds.map(String) : null
    const result = await publishNoticesRemotely(
      { mode: 'staged', fundId: deps.fundId, userId: deps.userId, vehicle, callId, lpEntityIds, previewToken },
      { origin: opts.origin ?? deps.origin, fetch: opts.fetch },
    )
    return { ...result }
  }
}
