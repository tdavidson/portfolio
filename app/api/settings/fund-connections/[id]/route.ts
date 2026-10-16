import { NextRequest, NextResponse } from 'next/server'
import { endConnection, respondToConnection } from '@/lib/fund-connections'
import { connectionErrorResponse, gateConnectionAdmin } from '@/lib/fund-connections/route-helpers'

// One fund connection, from the caller's side. Admin-only.
//
//   PATCH { action: 'accept' | 'decline' }   answer a request made to this fund
//   DELETE                                    cancel our request, decline theirs, or disconnect
//                                             (which removes every investor pair under it)

export async function PATCH(req: NextRequest, props: { params: Promise<{ id: string }> }) {
  const { id } = await props.params
  const g = await gateConnectionAdmin()
  if (g instanceof NextResponse) return g
  const body = await req.json().catch(() => ({}))
  if (body?.action !== 'accept' && body?.action !== 'decline') return NextResponse.json({ error: 'action must be accept or decline' }, { status: 400 })
  try {
    await respondToConnection(g.admin, { fundId: g.fundId, userId: g.userId, connectionId: id, accept: body.action === 'accept' })
    return NextResponse.json({ ok: true })
  } catch (e) {
    return connectionErrorResponse(e, 'settings-fund-connections-id')
  }
}

export async function DELETE(_req: NextRequest, props: { params: Promise<{ id: string }> }) {
  const { id } = await props.params
  const g = await gateConnectionAdmin()
  if (g instanceof NextResponse) return g
  try {
    await endConnection(g.admin, { fundId: g.fundId, userId: g.userId, connectionId: id })
    return NextResponse.json({ ok: true })
  } catch (e) {
    return connectionErrorResponse(e, 'settings-fund-connections-id')
  }
}
