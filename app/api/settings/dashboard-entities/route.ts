import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { assertAdminAccess } from '@/lib/api-helpers'
import { loadAccessContext } from '@/lib/access/effective'
import { parseIdList } from '@/lib/dashboard/entity-selection'
import { loadActiveEntityOptions, loadFundDefaultExcluded } from '@/lib/dashboard/entity-selection-load'
import { expireTag } from '@/lib/cache/tags'
import { dbError } from '@/lib/api-error'

// The fund-wide default for the dashboard's entity picker — what everyone starts from until they
// save a selection of their own. Admin domain, and admins only in the handler: admins see every
// entity, so the options here are the fund's entities holding an active position. Stored as
// EXCLUDED ids (fund_settings.dashboard_excluded_vehicle_ids) so a new entity shows by default.

// GET — { options, excluded }
export async function GET() {
  const supabase = await createClient()
  const admin = createAdminClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  const gate = await assertAdminAccess(admin, user.id)
  if (gate instanceof NextResponse) return gate

  const access = await loadAccessContext(admin, gate.fundId, gate.userId, gate.role)
  const [options, excluded] = await Promise.all([
    loadActiveEntityOptions(admin, access),
    loadFundDefaultExcluded(admin, gate.fundId),
  ])
  return NextResponse.json({ options, excluded })
}

// PUT { excluded: string[] } — set the default. Ids must be the fund's own entities.
export async function PUT(req: NextRequest) {
  const supabase = await createClient()
  const admin = createAdminClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  const gate = await assertAdminAccess(admin, user.id)
  if (gate instanceof NextResponse) return gate

  const body = await req.json().catch(() => null)
  const requested = parseIdList(body?.excluded)
  if (requested === null) return NextResponse.json({ error: 'excluded must be a list of entity ids' }, { status: 400 })

  const { data: vehicles } = await (admin as any).from('fund_vehicles').select('id').eq('fund_id', gate.fundId)
  const fundIds = new Set(((vehicles as any[]) ?? []).map(v => v.id as string))
  const excluded = requested.filter(id => fundIds.has(id))

  const { error } = await (admin as any).from('fund_settings')
    .update({ dashboard_excluded_vehicle_ids: excluded }).eq('fund_id', gate.fundId)
  if (error) return dbError(error, 'settings-dashboard-entities')
  expireTag('fund-settings')
  return NextResponse.json({ ok: true, excluded })
}
