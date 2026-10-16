import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { loadEntityScopeForUser } from '@/lib/access/entity-scope'
import { deleteDiligenceDeal, updateDiligenceDeal } from '@/lib/diligence/service'
import { outcomeResponse } from '@/lib/service-outcome'

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
  const { admin } = guard

  const scope = await loadEntityScopeForUser(admin, guard.userId)
  if (!scope) return NextResponse.json({ error: 'No fund found' }, { status: 403 })

  const body = await req.json().catch(() => ({}))
  // The owning entity: the gate already confirmed the caller can see this record, and
  // lib/diligence/service.ts checks the new one is theirs too and belongs to this fund.
  const result = await updateDiligenceDeal(admin, scope.access, params.id, {
    name: body.name,
    sector: body.sector,
    stageAtConsideration: body.stage_at_consideration,
    leadPartnerId: typeof body.lead_partner_id === 'string' || body.lead_partner_id === null ? body.lead_partner_id : undefined,
    dealStatus: body.deal_status,
    memoStage: body.current_memo_stage,
    vehicleId: typeof body.vehicle_id === 'string' || body.vehicle_id === null ? body.vehicle_id : undefined,
  })
  return outcomeResponse(result, () => ({ ok: true }))
}

export async function DELETE(_req: NextRequest, props: { params: Promise<{ id: string }> }) {
  const params = await props.params;
  const guard = await ensureAdmin()
  if ('error' in guard) return guard.error
  const { admin, fundId } = guard

  // The cascade is the database's; shared with the diligence_delete_deal tool (lib/diligence/service.ts).
  return outcomeResponse(await deleteDiligenceDeal(admin, fundId, params.id))
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
