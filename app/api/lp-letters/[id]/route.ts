import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { assertWriteAccess } from '@/lib/api-helpers'
import { dbError } from '@/lib/api-error'
import { loadEntityScopeForUser } from '@/lib/access/entity-scope'
import { outcomeResponse } from '@/lib/service-outcome'
import { getLetter, updateLetter } from '@/lib/lp-letters/service'

export async function GET(_req: NextRequest, props: { params: Promise<{ id: string }> }) {
  const params = await props.params;
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const admin = createAdminClient()
  const { data: membership } = await admin
    .from('fund_members')
    .select('fund_id')
    .eq('user_id', user.id)
    .maybeSingle()

  if (!membership) return NextResponse.json({ error: 'No fund' }, { status: 403 })

  // A letter is one entity's: another entity's reads as not found, as the list leaves it out.
  const scope = await loadEntityScopeForUser(admin, user.id)
  const found = await getLetter(admin, membership.fund_id, scope ? scope.vehicleNames : [], params.id)
  if (!found.ok) return outcomeResponse(found)
  if (!found.value) return NextResponse.json({ error: 'Not found' }, { status: 404 })
  return NextResponse.json(found.value)
}

export async function PATCH(req: NextRequest, props: { params: Promise<{ id: string }> }) {
  const params = await props.params;
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const admin = createAdminClient()
  const writeCheck = await assertWriteAccess(admin, user.id)
  if (writeCheck instanceof NextResponse) return writeCheck
  const { fundId } = writeCheck

  const body = await req.json()
  const scope = await loadEntityScopeForUser(admin, user.id)
  return outcomeResponse(await updateLetter(admin, { fundId, userId: user.id, visible: scope ? scope.vehicleNames : [] }, params.id, body ?? {}))
}

export async function DELETE(_req: NextRequest, props: { params: Promise<{ id: string }> }) {
  const params = await props.params;
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const admin = createAdminClient()
  const writeCheck = await assertWriteAccess(admin, user.id)
  if (writeCheck instanceof NextResponse) return writeCheck
  const { fundId } = writeCheck

  const { error } = await admin
    .from('lp_letters')
    .delete()
    .eq('id', params.id)
    .eq('fund_id', fundId)

  if (error) return dbError(error, 'lp-letters-id')
  return NextResponse.json({ ok: true })
}
