import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { dbError } from '@/lib/api-error'
import { loadEntityScopeForUser } from '@/lib/access/entity-scope'
import { dealEntityProblem } from '@/lib/access/scope'

// 'invested' is the current label for a closed/won deal; 'won'/'lost'/'on_hold'
// are retained for back-compat with rows written before the relabel.
const VALID_DEAL_STATUSES = ['invested', 'active', 'passed', 'won', 'lost', 'on_hold'] as const
const VALID_MEMO_STAGES = ['not_started', 'ingest', 'research', 'qa', 'draft', 'score', 'render', 'finalized'] as const

export async function GET(_req: NextRequest, props: { params: Promise<{ id: string }> }) {
  const params = await props.params;
  const guard = await ensureMember()
  if ('error' in guard) return guard.error
  const { admin, fundId } = guard

  const { data: deal } = await admin
    .from('diligence_deals')
    .select('*')
    .eq('id', params.id)
    .eq('fund_id', fundId)
    .maybeSingle()
  if (!deal) return NextResponse.json({ error: 'Not found' }, { status: 404 })

  // Document count for the overview tab.
  const { count: documentCount } = await admin
    .from('diligence_documents')
    .select('id', { count: 'exact', head: true })
    .eq('deal_id', params.id)
    .eq('fund_id', fundId)

  // Latest draft summary, if any.
  const { data: latestDraft } = await admin
    .from('diligence_memo_drafts')
    .select('id, draft_version, agent_version, is_draft, created_at, finalized_at')
    .eq('deal_id', params.id)
    .eq('fund_id', fundId)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle()

  return NextResponse.json({
    deal,
    documentCount: documentCount ?? 0,
    latestDraft,
  })
}

export async function PATCH(req: NextRequest, props: { params: Promise<{ id: string }> }) {
  const params = await props.params;
  const guard = await ensureMember()
  if ('error' in guard) return guard.error
  const { admin, fundId } = guard

  const body = await req.json().catch(() => ({}))
  const updates: Record<string, unknown> = {}
  if (typeof body.name === 'string' && body.name.trim()) updates.name = body.name.trim()
  if (typeof body.sector === 'string') updates.sector = body.sector.trim() || null
  if (typeof body.stage_at_consideration === 'string') updates.stage_at_consideration = body.stage_at_consideration.trim() || null
  if (typeof body.lead_partner_id === 'string' || body.lead_partner_id === null) updates.lead_partner_id = body.lead_partner_id
  if (typeof body.deal_status === 'string') {
    if (!VALID_DEAL_STATUSES.includes(body.deal_status)) {
      return NextResponse.json({ error: 'Invalid deal_status' }, { status: 400 })
    }
    updates.deal_status = body.deal_status
  }
  if (typeof body.current_memo_stage === 'string') {
    if (!VALID_MEMO_STAGES.includes(body.current_memo_stage)) {
      return NextResponse.json({ error: 'Invalid current_memo_stage' }, { status: 400 })
    }
    updates.current_memo_stage = body.current_memo_stage
  }
  // The owning entity. The gate already confirmed the caller can see this record; the new entity
  // must be theirs too (a member can't leave it unassigned), and must belong to this fund.
  if (typeof body.vehicle_id === 'string' || body.vehicle_id === null) {
    const scope = await loadEntityScopeForUser(admin, guard.userId)
    const problem = scope ? dealEntityProblem(scope.access, body.vehicle_id) : 'No fund found'
    if (problem) return NextResponse.json({ error: problem }, { status: 403 })
    if (body.vehicle_id) {
      const { data: v } = await admin.from('fund_vehicles' as any).select('id').eq('fund_id', fundId).eq('id', body.vehicle_id).maybeSingle()
      if (!v) return NextResponse.json({ error: 'Entity not found' }, { status: 404 })
    }
    updates.vehicle_id = body.vehicle_id
  }

  if (Object.keys(updates).length === 0) {
    return NextResponse.json({ error: 'No fields to update' }, { status: 400 })
  }

  const { error } = await admin
    .from('diligence_deals')
    .update(updates)
    .eq('id', params.id)
    .eq('fund_id', fundId)
  if (error) return dbError(error, 'diligence-deal-update')
  return NextResponse.json({ ok: true })
}

export async function DELETE(_req: NextRequest, props: { params: Promise<{ id: string }> }) {
  const params = await props.params;
  const guard = await ensureAdmin()
  if ('error' in guard) return guard.error
  const { admin, fundId } = guard

  // ON DELETE CASCADE handles documents, drafts, attention items, sessions, notes.
  // Storage objects under {dealId}/* will dangle; cleaning them is async (TODO).
  const { error } = await admin
    .from('diligence_deals')
    .delete()
    .eq('id', params.id)
    .eq('fund_id', fundId)
  if (error) return dbError(error, 'diligence-deal-delete')
  return NextResponse.json({ ok: true })
}

// ---------------------------------------------------------------------------

async function ensureMember() {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return { error: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }) }

  const admin = createAdminClient()
  const { data: membership } = await admin
    .from('fund_members')
    .select('fund_id, role')
    .eq('user_id', user.id)
    .maybeSingle()
  if (!membership) return { error: NextResponse.json({ error: 'No fund found' }, { status: 403 }) }

  return { admin, fundId: (membership as any).fund_id as string, userId: user.id, role: (membership as any).role as string }
}

async function ensureAdmin() {
  const guard = await ensureMember()
  if ('error' in guard) return guard
  if (guard.role !== 'admin') {
    return { error: NextResponse.json({ error: 'Admin required' }, { status: 403 }) }
  }
  return guard
}
