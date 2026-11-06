import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { assertWriteAccess } from '@/lib/api-helpers'
import { loadEntityScopeForUser } from '@/lib/access/entity-scope'
import { outcomeResponse } from '@/lib/service-outcome'
import { loadProfile, saveProfile } from '@/lib/lp-letters/profile-store'

/** ?vehicle=<entity name> for an entity's letter profile; none for the firm-wide one. */
export async function GET(req: NextRequest) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  const admin = createAdminClient()
  const { data: membership } = await admin.from('fund_members').select('fund_id').eq('user_id', user.id).maybeSingle()
  if (!membership) return NextResponse.json({ error: 'No fund found' }, { status: 403 })
  const vehicle = req.nextUrl.searchParams.get('vehicle')
  const scope = await loadEntityScopeForUser(admin, user.id)
  if (vehicle && scope?.vehicleNames && !scope.vehicleNames.includes(vehicle)) return NextResponse.json({ error: 'Not found' }, { status: 404 })
  return NextResponse.json(await loadProfile(admin, membership.fund_id as string, vehicle || null))
}

/** Replace an entity's letter profile (?vehicle=) or the firm-wide one. */
export async function PUT(req: NextRequest) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  const admin = createAdminClient()
  const writeCheck = await assertWriteAccess(admin, user.id)
  if (writeCheck instanceof NextResponse) return writeCheck
  const scope = await loadEntityScopeForUser(admin, user.id)
  const body = await req.json().catch(() => ({}))
  const vehicle = req.nextUrl.searchParams.get('vehicle')
  return outcomeResponse(await saveProfile(admin, { fundId: writeCheck.fundId, userId: user.id, visible: scope ? scope.vehicleNames : null }, vehicle || null, body?.profile ?? body, {
    seededFrom: typeof body?.seeded_from === 'string' ? body.seeded_from : null,
  }))
}
