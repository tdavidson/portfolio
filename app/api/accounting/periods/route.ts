import { approveCloses } from '@/lib/accounting/close-approval'
import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
// accounting domain (lib/access/route-domains.ts). The middleware has already checked the caller's
// grant for this route + method; these resolve identity and keep the demo out of writes.
import { assertWriteAccess, assertReadAccess } from '@/lib/api-helpers'
import { resolveGroupOr400 } from '@/lib/accounting/http-vehicle'
import { listPeriods } from '@/lib/accounting/periods'
import { previewCloseThrough, closeThrough, loadCloseEntries, nextCloseStart } from '@/lib/accounting/close'
import { reopenClosedPeriods } from '@/lib/accounting/reopen'
import { outcomeResponse } from '@/lib/service-outcome'
import { vehicleIdByName } from '@/lib/accounting/vehicle-id'
import { createSuggestedDrafts } from '@/lib/accounting/close-suggestions'

// GET — { periods, nextStart }: a vehicle's fiscal periods plus where the next close would
// start (the page derives the still-open months from it), or (?entriesFor=<periodId>) the
// allocation transactions a specific closed period posted.
export async function GET(req: NextRequest) {
  const supabase = await createClient()
  const admin = createAdminClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  const gate = await assertReadAccess(admin, user.id)
  if (gate instanceof NextResponse) return gate
  const group = await resolveGroupOr400(admin, gate, req.nextUrl.searchParams.get('group'))
  if (group instanceof NextResponse) return group

  const entriesFor = req.nextUrl.searchParams.get('entriesFor')
  if (entriesFor) return NextResponse.json(await loadCloseEntries(admin, gate.fundId, group, entriesFor))

  const [periods, nextStart] = await Promise.all([
    listPeriods(admin, gate.fundId, group),
    nextCloseStart(admin, gate.fundId, group),
  ])
  const vehicleId = await vehicleIdByName(admin, gate.fundId, group)
  const periodIds = periods.map(period => period.id)
  const { data: reviews } = periodIds.length === 0
    ? { data: [] as any[] }
    : await admin.from('close_reviews' as any)
      .select('id, fiscal_period_id, status, approved_at, approved_by, attestation, close_review_checks(check_key, section, label, status, detail, evidence, sort_order)')
      .eq('fund_id', gate.fundId).eq('vehicle_id', vehicleId).in('fiscal_period_id', periodIds)
  const reviewByPeriod = new Map(((reviews as any[]) ?? []).map(review => [review.fiscal_period_id, review]))
  return NextResponse.json({ periods: periods.map(period => ({ ...period, close_review: reviewByPeriod.get(period.id) ?? null })), nextStart })
}

// POST
//   { action: 'preview', endDate } → what closing THROUGH this date would allocate,
//                                     month by month (start is derived — no gaps)
//   { action: 'close',   endDate } → close every month through it, in order
//   { action: 'reopen',  id }      → reopen that period and every closed period after it,
//                                     newest-first, voiding each one's allocation
//   { action: 'reopen',  fromDate } → same, for every closed period covering or after the date
//   reopen requires { reason }, recorded with who reopened (accounting_audit_events)
//   { action: 'approve', id | through, attestation? } → sign off prepared close reviews
//                                     (a different member from the preparer — close-approval.ts)
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

  if (body?.action === 'preview') {
    const result = await previewCloseThrough(admin, gate.fundId, group, body?.endDate)
    if ('error' in result) return NextResponse.json({ error: result.error }, { status: 400 })
    return NextResponse.json(result)
  }

  if (body?.action === 'createSuggestedDrafts') {
    const endDate = String(body?.endDate ?? '')
    const start = await nextCloseStart(admin, gate.fundId, group)
    if (!start) return NextResponse.json({ error: 'Nothing is available to close.' }, { status: 400 })
    const ids = Array.isArray(body?.ids) ? body.ids.filter((id: unknown): id is string => typeof id === 'string') : []
    if (ids.length === 0) return NextResponse.json({ error: 'Select at least one suggested entry.' }, { status: 400 })
    const result = await createSuggestedDrafts(admin, gate.fundId, group, user.id, start, endDate, ids)
    if ('error' in result) return NextResponse.json({ error: result.error }, { status: 400 })
    return NextResponse.json(result)
  }

  if (body?.action === 'reopen') {
    // Shared with the reopen_period tool (lib/accounting/reopen.ts).
    return outcomeResponse(await reopenClosedPeriods(admin, { fundId: gate.fundId, userId: user.id }, group, {
      id: body?.id, fromDate: body?.fromDate, reason: body?.reason,
    }))
  }

  if (body?.action === 'approve') {
    const target = body?.id ? { periodId: String(body.id) } : typeof body?.through === 'string' ? { through: body.through } : null
    if (!target) return NextResponse.json({ error: 'id or through is required' }, { status: 400 })
    const result = await approveCloses(admin, gate.fundId, group, user.id, target, typeof body?.attestation === 'string' ? body.attestation : null)
    if ('error' in result) return NextResponse.json({ error: result.error }, { status: 400 })
    return NextResponse.json(result)
  }

  const result = await closeThrough(admin, gate.fundId, group, user.id, body?.endDate)
  if ('error' in result) return NextResponse.json({ error: result.error }, { status: 400 })
  return NextResponse.json({ ok: true, ...result })
}
