import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
// portfolio domain (lib/access/route-domains.ts). The middleware has already checked the caller's
// grant; this resolves identity and WHICH entities the sheet may cover.
import { assertReadAccess } from '@/lib/api-helpers'
import { resolveGroupOr400 } from '@/lib/accounting/http-vehicle'
import { visibleVehicleNames } from '@/lib/accounting/vehicle-visibility'
import { listVehicles } from '@/lib/accounting/load'
import { vehicleIdByName } from '@/lib/accounting/vehicle-id'
import { loadPortfolioSheet } from '@/lib/portfolio/sheet-load'

// GET ?group=<entity> — that entity's portfolio sheet (it must be one of the caller's).
// GET (no group)      — the caller's aggregate: every entity they can see, never one they cannot.
//   &exclude=<a>&exclude=<b> — minus these (the dashboard's entity picker). It only ever narrows.
export async function GET(req: NextRequest) {
  const supabase = await createClient()
  const admin = createAdminClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  const gate = await assertReadAccess(admin, user.id)
  if (gate instanceof NextResponse) return gate

  const requested = req.nextUrl.searchParams.get('group')
  let vehicles: string[]
  // One entity's sheet links each holding to that entity's view of it (holdingHref ?entity=), so a
  // fund holding two entities hold opens on this entity's register, not the first one's.
  let vehicleId: string | null = null
  if (requested) {
    const group = await resolveGroupOr400(admin, gate, requested)
    if (group instanceof NextResponse) return group
    vehicles = [group]
    // Only the links depend on it: a failed read opens the holdings on no entity, not a failed sheet.
    vehicleId = await vehicleIdByName(admin, gate.fundId, group).catch(() => null)
  } else {
    const visible = await visibleVehicleNames(admin, gate)
    const funds = await listVehicles(admin, gate.fundId)
    vehicles = visible === null ? funds : funds.filter(v => visible.includes(v))
    const exclude = req.nextUrl.searchParams.getAll('exclude').filter(Boolean)
    if (exclude.length > 0) vehicles = vehicles.filter(v => !exclude.includes(v))
  }

  return NextResponse.json({ vehicles, vehicleId, sheet: await loadPortfolioSheet(admin, gate.fundId, vehicles) })
}
