import { NextResponse } from 'next/server'
import { portalActivity } from '@/lib/portal/service'
import { portalErrorResponse, sessionPrincipal } from '@/lib/portal/session'

/**
 * LP portal — the signed-in LP's own dated capital movements (calls, distributions, transfers),
 * newest first. Same scope as the overview: the investors resolveLpAccess grants, funds whose
 * portal is on and whose live report is published to them (lib/portal/service.ts).
 */
export async function GET() {
  const s = await sessionPrincipal()
  if (s instanceof NextResponse) return s
  try {
    return NextResponse.json(await portalActivity(s.admin, s.principal))
  } catch (e) {
    return portalErrorResponse(e, 'portal-activity')
  }
}
