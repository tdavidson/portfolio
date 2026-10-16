import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { assertWriteAccess } from '@/lib/api-helpers'
import { dbError } from '@/lib/api-error'
import { loadLpScopeForUser, lpVisible } from '@/lib/access/lp-scope'
import { outcomeResponse } from '@/lib/service-outcome'
import { createInvestor, deleteInvestor, mergeInvestors, updateInvestor } from '@/lib/lps/records'

// ---------------------------------------------------------------------------
// GET — all investors for this fund, with their entities
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
  // Read allowed for admins and the read-only demo viewer; writes stay admin-only below.
  if (membership.role !== 'admin' && membership.role !== 'viewer') return NextResponse.json({ error: 'Admin access required' }, { status: 403 })

  const admin = createAdminClient()
  const { data, error } = await admin
    .from('lp_investors' as any)
    .select('*, parent_id, lp_entities(*)')
    .eq('fund_id', membership.fund_id)
    .order('name', { ascending: true }) as { data: any[] | null; error: { message: string } | null }

  if (error) return dbError(error, 'lp-investors')

  // A viewer (the demo role) is not an admin: only investors visible through their entities.
  const lp = await loadLpScopeForUser(admin, user.id)
  return NextResponse.json((data ?? []).filter(i => lpVisible(lp ? lp.investorIds : [], i.id)))
}

// ---------------------------------------------------------------------------
// POST — create a new investor
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
  return outcomeResponse(await createInvestor(admin, writeCheck.fundId, body?.name))
}

// ---------------------------------------------------------------------------
// PUT — update investor name
// ---------------------------------------------------------------------------

export async function PUT(req: NextRequest) {
  const supabase = await createClient()
  const admin = createAdminClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const writeCheck = await assertWriteAccess(admin, user.id)
  if (writeCheck instanceof NextResponse) return writeCheck
  if (writeCheck.role !== 'admin') return NextResponse.json({ error: 'Admin access required' }, { status: 403 })

  const body = await req.json()
  const { id: bodyId, entityId, name, parentId } = body

  if (!bodyId && !entityId) return NextResponse.json({ error: 'id or entityId is required' }, { status: 400 })

  let id: string = bodyId
  if (!id && entityId) {
    const { data: entity } = await admin
      .from('lp_entities' as any)
      .select('investor_id')
      .eq('id', entityId)
      .eq('fund_id', writeCheck.fundId)
      .maybeSingle() as { data: { investor_id: string } | null }

    if (!entity) return NextResponse.json({ error: 'Entity not found' }, { status: 404 })
    id = entity.investor_id
  }

  return outcomeResponse(await updateInvestor(admin, writeCheck.fundId, id, { name, parentId }))
}

// ---------------------------------------------------------------------------
// PATCH — merge one investor into another (reassign entities, delete source)
// ---------------------------------------------------------------------------

export async function PATCH(req: NextRequest) {
  const supabase = await createClient()
  const admin = createAdminClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const writeCheck = await assertWriteAccess(admin, user.id)
  if (writeCheck instanceof NextResponse) return writeCheck
  if (writeCheck.role !== 'admin') return NextResponse.json({ error: 'Admin access required' }, { status: 403 })

  const body = await req.json()
  const { sourceId, targetId } = body
  // Shared with the lp_merge_investors tool (lib/lps/records.ts).
  return outcomeResponse(await mergeInvestors(admin, writeCheck.fundId, sourceId, targetId))
}

// ---------------------------------------------------------------------------
// DELETE — remove an investor by id
// ---------------------------------------------------------------------------

export async function DELETE(req: NextRequest) {
  const supabase = await createClient()
  const admin = createAdminClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const writeCheck = await assertWriteAccess(admin, user.id)
  if (writeCheck instanceof NextResponse) return writeCheck
  if (writeCheck.role !== 'admin') return NextResponse.json({ error: 'Admin access required' }, { status: 403 })

  // Shared with the lp_delete_investor tool (lib/lps/records.ts).
  return outcomeResponse(await deleteInvestor(admin, writeCheck.fundId, req.nextUrl.searchParams.get('id')))
}
