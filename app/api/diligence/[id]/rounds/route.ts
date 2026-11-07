import { NextRequest, NextResponse } from 'next/server'
import { outcomeResponse } from '@/lib/service-outcome'
import { listRounds, startNextRound } from '@/lib/diligence/rounds-service'
import { ensureDealMember } from '@/lib/diligence/route-guard'

/** The deal's diligence rounds, oldest first, each with its latest draft and what arrived in it. */
export async function GET(_req: NextRequest, props: { params: Promise<{ id: string }> }) {
  const params = await props.params
  const guard = await ensureDealMember(params.id)
  if ('error' in guard) return guard.error
  return NextResponse.json(await listRounds(guard.admin, guard.fundId, params.id))
}

/**
 * Start the next round: closes the current one (with its outcome, notes and follow-up request list)
 * and carries its evidence, memo and scores forward. Body: { label?, outcome?, summary? }.
 */
export async function POST(req: NextRequest, props: { params: Promise<{ id: string }> }) {
  const params = await props.params
  const guard = await ensureDealMember(params.id)
  if ('error' in guard) return guard.error
  const body = await req.json().catch(() => ({}))
  return outcomeResponse(await startNextRound(guard.admin, { fundId: guard.fundId, userId: guard.userId }, params.id, {
    label: body?.label, outcome: body?.outcome, summary: body?.summary,
  }))
}
