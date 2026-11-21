import { NextRequest } from 'next/server'
// lp_capital domain, gated on the lp_tracking switch, write level (lib/access/route-domains.ts):
// a reviewer's decision on a finding.
import { outcomeResponse } from '@/lib/service-outcome'
import { reviewRouteContext } from '@/lib/statement-review/http'
import { noteFinding } from '@/lib/statement-review/store'

// One finding on a period's current review (lib/statement-review/workflow.ts).
//
//   PATCH { group, review_id, key, status?, note?, question? }
//         → { review, finding }: status open | explained | asked | accepted; explained and accepted need a note

export async function PATCH(req: NextRequest) {
  const body = await req.json().catch(() => ({}))
  const r = await reviewRouteContext(true, body?.group)
  if ('error' in r) return r.error
  return outcomeResponse(await noteFinding(r.admin, { fundId: r.fundId, userId: r.user.id }, r.vehicle, body?.review_id, {
    key: body?.key, status: body?.status, note: body?.note, question: body?.question,
  }))
}
