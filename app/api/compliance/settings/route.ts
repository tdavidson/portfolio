import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { assertWriteAccess } from '@/lib/api-helpers'
import { rateLimit } from '@/lib/rate-limit'
import { dbError } from '@/lib/api-error'
import { parseGroupKey } from '@/lib/compliance/schedule'
import { overlayCompletion, parseYear, type DeadlineRow } from '@/lib/compliance/completion'
import { loadEntityScope } from '@/lib/access/entity-scope'
import { groupWriteDenial } from '@/lib/access/scope'

// Bulk upsert applicability settings
export async function POST(req: NextRequest) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const limited = await rateLimit({ key: `compliance-settings:${user.id}`, limit: 30, windowSeconds: 60 })
  if (limited) return limited

  const admin = createAdminClient()
  const writeCheck = await assertWriteAccess(admin, user.id)
  if (writeCheck instanceof NextResponse) return writeCheck
  const { fundId } = writeCheck

  const body = await req.json()
  const { settings } = body as {
    settings: { compliance_item_id: string; applies: string; dismissed: boolean; dismissed_reason?: string; portfolio_group?: string }[]
  }

  if (!Array.isArray(settings) || settings.length === 0 || settings.length > 100) {
    return NextResponse.json({ error: 'settings array required (1-100 items)' }, { status: 400 })
  }

  const VALID_APPLIES = ['yes', 'no', 'unsure']

  // Entity-specific settings only for the caller's entities; fund-level ones (no entity) stay open.
  const scope = await loadEntityScope(admin, writeCheck)
  for (const s of settings) {
    const group = s.portfolio_group ? parseGroupKey(String(s.portfolio_group)).portfolioGroup : ''
    const denied = group ? groupWriteDenial(scope.vehicleNames, group) : null
    if (denied) return NextResponse.json({ error: denied }, { status: 403 })
  }

  const rows = settings.map(s => ({
    fund_id: fundId,
    compliance_item_id: String(s.compliance_item_id).slice(0, 100),
    portfolio_group: s.portfolio_group ? String(s.portfolio_group).slice(0, 200) : '',
    applies: VALID_APPLIES.includes(s.applies) ? s.applies : 'unsure',
    dismissed: !!s.dismissed,
    dismissed_reason: s.dismissed_reason ? String(s.dismissed_reason).slice(0, 500) : null,
    dismissed_by: s.dismissed ? user.id : null,
    dismissed_at: s.dismissed ? new Date().toISOString() : null,
    updated_at: new Date().toISOString(),
  }))

  const { data, error } = await admin
    .from('compliance_fund_settings')
    .upsert(rows, { onConflict: 'fund_id,compliance_item_id,portfolio_group' })
    .select()

  if (error) return dbError(error, 'compliance-settings')
  return NextResponse.json(data)
}

// Update a single item's setting
export async function PATCH(req: NextRequest) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const limited = await rateLimit({ key: `compliance-settings:${user.id}`, limit: 30, windowSeconds: 60 })
  if (limited) return limited

  const admin = createAdminClient()
  const writeCheck = await assertWriteAccess(admin, user.id)
  if (writeCheck instanceof NextResponse) return writeCheck
  const { fundId } = writeCheck

  const body = await req.json()
  const { compliance_item_id, applies, dismissed, dismissed_reason, completed, completed_note, completed_link, notes, portfolio_group } = body

  if (!compliance_item_id) {
    return NextResponse.json({ error: 'compliance_item_id required' }, { status: 400 })
  }

  const VALID_APPLIES = ['yes', 'no', 'unsure']
  const now = new Date().toISOString()
  // The year the page is showing — clamped exactly like GET ?year=.
  const year = parseYear(body.year)
  const pgKey = portfolio_group ? String(portfolio_group).slice(0, 200) : ''
  {
    const group = pgKey ? parseGroupKey(pgKey).portfolioGroup : ''
    const denied = group ? groupWriteDenial((await loadEntityScope(admin, writeCheck)).vehicleNames, group) : null
    if (denied) return NextResponse.json({ error: denied }, { status: 403 })
  }
  const clip = (v: unknown) => (v ? String(v).slice(0, 2000) : null)

  // Applicability and dismissal are not per-period: they stay on compliance_fund_settings.
  const updates: Record<string, unknown> = { updated_at: now }
  if (applies !== undefined) {
    updates.applies = VALID_APPLIES.includes(applies) ? applies : 'unsure'
  }
  if (dismissed !== undefined) {
    updates.dismissed = !!dismissed
    updates.dismissed_by = dismissed ? user.id : null
    updates.dismissed_at = dismissed ? now : null
    updates.dismissed_reason = dismissed_reason ? String(dismissed_reason).slice(0, 500) : null
  }
  if (completed === true) {
    // Completing an item un-dismisses it, as before.
    updates.dismissed = false
    updates.dismissed_by = null
    updates.dismissed_at = null
    updates.dismissed_reason = null
  }
  if (notes !== undefined) {
    updates.notes = clip(notes)
  }

  const { data: setting, error } = await admin
    .from('compliance_fund_settings')
    .upsert({ fund_id: fundId, compliance_item_id, portfolio_group: pgKey, ...updates }, { onConflict: 'fund_id,compliance_item_id,portfolio_group' })
    .select()
    .single()
  if (error) return dbError(error, 'compliance-settings')

  // Completion is per occurrence (item × vehicle × year × quarter), so it resets each cycle.
  const { portfolioGroup, quarter } = parseGroupKey(pgKey)
  const occurrence = { fund_id: fundId, compliance_item_id, portfolio_group: portfolioGroup, year, quarter }
  const deadlines = () => admin.from('compliance_deadlines' as any)

  let occError: unknown = null
  if (completed === true) {
    ;({ error: occError } = await deadlines().upsert({
      ...occurrence,
      status: 'filed',
      filed_date: now.slice(0, 10),
      filed_by: user.id,
      notes: clip(completed_note),
      filing_reference_url: clip(completed_link),
      updated_at: now,
    }, { onConflict: 'fund_id,compliance_item_id,portfolio_group,year,quarter' }))
  } else if (completed === false || dismissed === true) {
    ;({ error: occError } = await deadlines().delete().match(occurrence))
  } else if (completed_note !== undefined || completed_link !== undefined) {
    const patch: Record<string, unknown> = { updated_at: now }
    if (completed_note !== undefined) patch.notes = clip(completed_note)
    if (completed_link !== undefined) patch.filing_reference_url = clip(completed_link)
    ;({ error: occError } = await deadlines().update(patch).match(occurrence))
  }
  if (occError) return dbError(occError as any, 'compliance-settings')

  const { data: row } = await deadlines()
    .select('compliance_item_id, portfolio_group, quarter, year, status, notes, filing_reference_url, created_at')
    .match(occurrence)
    .maybeSingle()

  return NextResponse.json(overlayCompletion([setting as unknown as { compliance_item_id: string; portfolio_group: string | null }], row ? [row as unknown as DeadlineRow] : [])[0])
}
