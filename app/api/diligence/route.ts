import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { safeWebUrl } from '@/lib/deals/submission-validation'
import { seedDealChecklistFromFundDefault } from '@/lib/diligence/seed-checklist'
import { dbError } from '@/lib/api-error'
import { loadEntityScopeForUser } from '@/lib/access/entity-scope'
import { dealEntityProblem, visibleVehicleIds } from '@/lib/access/scope'

const VALID_DEAL_STATUSES = ['active', 'passed', 'won', 'lost', 'on_hold'] as const
type DealStatus = typeof VALID_DEAL_STATUSES[number]

export async function GET(req: NextRequest) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const admin = createAdminClient()
  const { data: membership } = await admin
    .from('fund_members')
    .select('fund_id')
    .eq('user_id', user.id)
    .maybeSingle()
  if (!membership) return NextResponse.json({ error: 'No fund found' }, { status: 403 })

  const status = req.nextUrl.searchParams.get('status')
  const sector = req.nextUrl.searchParams.get('sector')
  const stage = req.nextUrl.searchParams.get('stage')
  const lead = req.nextUrl.searchParams.get('lead_partner')
  const limit = Math.min(parseInt(req.nextUrl.searchParams.get('limit') || '200', 10), 500)

  let query = admin
    .from('diligence_deals')
    .select('id, fund_id, name, sector, stage_at_consideration, deal_status, current_memo_stage, lead_partner_id, promoted_company_id, drive_folder_url, created_at, updated_at')
    .eq('fund_id', (membership as any).fund_id)
    .order('updated_at', { ascending: false })
    .limit(limit)
  // Only the caller's entities' diligence (admins: all, including unassigned).
  const scope = await loadEntityScopeForUser(admin, user.id)
  const vehicleIds = scope ? visibleVehicleIds(scope.access) : []
  if (vehicleIds !== null) query = query.in('vehicle_id' as any, vehicleIds)

  if (status) {
    const statuses = status.split(',').map(s => s.trim()).filter(s => VALID_DEAL_STATUSES.includes(s as DealStatus))
    if (statuses.length) query = query.in('deal_status', statuses)
  }
  if (sector) query = query.eq('sector', sector)
  if (stage) query = query.eq('stage_at_consideration', stage)
  if (lead) query = query.eq('lead_partner_id', lead)

  const { data, error } = await query
  if (error) return dbError(error, 'diligence-deals-list')
  return NextResponse.json(data ?? [])
}

export async function POST(req: NextRequest) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const admin = createAdminClient()
  const { data: membership } = await admin
    .from('fund_members')
    .select('fund_id')
    .eq('user_id', user.id)
    .maybeSingle()
  if (!membership) return NextResponse.json({ error: 'No fund found' }, { status: 403 })

  const body = await req.json().catch(() => ({}))
  const name = typeof body.name === 'string' ? body.name.trim() : ''
  if (!name) return NextResponse.json({ error: 'name is required' }, { status: 400 })

  const insert: Record<string, unknown> = {
    fund_id: (membership as any).fund_id,
    name,
    created_by: user.id,
  }
  if (typeof body.sector === 'string' && body.sector.trim()) insert.sector = body.sector.trim()
  if (typeof body.stage_at_consideration === 'string' && body.stage_at_consideration.trim()) {
    insert.stage_at_consideration = body.stage_at_consideration.trim()
  }
  if (typeof body.lead_partner_id === 'string' && body.lead_partner_id) {
    insert.lead_partner_id = body.lead_partner_id
  }
  if (typeof body.drive_folder_url === 'string' && body.drive_folder_url.trim()) {
    // Validate scheme — only http(s). Otherwise an attacker could persist
    // `javascript:` or `data:` URLs that fire when rendered as an <a href>
    // anywhere in the deal UI (the Data Room pre-fill, future links, etc.).
    const safe = safeWebUrl(body.drive_folder_url.trim())
    if (!safe) {
      return NextResponse.json({ error: 'drive_folder_url must be a valid http(s) URL' }, { status: 400 })
    }
    insert.drive_folder_url = safe
  }

  // The entity this diligence is for. A member must choose one of theirs (an unassigned record is
  // admin-only); an admin may leave it unassigned.
  const createScope = await loadEntityScopeForUser(admin, user.id)
  const entityId = typeof body?.vehicle_id === 'string' && body.vehicle_id ? body.vehicle_id : null
  const entityProblem = createScope ? dealEntityProblem(createScope.access, entityId) : 'No fund found'
  if (entityProblem) return NextResponse.json({ error: entityProblem }, { status: 403 })
  if (entityId) {
    // One of THIS fund's entities (an unscoped caller passes the check above for any id).
    const { data: v } = await admin.from('fund_vehicles' as any).select('id').eq('fund_id', createScope!.access.fundId).eq('id', entityId).maybeSingle()
    if (!v) return NextResponse.json({ error: 'Entity not found' }, { status: 404 })
    insert.vehicle_id = entityId
  }

  const { data, error } = await admin
    .from('diligence_deals')
    .insert(insert as any)
    .select('id, name, sector, stage_at_consideration, deal_status, current_memo_stage, lead_partner_id, created_at, updated_at')
    .single()

  if (error) return dbError(error, 'diligence-deals-create')

  const fundId = (membership as any).fund_id as string
  const dealId = (data as { id: string }).id
  const stageAtConsideration = (data as any).stage_at_consideration as string | null

  // Seed the deal's checklist from the fund template (best-effort — the
  // helper swallows its own errors so a checklist hiccup can't fail deal
  // creation, and the partner can always re-seed from the Checklist tab).
  await seedDealChecklistFromFundDefault({ admin, fundId, dealId })

  // Auto-apply the fund's memo-config preset for this stage when one is set.
  // Same best-effort posture — a preset hiccup must not fail deal creation.
  if (stageAtConsideration) {
    try {
      const { data: preset } = await (admin as any)
        .from('fund_memo_presets')
        .select('partner_memo_guidance, memo_template_config')
        .eq('fund_id', fundId)
        .eq('default_for_stage', stageAtConsideration)
        .maybeSingle()
      if (preset) {
        await (admin as any)
          .from('diligence_deals')
          .update({
            partner_memo_guidance: (preset as any).partner_memo_guidance ?? '',
            memo_template_config: (preset as any).memo_template_config ?? {},
          })
          .eq('id', dealId)
          .eq('fund_id', fundId)
      }
    } catch {
      // swallow — partner can apply manually from the Memo tab
    }
  }

  return NextResponse.json(data)
}
