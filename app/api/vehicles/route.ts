import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
// accounting domain (see lib/access/route-domains.ts). The middleware has already checked the
// caller's grant for this route + method; these resolve identity and keep the demo out of writes.
import { assertWriteAccess, assertReadAccess } from '@/lib/api-helpers'
import { retagPortfolioGroup } from '@/lib/vehicles'
import { dbError } from '@/lib/api-error'
import { VEHICLE_KINDS } from '@/lib/vehicle-kinds'
import { loadAccessContext } from '@/lib/access/effective'
import { canSeeVehicle } from '@/lib/access/scope'

// Fund-wide investment-vehicle registry (fund_vehicles). Vehicles are used across
// LP snapshots, portfolio, compliance, and accounting — so management lives here,
// not under the optional Accounting section.

const KINDS: readonly string[] = VEHICLE_KINDS

// GET — all of the fund's vehicles (for the management UI).
export async function GET() {
  const supabase = await createClient()
  const admin = createAdminClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  // Listing vehicles reads. (Using the write helper here would newly refuse the read-only demo.)
  const gate = await assertReadAccess(admin, user.id)
  if (gate instanceof NextResponse) return gate

  // serves_vehicle_id / lp_entity_id may not exist until their migrations are pushed — fall back.
  let rows = await (admin as any)
    .from('fund_vehicles')
    .select('id, name, kind, aliases, active, serves_vehicle_id, lp_entity_id, vintage_year')
    .eq('fund_id', gate.fundId)
    .order('active', { ascending: false })
    .order('name')
  if (rows.error) {
    rows = await (admin as any)
      .from('fund_vehicles')
      .select('id, name, kind, aliases, active')
      .eq('fund_id', gate.fundId)
      .order('active', { ascending: false })
      .order('name')
  }
  if (rows.error) return dbError(rows.error, 'vehicles')
  // Only the caller's entities.
  const access = await loadAccessContext(admin, gate.fundId, gate.userId, gate.role)
  return NextResponse.json(((rows.data ?? []) as { id: string }[]).filter(v => canSeeVehicle(access, v.id)))
}

// POST — create a vehicle. { name, kind? }
export async function POST(req: NextRequest) {
  const supabase = await createClient()
  const admin = createAdminClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  const gate = await assertWriteAccess(admin, user.id)
  if (gate instanceof NextResponse) return gate

  const body = await req.json().catch(() => ({}))
  const name = typeof body.name === 'string' ? body.name.trim() : ''
  const kind = KINDS.includes(body.kind) ? body.kind : 'fund'
  if (!name) return NextResponse.json({ error: 'name is required' }, { status: 400 })

  const { data, error } = await (admin as any)
    .from('fund_vehicles')
    .insert({ fund_id: gate.fundId, name, kind, aliases: [], active: true })
    .select('id, name, kind, aliases, active')
    .single()
  if (error) {
    if ((error as any).code === '23505') return NextResponse.json({ error: 'A vehicle with that name already exists' }, { status: 409 })
    return dbError(error, 'vehicles')
  }
  // A member who creates an entity can see it; admins see every entity anyway.
  if (gate.role !== 'admin') {
    await (admin as any).from('fund_member_vehicles')
      .upsert({ fund_id: gate.fundId, user_id: gate.userId, vehicle_id: data.id, granted_by: gate.userId },
        { onConflict: 'fund_id,user_id,vehicle_id', ignoreDuplicates: true })
  }
  return NextResponse.json(data)
}

// PATCH — update a vehicle. { id, name?, kind?, active? }
// Renaming cascades the string across every vehicle-scoped table (pre-Phase-2);
// the old name is kept as an alias so stray legacy rows still map back.
export async function PATCH(req: NextRequest) {
  const supabase = await createClient()
  const admin = createAdminClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  const gate = await assertWriteAccess(admin, user.id)
  if (gate instanceof NextResponse) return gate

  const body = await req.json().catch(() => ({}))
  if (!body.id) return NextResponse.json({ error: 'id is required' }, { status: 400 })
  // Renaming, merging or deactivating an entity needs it (and a merge target) to be the caller's.
  const access = await loadAccessContext(admin, gate.fundId, gate.userId, gate.role)
  if (!canSeeVehicle(access, String(body.id)) || (body.mergeIntoId && !canSeeVehicle(access, String(body.mergeIntoId)))) {
    return NextResponse.json({ error: 'Vehicle not found' }, { status: 404 })
  }

  // Merge: collapse this vehicle into another (e.g. a backfilled "<X> SPV" duplicate of the
  // real "<X> SPV LP"). Distinct from a rename — the source row is deleted, not renamed, and
  // the target keeps its own name while absorbing the source's data + aliases. Handled first and
  // returns early; the normal field-update path below is for non-merge PATCHes only.
  if (body.mergeIntoId) {
    const fromId = body.id
    const intoId = body.mergeIntoId
    if (fromId === intoId) return NextResponse.json({ error: 'Cannot merge a vehicle into itself' }, { status: 400 })

    const { data: fromRow } = await (admin as any)
      .from('fund_vehicles').select('id, name, aliases').eq('id', fromId).eq('fund_id', gate.fundId).maybeSingle()
    if (!fromRow) return NextResponse.json({ error: 'Vehicle not found' }, { status: 404 })
    const { data: intoRow } = await (admin as any)
      .from('fund_vehicles').select('id, name, aliases').eq('id', intoId).eq('fund_id', gate.fundId).maybeSingle()
    if (!intoRow) return NextResponse.json({ error: 'Target vehicle not found' }, { status: 404 })

    // Rewrite every portfolio_group-keyed row from the source's name to the target's name.
    await retagPortfolioGroup(admin, gate.fundId, (fromRow as any).name, (intoRow as any).name)

    // The target absorbs the source's name and aliases as its own aliases, so any legacy string
    // (including the source's old name) still resolves to the target going forward.
    const mergedAliases = Array.from(new Set([
      ...(((intoRow as any).aliases ?? []) as string[]),
      (fromRow as any).name,
      ...(((fromRow as any).aliases ?? []) as string[]),
    ].filter(Boolean)))

    const { data: updatedInto, error: updateErr } = await (admin as any)
      .from('fund_vehicles')
      .update({ aliases: mergedAliases, updated_at: new Date().toISOString() })
      .eq('id', intoId).eq('fund_id', gate.fundId)
      .select('id, name, kind, aliases, active')
      .single()
    if (updateErr) return dbError(updateErr, 'vehicles')

    const { error: deleteErr } = await (admin as any)
      .from('fund_vehicles').delete().eq('id', fromId).eq('fund_id', gate.fundId)
    if (deleteErr) return dbError(deleteErr, 'vehicles')

    return NextResponse.json(updatedInto)
  }

  const { data: current } = await (admin as any)
    .from('fund_vehicles').select('id, name, aliases').eq('id', body.id).eq('fund_id', gate.fundId).maybeSingle()
  if (!current) return NextResponse.json({ error: 'Vehicle not found' }, { status: 404 })

  const update: Record<string, unknown> = { updated_at: new Date().toISOString() }
  if (body.kind !== undefined) {
    if (!KINDS.includes(body.kind)) return NextResponse.json({ error: 'invalid kind' }, { status: 400 })
    update.kind = body.kind
  }
  if (body.active !== undefined) update.active = !!body.active

  // Vintage year. A FACT about the vehicle, not a parameter of a calculation — it used to
  // live on fund_group_config next to carry_rate and gp_commit_pct, both of which are now
  // obsolete (real carry terms, real accrued carry). It is not, so it moved here.
  if (body.vintageYear !== undefined) {
    const raw = body.vintageYear
    if (raw === null || raw === '') {
      update.vintage_year = null
    } else {
      const y = Number(raw)
      if (!Number.isInteger(y) || y < 1900 || y > 2200) {
        return NextResponse.json({ error: 'Vintage year must be a year like 2021.' }, { status: 400 })
      }
      update.vintage_year = y
    }
  }
  // Link a GP/associate entity to the fund vehicle it serves (or clear it). Verify the target
  // vehicle is in THIS fund — same as lpEntityId below. A cross-fund id is inert downstream
  // (loadGpLinks filters served vehicles by fund), but reject it here rather than store it.
  if (body.servesVehicleId !== undefined) {
    const sid = body.servesVehicleId || null
    if (sid) {
      const { data: sv } = await (admin as any)
        .from('fund_vehicles').select('id').eq('id', sid).eq('fund_id', gate.fundId).maybeSingle()
      if (!sv) return NextResponse.json({ error: 'That served vehicle is not in this fund.' }, { status: 400 })
    }
    update.serves_vehicle_id = sid
  }

  // AND as WHOM it holds that position. The associates look-through needs both: which fund the
  // associate invests in, and which lp_entity on that fund's books represents it. Together
  // these replace the old free-text name matching, which broke silently on any rename.
  if (body.lpEntityId !== undefined) {
    const id = body.lpEntityId || null
    if (id) {
      const { data: ent } = await (admin as any)
        .from('lp_entities').select('id').eq('id', id).eq('fund_id', gate.fundId).maybeSingle()
      if (!ent) return NextResponse.json({ error: 'That partner is not in this fund.' }, { status: 400 })
    }
    update.lp_entity_id = id
  }

  // Explicit alias list (edited on the vehicle modal). Trimmed + de-duped; a rename below still
  // appends the old name on top of whatever is set here.
  if (Array.isArray(body.aliases)) {
    update.aliases = Array.from(new Set((body.aliases as any[]).map(a => String(a).trim()).filter(Boolean)))
  }

  if (typeof body.name === 'string' && body.name.trim() && body.name.trim() !== (current as any).name) {
    const newName = body.name.trim()
    const { data: clash } = await (admin as any)
      .from('fund_vehicles').select('id').eq('fund_id', gate.fundId).eq('name', newName).maybeSingle()
    if (clash) return NextResponse.json({ error: 'A vehicle with that name already exists' }, { status: 409 })

    // Rewrite the vehicle string across all the data, then keep the old name as an alias.
    await retagPortfolioGroup(admin, gate.fundId, (current as any).name, newName)
    update.name = newName
    update.aliases = Array.from(new Set([...((update.aliases ?? (current as any).aliases ?? []) as string[]), (current as any).name]))
  }

  const { data, error } = await (admin as any)
    .from('fund_vehicles')
    .update(update)
    .eq('id', body.id).eq('fund_id', gate.fundId)
    .select('id, name, kind, aliases, active')
    .single()
  if (error) return dbError(error, 'vehicles')
  return NextResponse.json(data)
}
