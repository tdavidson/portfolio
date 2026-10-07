import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { dbError } from '@/lib/api-error'
import { loadEntityScopeForUser } from '@/lib/access/entity-scope'
import { visibleVehicleIds } from '@/lib/access/scope'

/**
 * Cross-deal Memo Inbox feed. Returns open partner-attention items aggregated
 * across every active diligence deal in the fund, joined with the deal name
 * and current memo stage so the partner can triage without clicking into each
 * deal.
 *
 * Mirrors the Review queue pattern.
 */
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
  const fundId = (membership as any).fund_id as string

  const status = req.nextUrl.searchParams.get('status') ?? 'open'
  const urgency = req.nextUrl.searchParams.get('urgency')

  let attentionQuery = admin
    .from('diligence_attention_items')
    .select('id, deal_id, draft_id, kind, urgency, body, links, status, resolution_note, resolved_at, created_at')
    .eq('fund_id', fundId)
    .order('created_at', { ascending: false })
    .limit(500)

  if (status !== 'all') attentionQuery = attentionQuery.eq('status', status)
  if (urgency) attentionQuery = attentionQuery.eq('urgency', urgency)

  const { data: items, error } = await attentionQuery
  if (error) return dbError(error, 'diligence-inbox')

  // Hydrate deal names + status. (Postgres JOIN would be ideal but the existing
  // codebase pattern is two queries + a map — match it for consistency.)
  const dealIds = Array.from(new Set(((items as any[]) ?? []).map(r => r.deal_id))) as string[]
  let dealMap: Record<string, { name: string; deal_status: string; current_memo_stage: string }> = {}
  // Only the caller's entities' diligence; items on any other drop below.
  const scope = await loadEntityScopeForUser(admin, user.id)
  const visibleIds = scope ? visibleVehicleIds(scope.access) : []
  if (dealIds.length > 0) {
    let dealQuery = admin
      .from('diligence_deals')
      .select('id, name, deal_status, current_memo_stage')
      .in('id', dealIds)
      .eq('fund_id', fundId)
    if (visibleIds !== null) dealQuery = dealQuery.in('vehicle_id' as any, visibleIds)
    const { data: deals } = await dealQuery
    for (const d of (deals ?? []) as any[]) {
      dealMap[d.id] = { name: d.name, deal_status: d.deal_status, current_memo_stage: d.current_memo_stage }
    }
  }

  const enriched = ((items as any[]) ?? []).filter(r => visibleIds === null || dealMap[r.deal_id]).map(r => ({
    ...r,
    deal_name: dealMap[r.deal_id]?.name ?? 'Unknown deal',
    deal_status: dealMap[r.deal_id]?.deal_status ?? null,
    deal_stage: dealMap[r.deal_id]?.current_memo_stage ?? null,
  }))

  // Per-bucket counts for the header badges.
  const counts = {
    open: 0,
    ignore: 0,
    done: 0,
    must_address: 0,
    should_address: 0,
    fyi: 0,
  }
  for (const r of enriched) {
    if (r.status === 'open') counts.open++
    else if (r.status === 'ignore') counts.ignore++
    else if (r.status === 'done') counts.done++
    if (r.urgency === 'must_address') counts.must_address++
    else if (r.urgency === 'should_address') counts.should_address++
    else if (r.urgency === 'fyi') counts.fyi++
  }

  return NextResponse.json({ items: enriched, counts })
}
