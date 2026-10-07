import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { assertReadAccess, assertWriteAccess } from '@/lib/api-helpers'
import { resolveGroupOr400 } from '@/lib/accounting/http-vehicle'
import { loadEntityNames } from '@/lib/accounting/load'
import { vehicleIdByName } from '@/lib/accounting/vehicle-id'
import { loadAccessContext } from '@/lib/access/effective'
import { canSeeVehicle } from '@/lib/access/scope'

// CRUD for `vehicle_gp_links` — the many-to-many "gp_vehicle_id is a GP of served_vehicle_id, as
// partner lp_entity_id" table. The `?group=` names the SERVED vehicle throughout.

// GET ?group= — this vehicle's current GP links, the entities eligible to be added, and this
// vehicle's own LP partners (to pick "as which partner").
export async function GET(req: NextRequest) {
  const supabase = await createClient()
  const admin = createAdminClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  const gate = await assertReadAccess(admin, user.id)
  if (gate instanceof NextResponse) return gate
  const group = await resolveGroupOr400(admin, gate, req.nextUrl.searchParams.get('group'))
  if (group instanceof NextResponse) return group

  const servedVehicleId = await vehicleIdByName(admin, gate.fundId, group)
  if (!servedVehicleId) return NextResponse.json({ error: 'Vehicle not found' }, { status: 404 })

  const [{ data: linkRows, error: linkError }, { data: candidateRows, error: candError }, partnerNames] = await Promise.all([
    admin
      .from('vehicle_gp_links' as any)
      .select('id, gp_vehicle_id, lp_entity_id')
      .eq('fund_id', gate.fundId)
      .eq('served_vehicle_id', servedVehicleId),
    admin
      .from('fund_vehicles' as any)
      .select('id, name')
      .eq('fund_id', gate.fundId)
      .in('kind', ['associate', 'gp']),
    loadEntityNames(admin, gate.fundId, group),
  ])
  if (linkError) return NextResponse.json({ error: linkError.message }, { status: 500 })
  if (candError) return NextResponse.json({ error: candError.message }, { status: 500 })

  const candidates = ((candidateRows as any[]) ?? []).map(v => ({ id: v.id as string, name: v.name as string }))
  const nameByVehicleId = new Map(candidates.map(c => [c.id, c.name]))

  // A linked GP entity may not be in `candidates` (kind changed since linking, etc.) — resolve
  // any not already covered so the display name never falls back to a bare id.
  const rows = (linkRows as any[]) ?? []
  const missingGpIds = Array.from(new Set(rows.map(r => r.gp_vehicle_id as string).filter(id => !nameByVehicleId.has(id))))
  if (missingGpIds.length > 0) {
    const { data: extra } = await admin.from('fund_vehicles' as any).select('id, name').in('id', missingGpIds)
    for (const v of ((extra as any[]) ?? [])) nameByVehicleId.set(v.id, v.name)
  }

  const links = rows.map(r => ({
    id: r.id as string,
    gpVehicleId: r.gp_vehicle_id as string,
    gpName: nameByVehicleId.get(r.gp_vehicle_id) ?? r.gp_vehicle_id,
    lpEntityId: (r.lp_entity_id as string | null) ?? null,
    lpName: r.lp_entity_id ? (partnerNames.get(r.lp_entity_id) ?? r.lp_entity_id) : null,
  }))

  return NextResponse.json({
    links,
    candidates,
    partners: Array.from(partnerNames.entries()).map(([id, name]) => ({ id, name })),
  })
}

// POST { group, gpVehicleId, lpEntityId? } — add (or update the partner on) a GP link.
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

  const gpVehicleId = body?.gpVehicleId
  if (!gpVehicleId) return NextResponse.json({ error: 'gpVehicleId is required' }, { status: 400 })

  const servedVehicleId = await vehicleIdByName(admin, gate.fundId, group)
  if (!servedVehicleId) return NextResponse.json({ error: 'Vehicle not found' }, { status: 404 })

  const { data: gpVehicle, error: gpError } = await admin
    .from('fund_vehicles' as any)
    .select('id')
    .eq('fund_id', gate.fundId)
    .eq('id', gpVehicleId)
    .maybeSingle()
  if (gpError) return NextResponse.json({ error: gpError.message }, { status: 500 })
  if (!gpVehicle) return NextResponse.json({ error: 'gpVehicleId is not a vehicle in this fund' }, { status: 400 })

  // The "as which partner" id, if given, must belong to THIS fund — lp_entities is a cross-fund
  // table, so an unvalidated id could plant a foreign entity on the link.
  const lpEntityId = body?.lpEntityId ?? null
  if (lpEntityId) {
    const { data: ent } = await admin.from('lp_entities' as any).select('id').eq('fund_id', gate.fundId).eq('id', lpEntityId).maybeSingle()
    if (!ent) return NextResponse.json({ error: 'That partner is not in this fund.' }, { status: 400 })
  }

  const { error } = await admin
    .from('vehicle_gp_links' as any)
    .upsert(
      {
        fund_id: gate.fundId,
        gp_vehicle_id: gpVehicleId,
        served_vehicle_id: servedVehicleId,
        lp_entity_id: lpEntityId,
      },
      { onConflict: 'gp_vehicle_id,served_vehicle_id' }
    )
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ ok: true })
}

// DELETE { id } — remove a link.
export async function DELETE(req: NextRequest) {
  const supabase = await createClient()
  const admin = createAdminClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  const gate = await assertWriteAccess(admin, user.id)
  if (gate instanceof NextResponse) return gate

  const body = await req.json().catch(() => ({}))
  const id = body?.id
  if (!id) return NextResponse.json({ error: 'id is required' }, { status: 400 })

  // Only a link on an entity the caller can see.
  const { data: link } = await admin.from('vehicle_gp_links' as any).select('served_vehicle_id')
    .eq('id', id).eq('fund_id', gate.fundId).maybeSingle()
  const access = await loadAccessContext(admin, gate.fundId, gate.userId, gate.role)
  if (!link || !canSeeVehicle(access, (link as any).served_vehicle_id)) return NextResponse.json({ error: 'Not found' }, { status: 404 })

  const { error } = await admin
    .from('vehicle_gp_links' as any)
    .delete()
    .eq('id', id)
    .eq('fund_id', gate.fundId)
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ ok: true })
}
