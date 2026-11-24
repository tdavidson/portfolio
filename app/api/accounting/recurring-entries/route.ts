// A vehicle's recurring journal entries (lib/accounting/recurring-entries.ts).
//
//   GET  ?group=X                      the entries with their cadence, next due date, what is booked,
//                                      missed dates and drafts waiting, and the templates
//   POST { group, action, … }          create | update | pause | resume | delete | preview | book

import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
// accounting domain (see lib/access/route-domains.ts), the same as the journal the entries land in.
import { assertWriteAccess, assertReadAccess } from '@/lib/api-helpers'
import { resolveGroupOr400 } from '@/lib/accounting/http-vehicle'
import { listRecurringEntries, runRecurringAction } from '@/lib/accounting/recurring-entries'
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
  const out = await listRecurringEntries(admin, gate.fundId, group)
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
  const out = await runRecurringAction(admin, {
    fundId: gate.fundId, userId: user.id, role: gate.role,
    mayTouchInvestments: () => loadMayTouchInvestments(admin, gate, user.id),
  }, group, body)
  return NextResponse.json(out.body, { status: out.status })
}
