import { lockedMessage, reportShareCount } from '@/lib/lps/shared-lock'
import { recordAudit } from '@/lib/audit/events'
import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { assertWriteAccess } from '@/lib/api-helpers'
import { dbError } from '@/lib/api-error'
import { loadEntityScopeForUser } from '@/lib/access/entity-scope'
import { scopeCompanyRows } from '@/lib/access/scope'

// ---------------------------------------------------------------------------
// GET — all investments for this fund, joined with entities + investors
// ---------------------------------------------------------------------------

export async function GET(req: NextRequest) {
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
  // No admin check — all fund members can read investments (needed for LP reports)

  const admin = createAdminClient()
  let query = admin
    .from('lp_investments' as any)
    .select('*, lp_entities!inner(id, entity_name, investor_id, lp_investors!inner(id, name, parent_id))')
    .eq('fund_id', membership.fund_id)

  const snapshotId = req.nextUrl.searchParams.get('snapshotId')
  if (snapshotId) {
    // Validate snapshot belongs to this fund
    const { data: snapCheck } = await admin
      .from('lp_snapshots' as any)
      .select('id')
      .eq('id', snapshotId)
      .eq('fund_id', membership.fund_id)
      .maybeSingle()
    if (!snapCheck) return NextResponse.json({ error: 'Snapshot not found' }, { status: 404 })
    query = query.eq('snapshot_id', snapshotId)
  }

  const { data, error } = await query
    .order('portfolio_group', { ascending: true }) as { data: any[] | null; error: { message: string } | null }

  if (error) return dbError(error, 'lp-investments')

  // Only the caller's entities' rows.
  const scope = await loadEntityScopeForUser(admin, user.id)
  return NextResponse.json(scopeCompanyRows(data ?? [], scope ? scope.vehicleNames : [], 'portfolio_group'))
}

// ---------------------------------------------------------------------------
// POST — create an investment
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
  const { entityId, portfolioGroup, commitment, paidInCapital, distributions } = body

  if (!entityId) return NextResponse.json({ error: 'entityId is required' }, { status: 400 })
  if (!portfolioGroup?.trim()) return NextResponse.json({ error: 'portfolioGroup is required' }, { status: 400 })

  // Validate entity belongs to this fund
  const { data: entityCheck } = await admin
    .from('lp_entities' as any)
    .select('id')
    .eq('id', entityId)
    .eq('fund_id', writeCheck.fundId)
    .maybeSingle()
  if (!entityCheck) return NextResponse.json({ error: 'Entity not found' }, { status: 404 })

  const { data, error } = await admin
    .from('lp_investments' as any)
    .insert({
      fund_id: writeCheck.fundId,
      entity_id: entityId,
      portfolio_group: portfolioGroup.trim(),
      commitment: commitment ?? null,
      paid_in_capital: paidInCapital ?? null,
      distributions: distributions ?? null,
    })
    .select('*')
    .single() as { data: any; error: { message: string } | null }

  if (error) return dbError(error, 'lp-investments-create')

  return NextResponse.json(data)
}

// ---------------------------------------------------------------------------
// PUT — update an investment
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
  const { id, entityId, portfolioGroup, commitment, paidInCapital, distributions, nav, calledCapital, totalValue, outstandingBalance, dpi, rvpi, tvpi, irr } = body

  if (!id) return NextResponse.json({ error: 'id is required' }, { status: 400 })

  const { data: before } = await admin.from('lp_investments' as any).select('*').eq('id', id).eq('fund_id', writeCheck.fundId).maybeSingle()
  if (!before) return NextResponse.json({ error: 'Not found' }, { status: 404 })
  const figuresChanging = [commitment, paidInCapital, distributions, nav, calledCapital, totalValue, outstandingBalance, dpi, rvpi, tvpi, irr].some(v => v !== undefined)
  const shares = figuresChanging ? await reportShareCount(admin, writeCheck.fundId, (before as any).snapshot_id) : 0
  if (shares > 0) return NextResponse.json({ error: lockedMessage(shares, 'this position') }, { status: 409 })

  const updates: Record<string, any> = { updated_at: new Date().toISOString() }
  if (entityId !== undefined) {
    // Validate entity belongs to this fund
    const { data: entityCheck } = await admin
      .from('lp_entities' as any)
      .select('id')
      .eq('id', entityId)
      .eq('fund_id', writeCheck.fundId)
      .maybeSingle()
    if (!entityCheck) return NextResponse.json({ error: 'Entity not found' }, { status: 404 })
    updates.entity_id = entityId
  }
  if (portfolioGroup !== undefined) {
    if (typeof portfolioGroup !== 'string' || !portfolioGroup.trim()) return NextResponse.json({ error: 'portfolioGroup cannot be empty' }, { status: 400 })
    if (portfolioGroup.trim().length > 500) return NextResponse.json({ error: 'portfolioGroup too long' }, { status: 400 })
    updates.portfolio_group = portfolioGroup.trim()
  }
  const numFields = { commitment, paid_in_capital: paidInCapital, distributions, nav, called_capital: calledCapital, total_value: totalValue, outstanding_balance: outstandingBalance, dpi, rvpi, tvpi, irr } as Record<string, unknown>
  for (const [col, val] of Object.entries(numFields)) {
    if (val !== undefined) {
      if (val !== null && (typeof val !== 'number' || !isFinite(val))) return NextResponse.json({ error: `${col} must be a number or null` }, { status: 400 })
      updates[col] = val
    }
  }

  const { data, error } = await admin
    .from('lp_investments' as any)
    .update(updates)
    .eq('id', id)
    .eq('fund_id', writeCheck.fundId)
    .select('*')
    .single() as { data: any; error: { message: string } | null }

  if (error) return dbError(error, 'lp-investments-update')
  await recordAudit(admin, {
    fundId: writeCheck.fundId, actorId: user.id, action: 'lp_position.edit', subjectType: 'lp_investment', subjectId: id,
    details: { before, changes: updates },
  })

  return NextResponse.json(data)
}

// ---------------------------------------------------------------------------
// DELETE — remove an investment by id
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

  const { data: before } = await admin.from('lp_investments' as any).select('*').eq('id', id).eq('fund_id', writeCheck.fundId).maybeSingle()
  const shares = await reportShareCount(admin, writeCheck.fundId, (before as any)?.snapshot_id)
  if (shares > 0) return NextResponse.json({ error: lockedMessage(shares, 'this position') }, { status: 409 })

  const { error } = await admin
    .from('lp_investments' as any)
    .delete()
    .eq('id', id)
    .eq('fund_id', writeCheck.fundId)

  if (error) return dbError(error, 'lp-investments-delete')
  if (before) await recordAudit(admin, { fundId: writeCheck.fundId, actorId: user.id, action: 'lp_position.delete', subjectType: 'lp_investment', subjectId: id, details: { deleted: before } })

  return NextResponse.json({ ok: true })
}
