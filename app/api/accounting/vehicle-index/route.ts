import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { assertReadAccess } from '@/lib/api-helpers'
import { loadAccessContext, hasAccess } from '@/lib/access/effective'
import { listVehiclesWithId, listMancoVehicles } from '@/lib/accounting/load'
import { MANCO_KIND } from '@/lib/vehicle-kinds'
import { canSeeVehicle } from '@/lib/access/scope'

// GET — the fund's active vehicles as { name, id, kind }, for the fund switcher and the sidebar's
// entity-first links. Distinct from /api/accounting/vehicles (names only), which external API
// keys and MCP configs already depend on and must keep its string[] shape.
//
// Management companies join the list only for a caller who holds `management_company`, checked
// here — the same rule /api/accounting/firm applies, and applied the same way: by ASKING, on top
// of the shared list rather than inside it. `listVehiclesWithId` still excludes them
// unconditionally, which is what keeps every other surface in the app unable to resolve one by
// accident (tests/manco-vehicle-domain.test.ts pins that).
//
// They belong here now because a management company is an entity in the Entities section like any
// other: the switcher jumps between entities, and the sidebar reads `kind` from this list to know
// which pages an entity has — without it a manco would be offered a fund's capital accounts.
export async function GET() {
  const supabase = await createClient()
  const admin = createAdminClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  const gate = await assertReadAccess(admin, user.id)
  if (gate instanceof NextResponse) return gate

  const ctx = await loadAccessContext(admin, gate.fundId, user.id, gate.role)
  // Only the caller's entities — the switcher and sidebar never offer one they cannot open.
  const vehicles = (await listVehiclesWithId(admin, gate.fundId)).filter(v => canSeeVehicle(ctx, v.id))
  if (!hasAccess(ctx, 'management_company', 'read')) return NextResponse.json(vehicles)

  const mancos = (await listMancoVehicles(admin, gate.fundId)).filter(m => canSeeVehicle(ctx, m.id))
  return NextResponse.json([
    ...vehicles,
    ...mancos.map(m => ({ name: m.name, id: m.id, kind: MANCO_KIND })),
  ])
}
