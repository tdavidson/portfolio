import { NextRequest, NextResponse } from 'next/server'
import { approvePairs, connectionPairs, removePair, type PairRequest } from '@/lib/fund-connections'
import { connectionErrorResponse, gateConnectionAdmin } from '@/lib/fund-connections/route-helpers'

// The investor pairs on an active fund connection, from the caller's side. Admin-only.
//
//   GET                                   → { pairs, suggestions }
//   POST { pairs: PairRequest[] }         → { changed, skipped }   propose, or approve theirs
//   DELETE { linkId }                     remove a pair (either side may)
//
// A pair carries positions onto report cards only once both funds' admins have approved it.

export async function GET(_req: NextRequest, props: { params: Promise<{ id: string }> }) {
  const { id } = await props.params
  const g = await gateConnectionAdmin()
  if (g instanceof NextResponse) return g
  try {
    return NextResponse.json(await connectionPairs(g.admin, { fundId: g.fundId, connectionId: id }))
  } catch (e) {
    return connectionErrorResponse(e, 'settings-fund-connections-pairs')
  }
}

const isRequest = (r: any): r is PairRequest =>
  r && typeof r.ourInvestorId === 'string'
  && (r.theirInvestorId === undefined || typeof r.theirInvestorId === 'string')
  && (r.theirMatch === undefined || typeof r.theirMatch === 'string')

export async function POST(req: NextRequest, props: { params: Promise<{ id: string }> }) {
  const { id } = await props.params
  const g = await gateConnectionAdmin()
  if (g instanceof NextResponse) return g
  const body = await req.json().catch(() => ({}))
  const requests = Array.isArray(body?.pairs) ? body.pairs : null
  if (!requests || requests.length === 0 || requests.length > 1000 || !requests.every(isRequest)) {
    return NextResponse.json({ error: 'pairs must be a list of { ourInvestorId, theirInvestorId | theirMatch }' }, { status: 400 })
  }
  try {
    return NextResponse.json(await approvePairs(g.admin, { fundId: g.fundId, userId: g.userId, connectionId: id, requests }))
  } catch (e) {
    return connectionErrorResponse(e, 'settings-fund-connections-pairs')
  }
}

export async function DELETE(req: NextRequest, props: { params: Promise<{ id: string }> }) {
  const { id } = await props.params
  const g = await gateConnectionAdmin()
  if (g instanceof NextResponse) return g
  const body = await req.json().catch(() => ({}))
  if (typeof body?.linkId !== 'string') return NextResponse.json({ error: 'linkId is required' }, { status: 400 })
  try {
    await removePair(g.admin, { fundId: g.fundId, userId: g.userId, connectionId: id, linkId: body.linkId })
    return NextResponse.json({ ok: true })
  } catch (e) {
    return connectionErrorResponse(e, 'settings-fund-connections-pairs')
  }
}
