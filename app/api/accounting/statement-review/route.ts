import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
// lp_capital domain, gated on the lp_tracking switch, read level for both methods
// (lib/access/route-domains.ts): running a review reports on figures, it changes none of them.
import { assertReadAccess } from '@/lib/api-helpers'
import { resolveGroupOr400 } from '@/lib/accounting/http-vehicle'
import { vehicleIdByName } from '@/lib/accounting/vehicle-id'
import { outcomeResponse } from '@/lib/service-outcome'
import { rateLimit } from '@/lib/rate-limit'
import { getReview, listReviews, runReview } from '@/lib/statement-review/store'

// Statement review for one vehicle (lib/statement-review, docs/spec/statement-review.md).
//
//   GET  ?group=…                          → { reviews }: every run, newest period first
//   GET  ?group=…&id=… | &period_end=…     → one review: its package, checks and findings
//   POST { group, input: 'admin_pull', period_end | pull_id, materiality? }
//   POST { group, input: 'csv', csv, file_name?, period_end, period_start?, fund?, materiality? }
//   POST { group, input: 'package', package, materiality? }
//                                          → run the checks and save the review

async function gate(req: NextRequest) {
  const supabase = await createClient()
  const admin = createAdminClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return { error: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }) }
  const g = await assertReadAccess(admin, user.id)
  if (g instanceof NextResponse) return { error: g }
  return { admin, user, gate: g }
}

async function vehicleFor(admin: ReturnType<typeof createAdminClient>, g: any, requested: unknown) {
  const group = await resolveGroupOr400(admin, g, typeof requested === 'string' ? requested : null)
  if (group instanceof NextResponse) return { error: group }
  const id = await vehicleIdByName(admin, g.fundId, group)
  if (!id) return { error: NextResponse.json({ error: 'Unknown vehicle' }, { status: 400 }) }
  return { vehicle: { id, name: group } }
}

export async function GET(req: NextRequest) {
  const g = await gate(req)
  if ('error' in g) return g.error
  const sp = req.nextUrl.searchParams
  const v = await vehicleFor(g.admin, g.gate, sp.get('group'))
  if ('error' in v) return v.error
  const id = sp.get('id')
  const periodEnd = sp.get('period_end')
  if (id || periodEnd) return outcomeResponse(await getReview(g.admin, g.gate.fundId, v.vehicle, { id, periodEnd }))
  return NextResponse.json({ vehicle: v.vehicle.name, reviews: await listReviews(g.admin, g.gate.fundId, v.vehicle.id) })
}

export async function POST(req: NextRequest) {
  const g = await gate(req)
  if ('error' in g) return g.error
  const body = await req.json().catch(() => ({}))
  const v = await vehicleFor(g.admin, g.gate, body?.group)
  if ('error' in v) return v.error
  const limited = await rateLimit({ key: `statement-review:${g.user.id}`, limit: 30, windowSeconds: 600 })
  if (limited) return limited
  return outcomeResponse(await runReview(g.admin, { fundId: g.gate.fundId, userId: g.user.id }, v.vehicle, {
    input: body?.input,
    periodEnd: body?.period_end,
    periodStart: body?.period_start,
    pullId: body?.pull_id,
    csv: body?.csv,
    fileName: body?.file_name,
    fund: body?.fund,
    package: body?.package,
    materiality: body?.materiality,
  }))
}
