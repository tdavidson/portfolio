import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { assertWriteAccess } from '@/lib/api-helpers'
import { loadEntityScopeForUser } from '@/lib/access/entity-scope'
import { outcomeResponse } from '@/lib/service-outcome'
import { createLetter, listLetters } from '@/lib/lp-letters/service'

export async function GET() {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const admin = createAdminClient()
  const { data: membership } = await admin
    .from('fund_members')
    .select('fund_id, role')
    .eq('user_id', user.id)
    .maybeSingle()

  if (!membership) return NextResponse.json({ error: 'No fund' }, { status: 403 })

  // Only the caller's entities' letters — a letter is one entity's.
  const scope = await loadEntityScopeForUser(admin, user.id)
  return outcomeResponse(await listLetters(admin, membership.fund_id, scope ? scope.vehicleNames : []), letters => ({ letters, role: membership.role }))
}

export async function POST(req: NextRequest) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const admin = createAdminClient()
  const writeCheck = await assertWriteAccess(admin, user.id)
  if (writeCheck instanceof NextResponse) return writeCheck
  const { fundId } = writeCheck

  const body = await req.json()
  const writeScope = await loadEntityScopeForUser(admin, user.id)
  const out = await createLetter(admin, { fundId, userId: user.id, visible: writeScope ? writeScope.writableNames : [] }, body ?? {})
  if (!out.ok) return outcomeResponse(out)
  return NextResponse.json(out.value, { status: 201 })
}
