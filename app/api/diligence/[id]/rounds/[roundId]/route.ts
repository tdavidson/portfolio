import { NextRequest } from 'next/server'
import { outcomeResponse } from '@/lib/service-outcome'
import { roundDetail, updateRound } from '@/lib/diligence/rounds-service'
import { ensureDealMember } from '@/lib/diligence/route-guard'

/**
 * One round in full: what changed in its evidence since the previous round, what the previous round
 * asked for, the request list it leaves, and the documents that arrived in it. roundId may be the
 * round's id, its number, or "current".
 */
export async function GET(_req: NextRequest, props: { params: Promise<{ id: string; roundId: string }> }) {
  const params = await props.params
  const guard = await ensureDealMember(params.id)
  if ('error' in guard) return guard.error
  return outcomeResponse(await roundDetail(guard.admin, guard.fundId, params.id, params.roundId))
}

/**
 * Rename a round, edit its notes or outcome, close the current round ({ status: 'closed' }), or reopen
 * the latest round when it was closed by mistake ({ status: 'open' }).
 */
export async function PATCH(req: NextRequest, props: { params: Promise<{ id: string; roundId: string }> }) {
  const params = await props.params
  const guard = await ensureDealMember(params.id)
  if ('error' in guard) return guard.error
  const body = await req.json().catch(() => ({}))
  return outcomeResponse(await updateRound(guard.admin, { fundId: guard.fundId, userId: guard.userId }, params.id, params.roundId, {
    label: body?.label, summary: body?.summary, outcome: body?.outcome, status: body?.status,
  }))
}
