import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
// lp_capital domain (lib/access/route-domains.ts). The middleware has already checked the caller's
// grant for this route + method; these resolve identity and keep the demo out of writes.
import { assertWriteAccess, assertReadAccess } from '@/lib/api-helpers'
import { resolveGroupOr400 } from '@/lib/accounting/http-vehicle'
import { loadEntityNames } from '@/lib/accounting/load'
import { vehicleIdByName } from '@/lib/accounting/vehicle-id'
import { commitmentsAsOf } from '@/lib/accounting/terms'
import { outcomeResponse } from '@/lib/service-outcome'
import { addCommitmentChange, correctCommitmentEvent, deleteCommitmentEvent } from '@/lib/lps/records'

// GET ?asOf=YYYY-MM-DD — commitment history, plus each partner's commitment as of a date.
// Queries commitment_events directly (rather than the loadCommitmentEvents loader) because the
// UI needs `id`/`transferId` to edit and delete events, which the loader's pure-logic shape omits.
export async function GET(req: NextRequest) {
  const supabase = await createClient()
  const admin = createAdminClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  const gate = await assertReadAccess(admin, user.id)
  if (gate instanceof NextResponse) return gate
  const group = await resolveGroupOr400(admin, gate, req.nextUrl.searchParams.get('group'))
  if (group instanceof NextResponse) return group

  const vehicleId = await vehicleIdByName(admin, gate.fundId, group)
  const asOf = req.nextUrl.searchParams.get('asOf')
  const [{ data: rows, error: rowsError }, names] = await Promise.all([
    admin
      .from('commitment_events' as any)
      .select('id, lp_entity_id, effective_date, amount, kind, transfer_id, counterparty_entity_id, memo')
      .eq('fund_id', gate.fundId)
      .eq('vehicle_id', vehicleId)
      .order('effective_date', { ascending: true }),
    loadEntityNames(admin, gate.fundId, group),
  ])
  if (rowsError) return NextResponse.json({ error: rowsError.message }, { status: 500 })

  const eventRows = (rows as any[]) ?? []
  const commitments = commitmentsAsOf(
    eventRows.map(e => ({ lpEntityId: e.lp_entity_id, effectiveDate: e.effective_date, amount: Number(e.amount), kind: e.kind })),
    asOf
  )

  return NextResponse.json({
    asOf: asOf ?? null,
    partners: Array.from(commitments.entries())
      .map(([lpEntityId, commitment]) => ({ lpEntityId, name: names.get(lpEntityId) ?? lpEntityId, commitment }))
      .sort((a, b) => a.name.localeCompare(b.name)),
    events: eventRows
      .map(e => ({
        id: e.id,
        lpEntityId: e.lp_entity_id,
        name: names.get(e.lp_entity_id) ?? e.lp_entity_id,
        effectiveDate: e.effective_date,
        amount: Number(e.amount),
        kind: e.kind,
        transferId: e.transfer_id ?? null,
        counterpartyEntityId: e.counterparty_entity_id ?? null,
        memo: e.memo ?? null,
      }))
      .sort((a, b) => b.effectiveDate.localeCompare(a.effectiveDate)),
  })
}

// POST — record a commitment change.
//   { lpEntityId, effectiveDate, amount }                            → increase/decrease
//   { lpEntityId, effectiveDate, amount, counterpartyEntityId }      → TRANSFER of
//     commitment from the counterparty to lpEntityId (both legs written atomically).
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

  return outcomeResponse(await addCommitmentChange(admin, { fundId: gate.fundId, userId: user.id }, group, {
    lpEntityId: body?.lpEntityId,
    effectiveDate: body?.effectiveDate,
    amount: Number(body?.amount),
    counterpartyEntityId: body?.counterpartyEntityId ?? null,
    memo: body?.memo ?? null,
  }))
}

// PATCH { id, effectiveDate?, amount?, memo? } — correct a wrong effective date/amount/memo on an
// already-recorded event. A transfer leg refuses an amount change (delete + re-enter instead) but
// allows date/memo, applied to BOTH legs so the pair stays consistent.
export async function PATCH(req: NextRequest) {
  const supabase = await createClient()
  const admin = createAdminClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  const gate = await assertWriteAccess(admin, user.id)
  if (gate instanceof NextResponse) return gate

  const body = await req.json().catch(() => ({}))
  const group = await resolveGroupOr400(admin, gate, body?.group ?? req.nextUrl.searchParams.get('group'))
  if (group instanceof NextResponse) return group

  return outcomeResponse(await correctCommitmentEvent(admin, { fundId: gate.fundId, userId: user.id }, group, body?.id, {
    effectiveDate: body?.effectiveDate, amount: body?.amount, memo: body?.memo, reason: body?.reason,
  }))
}

// DELETE { id } — remove a wrongly-entered event. A transfer leg deletes BOTH legs sharing its
// transfer_id, so the fund's total commitment can't drift.
export async function DELETE(req: NextRequest) {
  const supabase = await createClient()
  const admin = createAdminClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  const gate = await assertWriteAccess(admin, user.id)
  if (gate instanceof NextResponse) return gate

  const body = await req.json().catch(() => ({}))
  const group = await resolveGroupOr400(admin, gate, body?.group ?? req.nextUrl.searchParams.get('group'))
  if (group instanceof NextResponse) return group

  // Shared with the lp_delete_commitment tool (lib/lps/records.ts).
  return outcomeResponse(
    await deleteCommitmentEvent(admin, { fundId: gate.fundId, userId: user.id }, group, body?.id, body?.reason),
    () => ({ ok: true }),
  )
}
