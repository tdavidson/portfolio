import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { assertWriteAccess } from '@/lib/api-helpers'
import { dbError } from '@/lib/api-error'
import { outcomeResponse } from '@/lib/service-outcome'
import { createEntity, deleteEntity, updateEntity } from '@/lib/lps/records'

// ---------------------------------------------------------------------------
// GET — list all entities for this fund
// ---------------------------------------------------------------------------

export async function GET() {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  // Use user-scoped client for membership check (RLS enforces user can only see own memberships)
  const { data: membership } = await (supabase as any)
    .from('fund_members')
    .select('fund_id, role')
    .eq('user_id', user.id)
    .maybeSingle() as { data: { fund_id: string; role: string } | null }

  if (!membership) return NextResponse.json({ error: 'No fund found' }, { status: 403 })
  if (membership.role !== 'admin') return NextResponse.json({ error: 'Admin access required' }, { status: 403 })

  const admin = createAdminClient()
  const { data, error } = await admin
    .from('lp_entities' as any)
    .select('id, entity_name, investor_id')
    .eq('fund_id', membership.fund_id)
    .order('entity_name') as { data: any[] | null; error: any }

  if (error) return dbError(error, 'lp-entities-list')

  return NextResponse.json(data ?? [])
}

// ---------------------------------------------------------------------------
// POST — create/assign an entity to an investor
// ---------------------------------------------------------------------------

export async function POST(req: NextRequest) {
  const supabase = await createClient()
  const admin = createAdminClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const writeCheck = await assertWriteAccess(admin, user.id)
  if (writeCheck instanceof NextResponse) return writeCheck
  if (writeCheck.role !== 'admin') return NextResponse.json({ error: 'Admin access required' }, { status: 403 })

  const body = await req.json().catch(() => ({}))
  return outcomeResponse(await createEntity(admin, writeCheck.fundId, { investorId: body?.investorId, entityName: body?.entityName }))
}

// ---------------------------------------------------------------------------
// PUT — reassign entity to different investor
// ---------------------------------------------------------------------------

export async function PUT(req: NextRequest) {
  const supabase = await createClient()
  const admin = createAdminClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const writeCheck = await assertWriteAccess(admin, user.id)
  if (writeCheck instanceof NextResponse) return writeCheck
  if (writeCheck.role !== 'admin') return NextResponse.json({ error: 'Admin access required' }, { status: 403 })

  const body = await req.json().catch(() => ({}))
  if (!body?.id) return NextResponse.json({ error: 'id is required' }, { status: 400 })
  return outcomeResponse(await updateEntity(admin, writeCheck.fundId, body.id, { investorId: body.investorId, entityName: body.entityName }))
}

// ---------------------------------------------------------------------------
// DELETE — remove an entity by id
// ---------------------------------------------------------------------------

export async function DELETE(req: NextRequest) {
  const supabase = await createClient()
  const admin = createAdminClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const writeCheck = await assertWriteAccess(admin, user.id)
  if (writeCheck instanceof NextResponse) return writeCheck
  if (writeCheck.role !== 'admin') return NextResponse.json({ error: 'Admin access required' }, { status: 403 })

  // Refused while the entity has ledger activity: lib/lps/records.ts says why. Shared with the
  // lp_delete_entity tool.
  return outcomeResponse(await deleteEntity(admin, writeCheck.fundId, req.nextUrl.searchParams.get('id')))
}
