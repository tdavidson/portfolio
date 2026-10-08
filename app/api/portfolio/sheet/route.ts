import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
// portfolio domain (lib/access/route-domains.ts). The middleware has already checked the caller's
// grant; this resolves identity and WHICH entities the sheet may cover.
import { assertReadAccess } from '@/lib/api-helpers'
import { resolveGroupOr400 } from '@/lib/accounting/http-vehicle'
import { visibleVehicleNames } from '@/lib/accounting/vehicle-visibility'
import { listVehicles } from '@/lib/accounting/load'
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
  if (requested) {
    const group = await resolveGroupOr400(admin, gate, requested)
    if (group instanceof NextResponse) return group
    vehicles = [group]
  } else {
    const visible = await visibleVehicleNames(admin, gate)
    const funds = await listVehicles(admin, gate.fundId)
    vehicles = visible === null ? funds : funds.filter(v => visible.includes(v))
    const exclude = req.nextUrl.searchParams.getAll('exclude').filter(Boolean)
    if (exclude.length > 0) vehicles = vehicles.filter(v => !exclude.includes(v))
  }

  return NextResponse.json({ vehicles, sheet: await loadPortfolioSheet(admin, gate.fundId, vehicles) })
}
