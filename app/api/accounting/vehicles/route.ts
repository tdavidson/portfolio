import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { assertReadAccess } from '@/lib/api-helpers'
import { listVehicles } from '@/lib/accounting/load'
import { visibleVehicleNames } from '@/lib/accounting/vehicle-visibility'

// GET — the fund's active vehicle names, for the Accounting picker. Vehicle
// creation/management lives at the fund level (/api/vehicles), since vehicles
// aren't accounting-specific.
export async function GET() {
  const supabase = await createClient()
  const admin = createAdminClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  const gate = await assertReadAccess(admin, user.id)
  if (gate instanceof NextResponse) return gate

  // Only the caller's entities, keeping the string[] shape API keys and MCP configs rely on.
  const visible = await visibleVehicleNames(admin, gate)
  const all = await listVehicles(admin, gate.fundId)
  return NextResponse.json(visible === null ? all : all.filter(v => visible.includes(v)))
}
