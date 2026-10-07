import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { DEFAULT_FEATURE_VISIBILITY, isFeatureVisible } from '@/lib/types/features'
import type { FeatureVisibilityMap } from '@/lib/types/features'
import { loadLpScopeForUser, lpVisible, visibleLpItems } from '@/lib/access/lp-scope'

// Cap how many events we return in one payload. The client filters/searches
// over this set in memory; if a fund exceeds it in the window we flag truncation
// so the UI can prompt for a narrower range.
const MAX_EVENTS = 1000

interface AccessEvent {
  id: string
  created_at: string
  event_type: string
  target_type: string
  target_id: string | null
  target_title: string | null
  lp_account_id: string | null
  auth_user_id: string | null
  lp_investor_id: string | null
}

/**
 * GP-side LP portal access log. Gated by the `lp_activity` feature visibility
 * (admin-only by default; admins can widen it to all team members in Settings →
 * Feature visibility). Returns recent portal login/view/download events enriched
 * with the acting person and investor names, plus a per-person rollup for
 * filtering.
 */
export async function GET(req: NextRequest) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const admin = createAdminClient()

  const { data: membership } = await admin
    .from('fund_members')
    .select('fund_id, role')
    .eq('user_id', user.id)
    .maybeSingle()
  if (!membership) return NextResponse.json({ error: 'No fund found' }, { status: 403 })

  const fundId = membership.fund_id
  const isAdmin = membership.role === 'admin'

  const { data: fundSettings } = await (admin as any)
    .from('fund_settings')
    .select('lp_portal_enabled, feature_visibility')
    .eq('fund_id', fundId)
    .maybeSingle()

  // Master switch off → no LP activity available.
  if (!fundSettings?.lp_portal_enabled) {
    return NextResponse.json({ error: 'Not available' }, { status: 403 })
  }

  const featureVisibility: FeatureVisibilityMap = {
    ...DEFAULT_FEATURE_VISIBILITY,
    ...(fundSettings?.feature_visibility ?? {}),
  }
  if (!isFeatureVisible(featureVisibility, 'lp_activity', isAdmin)) {
    return NextResponse.json({ error: 'Not available' }, { status: 403 })
  }

  const daysParam = parseInt(req.nextUrl.searchParams.get('days') ?? '90', 10)
  const days = Number.isFinite(daysParam) ? Math.min(Math.max(daysParam, 1), 3650) : 90
  const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString()

  const { data: rawEvents, error } = await (admin as any)
    .from('lp_access_events')
    .select('id, created_at, event_type, target_type, target_id, target_title, lp_account_id, auth_user_id, lp_investor_id')
    .eq('fund_id', fundId)
    .gte('created_at', cutoff)
    .order('created_at', { ascending: false })
    .limit(MAX_EVENTS + 1) as { data: AccessEvent[] | null; error: any }

  if (error) {
    return NextResponse.json({ error: 'Failed to load access log' }, { status: 500 })
  }

  const truncated = (rawEvents?.length ?? 0) > MAX_EVENTS
  // Only activity by investors the caller can see.
  const lp = await loadLpScopeForUser(admin, user.id)
  const byInvestor = (rawEvents ?? []).slice(0, MAX_EVENTS)
    .filter(e => lpVisible(lp ? lp.investorIds : [], e.lp_investor_id))
  // ...and a visit to a document or letter only when the caller can see that item: a shared LP's
  // visit to another entity's document is that entity's activity.
  const items = lp && await visibleLpItems(admin, fundId, lp, {
    documents: byInvestor.filter(e => e.target_type === 'document' && e.target_id).map(e => e.target_id!),
    letters: byInvestor.filter(e => e.target_type === 'letter' && e.target_id).map(e => e.target_id!),
  })
  const events = byInvestor.filter(e => !items || !e.target_id
    || (e.target_type === 'document' ? items.documents.has(e.target_id)
      : e.target_type === 'letter' ? items.letters.has(e.target_id) : true))

  // Resolve acting-person and investor names in bulk.
  const accountIds = Array.from(new Set(events.map(e => e.lp_account_id).filter(Boolean))) as string[]
  const investorIds = Array.from(new Set(events.map(e => e.lp_investor_id).filter(Boolean))) as string[]

  const [{ data: accounts }, { data: investors }] = await Promise.all([
    accountIds.length
      ? (admin as any).from('lp_accounts').select('id, display_name, email, kind').in('id', accountIds)
      : Promise.resolve({ data: [] }),
    investorIds.length
      ? (admin as any).from('lp_investors').select('id, name').in('id', investorIds)
      : Promise.resolve({ data: [] }),
  ])

  const accountMap = new Map<string, { display_name: string | null; email: string | null; kind: string | null }>(
    (accounts ?? []).map((a: any) => [a.id, { display_name: a.display_name, email: a.email, kind: a.kind }])
  )
  const investorMap = new Map<string, string>((investors ?? []).map((i: any) => [i.id, i.name]))

  const enriched = events.map(e => {
    const acct = e.lp_account_id ? accountMap.get(e.lp_account_id) : undefined
    return {
      id: e.id,
      createdAt: e.created_at,
      eventType: e.event_type,
      targetType: e.target_type,
      targetId: e.target_id,
      targetTitle: e.target_title,
      personId: e.lp_account_id,
      personName: acct?.display_name ?? acct?.email ?? 'Unknown',
      personEmail: acct?.email ?? null,
      personKind: acct?.kind ?? null,
      investorName: e.lp_investor_id ? investorMap.get(e.lp_investor_id) ?? null : null,
    }
  })

  // Per-person rollup for the filter dropdown + summary.
  const peopleMap = new Map<string, {
    id: string
    name: string
    email: string | null
    kind: string | null
    logins: number
    views: number
    downloads: number
    total: number
    lastSeen: string
  }>()
  for (const e of enriched) {
    if (!e.personId) continue
    let p = peopleMap.get(e.personId)
    if (!p) {
      p = { id: e.personId, name: e.personName, email: e.personEmail, kind: e.personKind, logins: 0, views: 0, downloads: 0, total: 0, lastSeen: e.createdAt }
      peopleMap.set(e.personId, p)
    }
    if (e.eventType === 'login') p.logins++
    else if (e.eventType === 'view') p.views++
    else if (e.eventType === 'download') p.downloads++
    p.total++
    if (e.createdAt > p.lastSeen) p.lastSeen = e.createdAt
  }
  const people = Array.from(peopleMap.values()).sort((a, b) => b.lastSeen.localeCompare(a.lastSeen))

  const summary = {
    totalEvents: enriched.length,
    logins: enriched.filter(e => e.eventType === 'login').length,
    views: enriched.filter(e => e.eventType === 'view').length,
    downloads: enriched.filter(e => e.eventType === 'download').length,
    activePeople: people.length,
  }

  return NextResponse.json({ events: enriched, people, summary, days, truncated })
}
