import { NextRequest, NextResponse } from 'next/server'
import { listConnections, requestConnection } from '@/lib/fund-connections'
import { connectionErrorResponse, gateConnectionAdmin } from '@/lib/fund-connections/route-helpers'

// Fund connections (Settings → Organization → Connected funds). Admin-only. See lib/fund-connections.
//
//   GET                → { connections: ConnectionView[] }   pending and active, both directions
//   POST { email }     → { id, otherFundName }               ask the fund `email` is an admin of

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
  try {
    return NextResponse.json(await requestConnection(g.admin, { fundId: g.fundId, userId: g.userId, email: body.email }))
  } catch (e) {
    return connectionErrorResponse(e, 'settings-fund-connections')
  }
}
