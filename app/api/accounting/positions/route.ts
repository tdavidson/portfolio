import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { dbError } from '@/lib/api-error'
// lp_capital domain, gated on the lp_tracking switch (lib/access/route-domains.ts). The middleware
// has already checked the caller's grant for this route + method.
import { assertWriteAccess, assertReadAccess } from '@/lib/api-helpers'
import { resolveGroupOr400 } from '@/lib/accounting/http-vehicle'
import { vehicleIdByName } from '@/lib/accounting/vehicle-id'
import { loadPositions } from '@/lib/accounting/lp-positions'
import { deleteLpPositions } from '@/lib/accounting/positions-delete'
import { outcomeResponse } from '@/lib/service-outcome'

// Dated LP positions for a vehicle — the capital-tracking store.
//
//   GET    ?group=…                       → { dates, positions }  (all dated positions + LP names)
//   PUT    { group, asOfDate, lpEntityId, commitment?, calledCapital?, distributions?, nav? }
//                                          → upsert one LP's position on a date (manual edit)
//   DELETE ?group=…&asOfDate=…            → remove an entire dated set (a whole as-of column)
//
// This is how a tracking vehicle is edited by hand, alongside the AI paste at ./import.

const ISO = /^\d{4}-\d{2}-\d{2}$/

export async function GET(req: NextRequest) {
  const supabase = await createClient()
  const admin = createAdminClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  const gate = await assertReadAccess(admin, user.id)
  if (gate instanceof NextResponse) return gate
  const group = await resolveGroupOr400(admin, gate, req.nextUrl.searchParams.get('group'))
  if (group instanceof NextResponse) return group

  const positions = await loadPositions(admin, gate.fundId, group)
  const dates = Array.from(new Set(positions.map(p => p.asOfDate))).sort().reverse()

  // Names for display.
  const { data: ents } = await (admin as any).from('lp_entities').select('id, entity_name').eq('fund_id', gate.fundId)
  const nameById = new Map(((ents as any[]) ?? []).map(e => [e.id, e.entity_name]))

  return NextResponse.json({
    vehicle: group,
    dates,
    positions: positions.map(p => ({ ...p, name: nameById.get(p.lpEntityId) ?? p.lpEntityId })),
  })
}

export async function PUT(req: NextRequest) {
  const supabase = await createClient()
  const admin = createAdminClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  const gate = await assertWriteAccess(admin, user.id)
  if (gate instanceof NextResponse) return gate

  const body = await req.json().catch(() => ({}))
  const group = await resolveGroupOr400(admin, gate, body?.group)
  if (group instanceof NextResponse) return group
  const asOfDate = String(body?.asOfDate ?? '')
  if (!ISO.test(asOfDate)) return NextResponse.json({ error: 'asOfDate (YYYY-MM-DD) required' }, { status: 400 })
  const lpEntityId = String(body?.lpEntityId ?? '')
  if (!lpEntityId) return NextResponse.json({ error: 'lpEntityId required' }, { status: 400 })

  const vehicleId = await vehicleIdByName(admin, gate.fundId, group)
  if (!vehicleId) return NextResponse.json({ error: 'Unknown vehicle' }, { status: 400 })

  const num = (v: unknown) => (v === '' || v === null || v === undefined ? null : Number(v))
  const row = {
    fund_id: gate.fundId,
    vehicle_id: vehicleId,
    lp_entity_id: lpEntityId,
    as_of_date: asOfDate,
    commitment: num(body?.commitment),
    called_capital: num(body?.calledCapital),
    distributions: num(body?.distributions),
    nav: num(body?.nav),
    irr: num(body?.irr),
    source: 'manual',
    imported_by: user.id,
    imported_at: new Date().toISOString(),
  }

  const { error } = await (admin as any)
    .from('lp_positions')
    .upsert(row, { onConflict: 'fund_id,vehicle_id,lp_entity_id,as_of_date' })
  if (error) return dbError(error, 'accounting-positions')
  return NextResponse.json({ ok: true })
}

export async function DELETE(req: NextRequest) {
  const supabase = await createClient()
  const admin = createAdminClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  const gate = await assertWriteAccess(admin, user.id)
  if (gate instanceof NextResponse) return gate
  const group = await resolveGroupOr400(admin, gate, req.nextUrl.searchParams.get('group'))
  if (group instanceof NextResponse) return group
  // Shared with the delete_lp_positions tool.
  return outcomeResponse(await deleteLpPositions(admin, gate.fundId, group, req.nextUrl.searchParams.get('asOfDate') ?? ''))
}
