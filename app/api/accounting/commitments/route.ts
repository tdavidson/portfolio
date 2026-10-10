import { auditReason, recordAudit } from '@/lib/audit/events'
import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
// lp_capital domain (lib/access/route-domains.ts). The middleware has already checked the caller's
// grant for this route + method; these resolve identity and keep the demo out of writes.
import { assertWriteAccess, assertReadAccess } from '@/lib/api-helpers'
import { resolveGroupOr400 } from '@/lib/accounting/http-vehicle'
import { loadEntityNames } from '@/lib/accounting/load'
import { vehicleIdByName } from '@/lib/accounting/vehicle-id'
import { commitmentsAsOf, recordCommitmentChange } from '@/lib/accounting/terms'

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

  const result = await recordCommitmentChange(admin, gate.fundId, group, user.id, {
    lpEntityId: body?.lpEntityId,
    effectiveDate: body?.effectiveDate,
    amount: Number(body?.amount),
    counterpartyEntityId: body?.counterpartyEntityId ?? null,
    memo: body?.memo ?? null,
  })
  if ('error' in result) return NextResponse.json({ error: result.error }, { status: 400 })
  await recordAudit(admin, {
    fundId: gate.fundId, vehicleId: await vehicleIdByName(admin, gate.fundId, group), actorId: user.id,
    action: 'commitment.create', subjectType: 'lp_entity', subjectId: body?.lpEntityId ?? null, reason: auditReason(body?.memo),
    details: { effectiveDate: body?.effectiveDate, amount: Number(body?.amount), counterpartyEntityId: body?.counterpartyEntityId ?? null },
  })
  return NextResponse.json({ ok: true })
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

  const id = body?.id
  if (!id) return NextResponse.json({ error: 'id is required' }, { status: 400 })

  const vehicleId = await vehicleIdByName(admin, gate.fundId, group)
  const { data: existing, error: fetchError } = await admin
    .from('commitment_events' as any)
    .select('*')
    .eq('fund_id', gate.fundId)
    .eq('vehicle_id', vehicleId)
    .eq('id', id)
    .maybeSingle()
  if (fetchError) return NextResponse.json({ error: fetchError.message }, { status: 500 })
  const row = existing as any
  if (!row) return NextResponse.json({ error: 'Not found' }, { status: 404 })

  // A commitment is what every call and fee is computed from. Changing its amount needs a reason,
  // and every edit is recorded with the event as it was (accounting_audit_events).
  const reason = auditReason(body?.reason)
  if (body?.amount !== undefined && Number(body.amount) !== Number(row.amount) && !reason) {
    return NextResponse.json({ error: 'A reason is required to change a recorded commitment amount.' }, { status: 400 })
  }
  const audit = () => recordAudit(admin, {
    fundId: gate.fundId, vehicleId, actorId: user.id, action: 'commitment.edit', subjectType: 'commitment_event', subjectId: id, reason,
    details: { before: { effectiveDate: row.effective_date, amount: Number(row.amount), memo: row.memo ?? null, kind: row.kind, lpEntityId: row.lp_entity_id, transferId: row.transfer_id ?? null },
      after: { effectiveDate: body?.effectiveDate, amount: body?.amount === undefined ? undefined : Number(body.amount), memo: body?.memo } },
  })

  if (row.transfer_id) {
    if (body?.amount !== undefined) {
      return NextResponse.json({ error: 'To change a transfer amount, delete it and re-enter the transfer.' }, { status: 400 })
    }
    const update: Record<string, unknown> = {}
    if (body?.effectiveDate !== undefined) update.effective_date = body.effectiveDate
    if (body?.memo !== undefined) update.memo = body.memo
    if (Object.keys(update).length > 0) {
      const { error } = await admin
        .from('commitment_events' as any)
        .update(update)
        .eq('fund_id', gate.fundId)
        .eq('transfer_id', row.transfer_id)
      if (error) return NextResponse.json({ error: error.message }, { status: 500 })
      await audit()
    }
    return NextResponse.json({ ok: true })
  }

  const update: Record<string, unknown> = {}
  if (body?.effectiveDate !== undefined) update.effective_date = body.effectiveDate
  if (body?.memo !== undefined) update.memo = body.memo
  if (body?.amount !== undefined) {
    const amt = Number(body.amount)
    if (!Number.isFinite(amt) || amt === 0) return NextResponse.json({ error: 'Amount must be a non-zero number' }, { status: 400 })
    update.amount = amt
    // Preserve an 'initial' marker; only a plain increase/decrease flips with the sign.
    update.kind = row.kind === 'initial' ? 'initial' : amt > 0 ? 'increase' : 'decrease'
  }
  if (Object.keys(update).length > 0) {
    const { error } = await admin
      .from('commitment_events' as any)
      .update(update)
      .eq('fund_id', gate.fundId)
      .eq('vehicle_id', vehicleId)
      .eq('id', id)
    if (error) return NextResponse.json({ error: error.message }, { status: 500 })
    await audit()
  }
  return NextResponse.json({ ok: true })
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

  const id = body?.id
  if (!id) return NextResponse.json({ error: 'id is required' }, { status: 400 })

  const vehicleId = await vehicleIdByName(admin, gate.fundId, group)
  const { data: existing, error: fetchError } = await admin
    .from('commitment_events' as any)
    .select('*')
    .eq('fund_id', gate.fundId)
    .eq('vehicle_id', vehicleId)
    .eq('id', id)
    .maybeSingle()
  if (fetchError) return NextResponse.json({ error: fetchError.message }, { status: 500 })
  const row = existing as any
  if (!row) return NextResponse.json({ error: 'Not found' }, { status: 404 })
  const reason = auditReason(body?.reason)
  if (!reason) return NextResponse.json({ error: 'A reason is required to delete a recorded commitment.' }, { status: 400 })

  if (row.transfer_id) {
    const { error } = await admin
      .from('commitment_events' as any)
      .delete()
      .eq('fund_id', gate.fundId)
      .eq('transfer_id', row.transfer_id)
    if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  } else {
    const { error } = await admin
      .from('commitment_events' as any)
      .delete()
      .eq('id', id)
      .eq('fund_id', gate.fundId)
      .eq('vehicle_id', vehicleId)
    if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  }
  // The deleted event, whole, is the record that it ever existed.
  await recordAudit(admin, {
    fundId: gate.fundId, vehicleId, actorId: user.id, action: 'commitment.delete', subjectType: 'commitment_event', subjectId: id, reason,
    details: { deleted: { effectiveDate: row.effective_date, amount: Number(row.amount), memo: row.memo ?? null, kind: row.kind, lpEntityId: row.lp_entity_id, transferId: row.transfer_id ?? null } },
  })
  return NextResponse.json({ ok: true })
}
