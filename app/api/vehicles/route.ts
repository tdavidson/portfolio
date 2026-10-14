import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
// accounting domain (see lib/access/route-domains.ts). The middleware has already checked the
// caller's grant for this route + method; these resolve identity and keep the demo out of writes.
import { assertWriteAccess, assertReadAccess } from '@/lib/api-helpers'
import { retagPortfolioGroup } from '@/lib/vehicles'
import { mergeVehicles } from '@/lib/vehicles-merge'
import { outcomeResponse } from '@/lib/service-outcome'
import { dbError } from '@/lib/api-error'
import { ensureVehicleAccounts } from '@/lib/accounting/provision-accounts'
import { VEHICLE_KINDS } from '@/lib/vehicle-kinds'
import { isSafeLogoDataUri } from '@/lib/vehicle-letterhead'
import { loadAccessContext } from '@/lib/access/effective'
import { canSeeVehicle, entityIdentityChangeDenial } from '@/lib/access/scope'
import { safeLogo, fundLetterhead, loadFundEmail } from '@/lib/vehicle-letterhead'
import { EMPTY_PROFILE, PROFILE_COLUMNS, parseProfilePatch, profileFromRow } from '@/lib/vehicle-profile'

// Fund-wide investment-vehicle registry (fund_vehicles). Vehicles are used across
// LP snapshots, portfolio, compliance, and accounting — so management lives here,
// not under the optional Accounting section.

const KINDS: readonly string[] = VEHICLE_KINDS

// GET — all of the fund's vehicles (for the management UI). `?letterhead=<id>` returns that one
// vehicle's letterhead (logo, name, address, email) instead, with the fund's values it falls back
// to: logos are data URIs up to 200KB, too heavy to ride on every list.
export async function GET(req: NextRequest) {
  const supabase = await createClient()
  const admin = createAdminClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  // Listing vehicles reads. (Using the write helper here would newly refuse the read-only demo.)
  const gate = await assertReadAccess(admin, user.id)
  if (gate instanceof NextResponse) return gate

  const letterheadFor = req.nextUrl.searchParams.get('letterhead')
  if (letterheadFor) {
    const access = await loadAccessContext(admin, gate.fundId, gate.userId, gate.role)
    if (!canSeeVehicle(access, letterheadFor)) return NextResponse.json({ error: 'Vehicle not found' }, { status: 404 })
    let res = await (admin as any)
      .from('fund_vehicles').select('logo_url, letterhead_name, letterhead_address, letterhead_email')
      .eq('id', letterheadFor).eq('fund_id', gate.fundId).maybeSingle()
    // letterhead_email not migrated yet (20261013160000_letterhead_email.sql): the rest still edits.
    const emailAvailable = !res.error
    if (res.error) {
      res = await (admin as any)
        .from('fund_vehicles').select('logo_url, letterhead_name, letterhead_address')
        .eq('id', letterheadFor).eq('fund_id', gate.fundId).maybeSingle()
    }
    const { data, error } = res
    // Columns not migrated yet (20261012120000_vehicle_letterhead.sql): no vehicle has a letterhead.
    if (error) return NextResponse.json({ logo: null, name: null, address: null, email: null, available: false })
    if (!data) return NextResponse.json({ error: 'Vehicle not found' }, { status: 404 })
    // The fund's letterhead, which each blank part falls back to — shown as the placeholder.
    const [{ data: fundRow }, fundEmail] = await Promise.all([
      (admin as any).from('funds').select('name, address').eq('id', gate.fundId).maybeSingle(),
      loadFundEmail(admin, gate.fundId),
    ])
    const fund = fundLetterhead(fundRow)
    return NextResponse.json({
      logo: safeLogo((data as any).logo_url),
      name: (data as any).letterhead_name ?? null,
      address: (data as any).letterhead_address ?? null,
      email: (data as any).letterhead_email ?? null,
      fund: { name: fund.name || null, address: fund.address, email: fundEmail },
      available: true,
      emailAvailable,
    })
  }

  // The entity's reporting profile (lib/vehicle-profile.ts), for the Edit vehicle modal.
  const profileFor = req.nextUrl.searchParams.get('profile')
  if (profileFor) {
    const access = await loadAccessContext(admin, gate.fundId, gate.userId, gate.role)
    if (!canSeeVehicle(access, profileFor)) return NextResponse.json({ error: 'Vehicle not found' }, { status: 404 })
    const { data, error } = await (admin as any)
      .from('fund_vehicles').select(PROFILE_COLUMNS).eq('id', profileFor).eq('fund_id', gate.fundId).maybeSingle()
    // Columns not migrated yet (20261013165000_vehicle_reporting_profile.sql).
    if (error) return NextResponse.json({ ...EMPTY_PROFILE, available: false })
    if (!data) return NextResponse.json({ error: 'Vehicle not found' }, { status: 404 })
    return NextResponse.json({ ...profileFromRow(data), available: true })
  }

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

  // Creating an entity names rows into it — only an unscoped caller may (see entityIdentityChangeDenial).
  const createAccess = await loadAccessContext(admin, gate.fundId, gate.userId, gate.role)
  const createDenied = entityIdentityChangeDenial(createAccess, { name })
  if (createDenied) return NextResponse.json({ error: createDenied }, { status: 403 })

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
  // Every entity has a ledger from the moment it exists (plans/spec-ledger-one-writer.md §3) — the
  // chart its kind needs, seeded here rather than on some later "onboarding" step.
  // A failed seed must not undo the creation (a retry would 409); the chart GET seeds on first look.
  try {
    await ensureVehicleAccounts(admin as any, gate.fundId, (data as any).name)
  } catch (e) {
    console.error('Seeding the chart for a new entity failed; it will be seeded on first look:', e)
  }
  return NextResponse.json(data)
}

// PATCH — update a vehicle. { id, name?, kind?, active?, logo?, letterheadName?, letterheadAddress?, letterheadEmail? }
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
  // Merging is an identity change outright; a rename or alias change is checked once the current
  // row is loaded, so re-sending the unchanged name (the edit form does) is not mistaken for one.
  const mergeDenied = entityIdentityChangeDenial(access, { mergeIntoId: body.mergeIntoId })
  if (mergeDenied) return NextResponse.json({ error: mergeDenied }, { status: 403 })

  // Merge: collapse this vehicle into another (e.g. a backfilled "<X> SPV" duplicate of the
  // real "<X> SPV LP"). Distinct from a rename — the source row is deleted, not renamed, and
  // the target keeps its own name while absorbing the source's data + aliases. Handled first and
  // returns early; the normal field-update path below is for non-merge PATCHes only.
  if (body.mergeIntoId) {
    // Shared with the merge_vehicles tool (lib/vehicles-merge.ts).
    return outcomeResponse(await mergeVehicles(admin, { fundId: gate.fundId, userId: gate.userId, access }, body.id, body.mergeIntoId))
  }

  const { data: current } = await (admin as any)
    .from('fund_vehicles').select('id, name, aliases').eq('id', body.id).eq('fund_id', gate.fundId).maybeSingle()
  if (!current) return NextResponse.json({ error: 'Vehicle not found' }, { status: 404 })
  const sameAliases = (x: unknown, y: unknown) =>
    JSON.stringify([...((x as string[]) ?? [])].map(String).sort()) === JSON.stringify([...((y as string[]) ?? [])].map(String).sort())
  const identityDenied = entityIdentityChangeDenial(access, {
    name: typeof body.name === 'string' && body.name.trim() && body.name.trim() !== (current as any).name ? body.name : undefined,
    aliases: Array.isArray(body.aliases) && !sameAliases(body.aliases, (current as any).aliases) ? body.aliases : undefined,
  })
  if (identityDenied) return NextResponse.json({ error: identityDenied }, { status: 403 })

  const update: Record<string, unknown> = { updated_at: new Date().toISOString() }
  // The vehicle's own letterhead for its LP documents (lib/vehicle-letterhead.ts); null or blank
  // clears a part, and the documents fall back to the fund's. The logo has the same rules as the
  // fund logo in api/settings.
  if (body.logo !== undefined) {
    if (body.logo !== null) {
      if (!isSafeLogoDataUri(body.logo)) {
        return NextResponse.json({ error: 'Logo must be a base64 data:image/ URL' }, { status: 400 })
      }
      if (body.logo.length > 200 * 1024) {
        return NextResponse.json({ error: 'Logo must be under 200KB' }, { status: 400 })
      }
    }
    update.logo_url = body.logo
  }
  if (body.letterheadName !== undefined) {
    const v = typeof body.letterheadName === 'string' ? body.letterheadName.trim() : ''
    if (v.length > 200) return NextResponse.json({ error: 'Letterhead name must be under 200 characters' }, { status: 400 })
    update.letterhead_name = v || null
  }
  if (body.letterheadAddress !== undefined) {
    const v = typeof body.letterheadAddress === 'string' ? body.letterheadAddress.trim() : ''
    if (v.length > 1000) return NextResponse.json({ error: 'Letterhead address must be under 1,000 characters' }, { status: 400 })
    update.letterhead_address = v || null
  }
  if (body.letterheadEmail !== undefined) {
    const v = typeof body.letterheadEmail === 'string' ? body.letterheadEmail.trim() : ''
    if (v && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v)) return NextResponse.json({ error: 'Letterhead email is not a valid address' }, { status: 400 })
    if (v.length > 320) return NextResponse.json({ error: 'Letterhead email is too long' }, { status: 400 })
    update.letterhead_email = v || null
  }
  if (body.kind !== undefined) {
    if (!KINDS.includes(body.kind)) return NextResponse.json({ error: 'invalid kind' }, { status: 400 })
    update.kind = body.kind
  }
  if (body.active !== undefined) update.active = !!body.active
  // The reporting profile: strategy, administrator, LP reporting days (lib/vehicle-profile.ts).
  if (body.profile !== undefined) {
    if (!body.profile || typeof body.profile !== 'object') return NextResponse.json({ error: 'profile must be an object' }, { status: 400 })
    const parsed = parseProfilePatch(body.profile)
    if ('error' in parsed) return NextResponse.json({ error: parsed.error }, { status: 400 })
    Object.assign(update, parsed.update)
  }

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
  // A name or alias denotes one entity (fund_vehicles_names_unique).
  if ((error as any)?.code === '23505') return NextResponse.json({ error: 'Another entity already uses that name or alias' }, { status: 409 })
  if (error) return dbError(error, 'vehicles')
  return NextResponse.json(data)
}
