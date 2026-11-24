// A vehicle's management fee schedule, period by period (lib/accounting/fee-periods.ts).
//
//   GET  ?group=X                       the stored periods with their lines, the manager, and how
//                                       many would change if regenerated from the terms
//   POST { group, action, periodId?, … } generate | edit (patch) | reset | waive | unwaive |
//                                       post | draft (all?, through?)

import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
// accounting domain (see lib/access/route-domains.ts), the same as the fee schedule and the allocation that books the fee.
import { assertWriteAccess, assertReadAccess } from '@/lib/api-helpers'
import { resolveGroupOr400 } from '@/lib/accounting/http-vehicle'
import { listFeePeriods, runFeePeriodAction } from '@/lib/accounting/fee-periods'
import { loadMayTouchInvestments } from '@/lib/accounting/investment-access'

export const maxDuration = 120

export async function GET(req: NextRequest) {
  const supabase = await createClient()
  const admin = createAdminClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  const gate = await assertReadAccess(admin, user.id)
  if (gate instanceof NextResponse) return gate
  const group = await resolveGroupOr400(admin, gate, req.nextUrl.searchParams.get('group'))
  if (group instanceof NextResponse) return group
  const out = await listFeePeriods(admin, gate.fundId, group)
  if ('error' in out) return NextResponse.json({ error: out.error }, { status: 400 })
  return NextResponse.json(out)
}

export async function POST(req: NextRequest) {
  const supabase = await createClient()
  const admin = createAdminClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  const gate = await assertWriteAccess(admin, user.id)
  if (gate instanceof NextResponse) return gate
  const body = await req.json().catch(() => ({}))
  const group = await resolveGroupOr400(admin, gate, body?.group ?? req.nextUrl.searchParams.get('group'))
  if (group instanceof NextResponse) return group
  const out = await runFeePeriodAction(admin, {
    fundId: gate.fundId, userId: user.id, role: gate.role,
    mayTouchInvestments: () => loadMayTouchInvestments(admin, gate, user.id),
  }, group, body)
  return NextResponse.json(out.body, { status: out.status })
}
