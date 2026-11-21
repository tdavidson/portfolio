import { NextRequest } from 'next/server'
// lp_capital domain, gated on the lp_tracking switch, write level (lib/access/route-domains.ts).
import { outcomeResponse } from '@/lib/service-outcome'
import { reviewRouteContext } from '@/lib/statement-review/http'
import { signOffReview } from '@/lib/statement-review/store'

// Sign off a period's current review once no error or warning is open (lib/statement-review/store.ts).
//
//   POST { group, review_id, note? } → the signed-off review

export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => ({}))
  const r = await reviewRouteContext(true, body?.group)
  if ('error' in r) return r.error
  return outcomeResponse(await signOffReview(r.admin, { fundId: r.fundId, userId: r.user.id }, r.vehicle, body?.review_id, body?.note))
}
