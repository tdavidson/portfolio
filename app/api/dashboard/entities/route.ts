import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { assertReadAccess } from '@/lib/api-helpers'
import { loadEntityScope } from '@/lib/access/entity-scope'
import { canSeeVehicle } from '@/lib/access/scope'
import { parseIdList } from '@/lib/dashboard/entity-selection'
import { loadFundDefaultExcluded } from '@/lib/dashboard/entity-selection-load'
import { dbError } from '@/lib/api-error'

// The caller's OWN dashboard entity selection (portfolio domain, read level — saving how you look
// at the portfolio changes nothing anyone else sees). Stored as EXCLUDED entity ids so an entity
// added later shows by default. The row is keyed on the caller's user id from the session; the
// body never names a user.

// PUT { excluded: string[] } — save the selection.
export async function PUT(req: NextRequest) {
  const supabase = await createClient()
  const admin = createAdminClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  const gate = await assertReadAccess(admin, user.id)
  if (gate instanceof NextResponse) return gate

  const body = await req.json().catch(() => null)
  const requested = parseIdList(body?.excluded)
  if (requested === null) return NextResponse.json({ error: 'excluded must be a list of entity ids' }, { status: 400 })

  // Only the caller's own entities in their own fund: an id they cannot see is dropped, not stored.
  const scope = await loadEntityScope(admin, gate)
  const { data: vehicles } = await (admin as any).from('fund_vehicles').select('id').eq('fund_id', gate.fundId)
  const fundIds = new Set(((vehicles as any[]) ?? []).map(v => v.id as string))
  const excluded = requested.filter(id => fundIds.has(id) && canSeeVehicle(scope.access, id))

  const { error } = await (admin as any).from('dashboard_preferences').upsert(
    { user_id: user.id, fund_id: gate.fundId, excluded_vehicle_ids: excluded, updated_at: new Date().toISOString() },
    { onConflict: 'user_id' },
  )
  if (error) return dbError(error, 'dashboard-entities')
  return NextResponse.json({ ok: true, excluded })
}

// DELETE — forget the saved selection; the fund default (or all entities) applies again. Returns
// that default so the page can apply it without a reload.
export async function DELETE() {
  const supabase = await createClient()
  const admin = createAdminClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  const gate = await assertReadAccess(admin, user.id)
  if (gate instanceof NextResponse) return gate

  const { error } = await (admin as any).from('dashboard_preferences').delete().eq('user_id', user.id)
  if (error) return dbError(error, 'dashboard-entities')
  return NextResponse.json({ ok: true, fundDefault: await loadFundDefaultExcluded(admin, gate.fundId) })
}
