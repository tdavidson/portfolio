import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { assertReadAccess } from '@/lib/api-helpers'
import { hasAccess, loadAccessContext } from '@/lib/access/effective'
import { isManagementCompany } from '@/lib/vehicle-kinds'
import { canSeeVehicle } from '@/lib/access/scope'

// GET — the caller's own entities (funds, SPVs; management companies only with that grant), for
// pickers outside accounting: the portfolio sheet's switcher, a deal's owning entity. Membership is
// the whole gate (route-domains: level 'any') because the answer is only ever the caller's own
// entities — the names they are already granted, nothing about anyone else's.
export async function GET(req: Request) {
  const supabase = await createClient()
  const admin = createAdminClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  const gate = await assertReadAccess(admin, user.id)
  if (gate instanceof NextResponse) return gate

  const access = await loadAccessContext(admin, gate.fundId, gate.userId, gate.role)
  const { data } = await (admin as any).from('fund_vehicles')
    .select('id, name, kind, active').eq('fund_id', gate.fundId).order('name')
  // A management company is listed only to a caller with that domain, like every other entity list.
  const mancos = hasAccess(access, 'management_company', 'read')
  const entities = ((data as any[]) ?? [])
    .filter(v => canSeeVehicle(access, v.id) && (mancos || !isManagementCompany(v.kind)))
  // ?scope=1 also says whether the caller is unscoped — whether "Unassigned" is a choice they can
  // make (an unassigned record is visible to unscoped users only).
  if (new URL(req.url).searchParams.get('scope') === '1') return NextResponse.json({ entities, all: access.vehicles.all })
  return NextResponse.json(entities)
}
