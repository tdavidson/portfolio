// The caller and vehicle for a statement review route. The middleware has already checked the
// caller's grant for the route and method (lib/access/route-domains.ts); this resolves who they are,
// their fund and the vehicle they named, with the read or write check the route's level implies.

import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { assertReadAccess, assertWriteAccess } from '@/lib/api-helpers'
import { resolveGroupOr400 } from '@/lib/accounting/http-vehicle'
import { vehicleIdByName } from '@/lib/accounting/vehicle-id'

export async function reviewRouteContext(write: boolean, requestedGroup: unknown) {
  const supabase = await createClient()
  const admin = createAdminClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return { error: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }) }
  const gate = write ? await assertWriteAccess(admin, user.id) : await assertReadAccess(admin, user.id)
  if (gate instanceof NextResponse) return { error: gate }
  const group = await resolveGroupOr400(admin, gate, typeof requestedGroup === 'string' ? requestedGroup : null)
  if (group instanceof NextResponse) return { error: group }
  const id = await vehicleIdByName(admin, gate.fundId, group)
  if (!id) return { error: NextResponse.json({ error: 'Unknown vehicle' }, { status: 400 }) }
  return { admin, user, fundId: gate.fundId as string, vehicle: { id, name: group } }
}
