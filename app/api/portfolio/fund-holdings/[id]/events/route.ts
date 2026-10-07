import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
// portfolio domain, investments feature (lib/access/route-domains.ts).
import { assertReadAccess, assertWriteAccess } from '@/lib/api-helpers'
import { confirmFundCapitalEvent, resolveHoldingVehicle } from '@/lib/portfolio/fof-register'
import { loadAccessContext } from '@/lib/access/effective'
import { canSeeVehicle, scopeCompanyRows, visibleVehicleIds } from '@/lib/access/scope'

// The register for one fund holding: calls and distributions RECEIVED from the manager.
export async function GET(_req: NextRequest, props: { params: Promise<{ id: string }> }) {
  const params = await props.params;
  const supabase = await createClient()
  const admin = createAdminClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  const gate = await assertReadAccess(admin, user.id)
  if (gate instanceof NextResponse) return gate

  const { data } = await (admin as any)
    .from('fund_capital_events').select('*')
    .eq('fund_id', gate.fundId).eq('company_id', params.id)
    .order('event_date')
  // Only the caller's entities' notices — another fund's commitment to this holding is not theirs.
  const access = await loadAccessContext(admin, gate.fundId, gate.userId, gate.role)
  return NextResponse.json({ events: scopeCompanyRows((data as any[]) ?? [], visibleVehicleIds(access), 'vehicle_id') })
}

// POST — record a notice as a DRAFT. Nothing posts until it is confirmed.
// { kind, eventDate, amount, dueDate?, noticeNumber?, description?, vehicleId?,
//   purposeInvestments?/purposeFees?/purposeExpenses? | charReturnOfCapital?/charRealizedGain?/charIncome?/recallableAmount? }
export async function POST(req: NextRequest, props: { params: Promise<{ id: string }> }) {
  const params = await props.params;
  const supabase = await createClient()
  const admin = createAdminClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  const gate = await assertWriteAccess(admin, user.id)
  if (gate instanceof NextResponse) return gate

  const body = await req.json().catch(() => ({}))
  const kind = body?.kind === 'distribution' ? 'distribution' : 'call'
  const amount = Number(body?.amount)
  if (!Number.isFinite(amount) || amount < 0) {
    return NextResponse.json({ error: 'amount must be a non-negative number' }, { status: 400 })
  }
  if (typeof body?.eventDate !== 'string') {
    return NextResponse.json({ error: 'eventDate is required' }, { status: 400 })
  }

  // WHICH OF OUR ENTITIES RECEIVED THIS NOTICE. Required, and validated against this fund.
  //
  // This used to be `body?.vehicleId ?? null`, and the form never sent one — so every notice
  // recorded here landed with a null vehicle. Two things then went wrong: `confirmFundCapitalEvent`
  // refuses an event with no vehicle ("no books to post to"), so the notice could never be
  // confirmed and never reached the ledger; and `fund_capital_events.vehicle_id` is the only place
  // a fund holding's vehicle is recorded, so the schedule of investments had nothing to scope by
  // and showed every entity's holdings on every entity's page.
  //
  // After the first notice names the entity, the rest infer it — see resolveHoldingVehicle.
  const resolved = await resolveHoldingVehicle(admin, gate.fundId, params.id, body?.vehicleId,
    await loadAccessContext(admin, gate.fundId, gate.userId, gate.role))
  if ('error' in resolved) return NextResponse.json({ error: resolved.error }, { status: 400 })

  // Default the split to the whole amount so a notice recorded without a breakdown still
  // confirms. transactionForEvent refuses a split that does not reconcile, and defaulting to
  // zero would make every quick entry fail at confirm time for no good reason.
  const purposeInvestments = body?.purposeInvestments ?? (kind === 'call' ? amount : 0)
  const charReturnOfCapital = body?.charReturnOfCapital ?? (kind === 'distribution' ? amount : 0)

  const { data, error } = await (admin as any).from('fund_capital_events').insert({
    fund_id: gate.fundId,
    vehicle_id: resolved.vehicleId,
    company_id: params.id,
    kind,
    event_date: body.eventDate,
    due_date: body?.dueDate ?? null,
    notice_number: body?.noticeNumber ?? null,
    description: body?.description ?? null,
    amount,
    purpose_investments: Number(purposeInvestments ?? 0),
    purpose_fees: Number(body?.purposeFees ?? 0),
    purpose_expenses: Number(body?.purposeExpenses ?? 0),
    char_return_of_capital: Number(charReturnOfCapital ?? 0),
    char_realized_gain: Number(body?.charRealizedGain ?? 0),
    char_income: Number(body?.charIncome ?? 0),
    recallable_amount: Number(body?.recallableAmount ?? 0),
    status: 'draft',
    source: 'manual',
    created_by: user.id,
  }).select('id').single()

  if (error || !data) return NextResponse.json({ error: error?.message ?? 'Insert failed' }, { status: 500 })
  return NextResponse.json({ id: data.id })
}

// PATCH — confirm a draft, producing its investment_transactions row and a draft ledger entry.
// { eventId }
export async function PATCH(req: NextRequest, props: { params: Promise<{ id: string }> }) {
  const params = await props.params
  const supabase = await createClient()
  const admin = createAdminClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  const gate = await assertWriteAccess(admin, user.id)
  if (gate instanceof NextResponse) return gate

  const body = await req.json().catch(() => ({}))
  if (typeof body?.eventId !== 'string') {
    return NextResponse.json({ error: 'eventId is required' }, { status: 400 })
  }

  // Confirming books the notice into its entity's ledger — it must be one of the caller's.
  const { data: event } = await (admin as any).from('fund_capital_events').select('vehicle_id')
    .eq('id', body.eventId).eq('fund_id', gate.fundId).eq('company_id', params.id).maybeSingle()
  const confirmAccess = await loadAccessContext(admin, gate.fundId, gate.userId, gate.role)
  if (!event || !canSeeVehicle(confirmAccess, (event as any).vehicle_id ?? null)) {
    return NextResponse.json({ error: 'Not found' }, { status: 404 })
  }

  const result = await confirmFundCapitalEvent(admin, gate.fundId, user.id, body.eventId)
  // A split that does not reconcile is the user's mistake to fix, not a server fault.
  if (!result.ok) return NextResponse.json(result, { status: 400 })
  return NextResponse.json(result)
}
