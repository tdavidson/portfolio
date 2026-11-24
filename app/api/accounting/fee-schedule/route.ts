// A vehicle's dated management fee schedule (lib/accounting/fee-schedule.ts).
//
//   GET  ?group=X               the schedule, or null
//   GET  ?group=X&date=D        also the fee it charges for the period D falls in
//   GET  ?group=X&periods=1     also every period: its fee and what is booked against it
//   PUT  ?group=X  { schedule } set it; a null schedule clears it

import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
// accounting domain (see lib/access/route-domains.ts), the same as the allocation that books the fee.
import { assertWriteAccess, assertReadAccess } from '@/lib/api-helpers'
import { resolveGroupOr400 } from '@/lib/accounting/http-vehicle'
import { feeSchedulePeriods, loadFeeSchedule, saveFeeSchedule, scheduledFee } from '@/lib/accounting/fee-schedule'
import { dbError } from '@/lib/api-error'

export async function GET(req: NextRequest) {
  const supabase = await createClient()
  const admin = createAdminClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  const gate = await assertReadAccess(admin, user.id)
  if (gate instanceof NextResponse) return gate
  const group = await resolveGroupOr400(admin, gate, req.nextUrl.searchParams.get('group'))
  if (group instanceof NextResponse) return group

  if (req.nextUrl.searchParams.get('periods') === '1') {
    const out = await feeSchedulePeriods(admin, gate.fundId, group)
    if ('error' in out) return NextResponse.json({ error: out.error }, { status: 400 })
    return NextResponse.json({ group, ...out })
  }

  const schedule = await loadFeeSchedule(admin, gate.fundId, group)
  const date = req.nextUrl.searchParams.get('date')
  const fee = schedule && date && /^\d{4}-\d{2}-\d{2}$/.test(date) ? await scheduledFee(admin, gate.fundId, group, date) : null
  return NextResponse.json({ group, schedule, ...(fee ? { fee } : {}) })
}

export async function PUT(req: NextRequest) {
  const supabase = await createClient()
  const admin = createAdminClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  const gate = await assertWriteAccess(admin, user.id)
  if (gate instanceof NextResponse) return gate

  const body = await req.json().catch(() => ({}))
  const group = await resolveGroupOr400(admin, gate, body?.group ?? req.nextUrl.searchParams.get('group'))
  if (group instanceof NextResponse) return group

  const saved = await saveFeeSchedule(admin, gate.fundId, group, body?.schedule ?? null, { userId: user.id })
  if ('error' in saved) {
    if (saved.dbError) return dbError(saved.dbError, 'fee-schedule-put')
    return NextResponse.json({ error: saved.error }, { status: saved.status })
  }
  return NextResponse.json({ ok: true, schedule: saved.schedule })
}
