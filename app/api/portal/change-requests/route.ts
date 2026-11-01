import { NextRequest, NextResponse } from 'next/server'
import { portalErrorResponse, sessionPrincipal } from '@/lib/portal/session'
import { rateLimit } from '@/lib/rate-limit'
import {
  myChangeRequests, portalRecord, requestAuthorizedUser, requestProfileChange, withdrawChangeRequest,
} from '@/lib/lps/change-requests'

/**
 * LP portal: ask the fund to change your record, or to give someone access to act for you. Nothing
 * changes until someone at the fund approves it. lib/lps/change-requests.ts.
 *
 *   GET                 → { record, requests }  your record (entities, contact) and your requests
 *   POST { kind: 'profile', entity_id, entity?, contact?, note? }
 *      | { kind: 'authorized_user', investor_id?, email, name?, note? }
 *   DELETE ?id=…        → withdraw one of your pending requests
 */

export async function GET() {
  const s = await sessionPrincipal()
  if (s instanceof NextResponse) return s
  try {
    const [record, requests] = await Promise.all([portalRecord(s.admin, s.principal), myChangeRequests(s.admin, s.principal)])
    return NextResponse.json({ record, requests })
  } catch (e) {
    return portalErrorResponse(e, 'portal-change-requests')
  }
}

export async function POST(req: NextRequest) {
  const s = await sessionPrincipal()
  if (s instanceof NextResponse) return s
  // Each request emails the fund's admins; shares the connector's write meter.
  const limited = await rateLimit({ key: `portal-mcp:w:${s.principal.lpAccountId}`, limit: 20, windowSeconds: 60 })
  if (limited) return limited
  const body = await req.json().catch(() => ({}))
  try {
    if (body?.kind === 'authorized_user') return NextResponse.json(await requestAuthorizedUser(s.admin, s.principal, body))
    if (body?.kind === 'profile') return NextResponse.json(await requestProfileChange(s.admin, s.principal, body))
    return NextResponse.json({ error: "kind must be 'profile' or 'authorized_user'" }, { status: 400 })
  } catch (e) {
    return portalErrorResponse(e, 'portal-change-requests')
  }
}

export async function DELETE(req: NextRequest) {
  const s = await sessionPrincipal()
  if (s instanceof NextResponse) return s
  try {
    return NextResponse.json(await withdrawChangeRequest(s.admin, s.principal, req.nextUrl.searchParams.get('id')))
  } catch (e) {
    return portalErrorResponse(e, 'portal-change-requests')
  }
}
