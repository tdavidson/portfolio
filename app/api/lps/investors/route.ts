import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { assertWriteAccess } from '@/lib/api-helpers'
import { dbError } from '@/lib/api-error'
import { loadLpScopeForUser, lpVisible } from '@/lib/access/lp-scope'

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

  const body = await req.json()
  const { name } = body

  if (!name?.trim()) {
    return NextResponse.json({ error: 'name is required' }, { status: 400 })
  }
  if (name.trim().length > 500) return NextResponse.json({ error: 'name too long (max 500 chars)' }, { status: 400 })

  const { data, error } = await admin
    .from('lp_investors' as any)
    .insert({ fund_id: writeCheck.fundId, name: name.trim() })
    .select('*')
    .single() as { data: any; error: { message: string } | null }

  if (error) return dbError(error, 'lp-investors-create')

  return NextResponse.json(data)
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

  const updates: Record<string, any> = { updated_at: new Date().toISOString() }
  if (name !== undefined) {
    if (!name?.trim()) return NextResponse.json({ error: 'name cannot be empty' }, { status: 400 })
    if (name.trim().length > 500) return NextResponse.json({ error: 'name too long (max 500 chars)' }, { status: 400 })
    updates.name = name.trim()
  }
  if (parentId !== undefined) {
    if (parentId !== null && typeof parentId !== 'string') return NextResponse.json({ error: 'parentId must be a string or null' }, { status: 400 })
    updates.parent_id = parentId
  }

  const { data, error } = await admin
    .from('lp_investors' as any)
    .update(updates)
    .eq('id', id)
    .eq('fund_id', writeCheck.fundId)
    .select('*')
    .single() as { data: any; error: { message: string } | null }

  if (error) {
    if (error.message?.includes('unique') || error.message?.includes('duplicate')) {
      // Look up the conflicting investor so the client can offer a merge instead of a hard error.
      let conflictId: string | null = null
      if (name !== undefined) {
        const { data: conflict } = await admin
          .from('lp_investors' as any)
          .select('id')
          .eq('fund_id', writeCheck.fundId)
          .eq('name', name.trim())
          .neq('id', id)
          .maybeSingle() as { data: { id: string } | null }
        conflictId = conflict?.id ?? null
      }
      return NextResponse.json({ error: 'duplicate_name', conflictId, sourceId: id }, { status: 409 })
    }
    return dbError(error, 'lp-investors-update')
  }

  return NextResponse.json(data)
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

  if (!sourceId || !targetId) return NextResponse.json({ error: 'sourceId and targetId are required' }, { status: 400 })
  if (sourceId === targetId) return NextResponse.json({ error: 'Cannot merge investor into itself' }, { status: 400 })

  // Verify source investor belongs to this fund
  const { data: sourceInvestor } = await admin
    .from('lp_investors' as any)
    .select('id')
    .eq('id', sourceId)
    .eq('fund_id', writeCheck.fundId)
    .maybeSingle()

  if (!sourceInvestor) return NextResponse.json({ error: 'Source investor not found' }, { status: 404 })

  // Verify target investor belongs to this fund
  const { data: targetInvestor } = await admin
    .from('lp_investors' as any)
    .select('id')
    .eq('id', targetId)
    .eq('fund_id', writeCheck.fundId)
    .maybeSingle()

  if (!targetInvestor) return NextResponse.json({ error: 'Target investor not found' }, { status: 404 })

  // Reassign all entities from source investor to target investor
  const { error: reassignErr } = await admin
    .from('lp_entities' as any)
    .update({ investor_id: targetId })
    .eq('investor_id', sourceId)
    .eq('fund_id', writeCheck.fundId)

  if (reassignErr) return dbError(reassignErr, 'lp-investors-merge-reassign')

  // Delete the source investor (now has no entities)
  const { error: deleteErr } = await admin
    .from('lp_investors' as any)
    .delete()
    .eq('id', sourceId)
    .eq('fund_id', writeCheck.fundId)

  if (deleteErr) return dbError(deleteErr, 'lp-investors-merge-delete')

  return NextResponse.json({ ok: true, merged: { from: sourceId, into: targetId } })
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

  const id = req.nextUrl.searchParams.get('id')
  if (!id) return NextResponse.json({ error: 'id is required' }, { status: 400 })

  const { error } = await admin
    .from('lp_investors' as any)
    .delete()
    .eq('id', id)
    .eq('fund_id', writeCheck.fundId)

  if (error) return dbError(error, 'lp-investors-delete')

  return NextResponse.json({ ok: true })
}
