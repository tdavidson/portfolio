import { NextRequest, NextResponse } from 'next/server'
import { sendPortalMessage } from '@/lib/portal/service'
import { portalErrorResponse, sessionPrincipal } from '@/lib/portal/session'
import { rateLimit } from '@/lib/rate-limit'

/**
 * LP portal "Contact / ask a question" submission. Records the message and emails the fund's
 * admins (best-effort). LP-only; scoped to the LP's fund.
 */
export async function POST(req: NextRequest) {
  const s = await sessionPrincipal()
  if (s instanceof NextResponse) return s
  // Each message emails every fund admin. Same meter as the connector's write calls
  // (app/api/portal/mcp), so the two paths share one budget per LP account.
  const limited = await rateLimit({ key: `portal-mcp:w:${s.principal.lpAccountId}`, limit: 20, windowSeconds: 60 })
  if (limited) return limited
  const body = await req.json().catch(() => ({}))
  try {
    return NextResponse.json(await sendPortalMessage(s.admin, s.principal, body))
  } catch (e) {
    return portalErrorResponse(e, 'portal-contact')
  }
}
