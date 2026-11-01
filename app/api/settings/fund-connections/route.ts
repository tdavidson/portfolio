import { NextRequest, NextResponse } from 'next/server'
import { CONNECTION_REQUEST_SENT, listConnections, requestConnection } from '@/lib/fund-connections'
import { rateLimit } from '@/lib/rate-limit'
import { connectionErrorResponse, gateConnectionAdmin } from '@/lib/fund-connections/route-helpers'

// Fund connections (Settings → Organization → Connected funds). Admin-only. See lib/fund-connections.
//
//   GET                → { connections: ConnectionView[] }   pending and active, both directions
//   POST { email }     → { message }                          ask the fund `email` is an admin of;
//                        the same answer whether or not it is one, and metered per fund

export async function GET() {
  const g = await gateConnectionAdmin()
  if (g instanceof NextResponse) return g
  try {
    return NextResponse.json({ connections: await listConnections(g.admin, g.fundId) })
  } catch (e) {
    return connectionErrorResponse(e, 'settings-fund-connections')
  }
}

export async function POST(req: NextRequest) {
  const g = await gateConnectionAdmin()
  if (g instanceof NextResponse) return g
  const body = await req.json().catch(() => ({}))
  if (typeof body?.email !== 'string') return NextResponse.json({ error: 'Enter the email address of an admin of the other fund.' }, { status: 400 })
  const limited = await rateLimit({ key: `fund-connection-request:${g.fundId}`, limit: 10, windowSeconds: 86_400 })
  if (limited) return limited
  try {
    await requestConnection(g.admin, { fundId: g.fundId, userId: g.userId, email: body.email })
    return NextResponse.json({ message: CONNECTION_REQUEST_SENT })
  } catch (e) {
    return connectionErrorResponse(e, 'settings-fund-connections')
  }
}
