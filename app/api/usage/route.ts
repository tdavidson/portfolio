import { fetchAllRows } from '@/lib/accounting/load'
import { NextResponse } from 'next/server'
import { countByUser, mergeActivityFeed, type ActivityLogRow, type AuditFeedRow } from '@/lib/activity-feed'
import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'

// Pricing per million tokens
const PRICING: Record<string, { input: number; output: number }> = {
  'anthropic:sonnet': { input: 3.0, output: 15.0 },
  'anthropic:haiku': { input: 0.8, output: 4.0 },
  'anthropic:opus': { input: 15.0, output: 75.0 },
  'openai:gpt-4o-mini': { input: 0.15, output: 0.6 },
  'openai:gpt-4o': { input: 2.5, output: 10.0 },
  'openai:gpt-4.1': { input: 2.0, output: 8.0 },
  'openai:o3-mini': { input: 1.1, output: 4.4 },
}
/** Recent feed entries returned; the page shows 50 after its Source filter. */
const RECENT_LIMIT = 300

const FALLBACK_PRICING = { input: 5.0, output: 15.0 }
// Deepgram transcription is billed per minute of audio, not per token.
const DEEPGRAM_PER_MINUTE_USD = 0.0043 // indicative (Nova pre-recorded)
// Anthropic web_search tool: ~$10 per 1,000 searches, on top of tokens.
const WEB_SEARCH_USD = 0.01

function getPricing(provider: string, model: string) {
  // Try exact provider:model match first
  const exact = PRICING[`${provider}:${model}`]
  if (exact) return exact

  // Try partial match (e.g. model contains 'sonnet', 'haiku', etc.)
  for (const [key, pricing] of Object.entries(PRICING)) {
    const modelPattern = key.split(':')[1]
    if (model.includes(modelPattern)) return pricing
  }

  return FALLBACK_PRICING
}

function estimateCost(provider: string, model: string, inputTokens: number, outputTokens: number, audioSeconds = 0, webSearches = 0) {
  if (provider === 'deepgram') return (audioSeconds / 60) * DEEPGRAM_PER_MINUTE_USD
  const pricing = getPricing(provider, model)
  return (inputTokens * pricing.input + outputTokens * pricing.output) / 1_000_000 + webSearches * WEB_SEARCH_USD
}

export async function GET() {
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
  if (membership.role !== 'admin') return NextResponse.json({ error: 'Admin access required' }, { status: 403 })

  const fundId = membership.fund_id

  const now = new Date()
  const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)).toISOString()
  const monthStartTime = Date.parse(monthStart)

  interface UsageLog {
    provider: string
    model: string
    input_tokens: number
    output_tokens: number
    audio_seconds: number
    web_searches: number
    created_at: string
  }

  // Compact daily totals preserve the existing linear cost calculation without transferring
  // every invocation. Page the summary too: long histories must not silently lose months.
  let allLogs: UsageLog[]
  try {
    allLogs = await fetchAllRows<UsageLog>((from, to) => (admin as any)
      .from('reporting_usage_daily')
      .select('provider, model, input_tokens, output_tokens, audio_seconds, web_searches, created_at')
      .eq('fund_id', fundId).order('created_at', { ascending: false }).order('provider').order('model')
      .range(from, to))
  } catch {
    return NextResponse.json({ error: 'Failed to fetch usage data' }, { status: 500 })
  }

  // Process all logs in a single pass
  const dailyMap = new Map<string, {
    date: string
    provider: string
    model: string
    input_tokens: number
    output_tokens: number
    audio_seconds: number
    web_searches: number
  }>()
  const mtdByProvider: Record<string, { input_tokens: number; output_tokens: number; estimated_cost: number }> = {}
  const monthlyMap = new Map<string, {
    month: string
    input_tokens: number
    output_tokens: number
    estimated_cost: number
  }>()

  for (const log of allLogs ?? []) {
    const date = log.created_at.slice(0, 10)
    const month = log.created_at.slice(0, 7)
    const cost = estimateCost(log.provider, log.model, log.input_tokens, log.output_tokens, log.audio_seconds, log.web_searches)
    const isCurrentMonth = Date.parse(log.created_at) >= monthStartTime

    // Monthly summary (all time)
    const monthEntry = monthlyMap.get(month)
    if (monthEntry) {
      monthEntry.input_tokens += log.input_tokens
      monthEntry.output_tokens += log.output_tokens
      monthEntry.estimated_cost += cost
    } else {
      monthlyMap.set(month, { month, input_tokens: log.input_tokens, output_tokens: log.output_tokens, estimated_cost: cost })
    }

    // Daily breakdown + MTD (current month only)
    if (isCurrentMonth) {
      const key = `${date}|${log.provider}|${log.model}`
      const existing = dailyMap.get(key)
      if (existing) {
        existing.input_tokens += log.input_tokens
        existing.output_tokens += log.output_tokens
        existing.audio_seconds += log.audio_seconds
        existing.web_searches += log.web_searches
      } else {
        dailyMap.set(key, { date, provider: log.provider, model: log.model, input_tokens: log.input_tokens, output_tokens: log.output_tokens, audio_seconds: log.audio_seconds, web_searches: log.web_searches })
      }

      if (!mtdByProvider[log.provider]) {
        mtdByProvider[log.provider] = { input_tokens: 0, output_tokens: 0, estimated_cost: 0 }
      }
      mtdByProvider[log.provider].input_tokens += log.input_tokens
      mtdByProvider[log.provider].output_tokens += log.output_tokens
      mtdByProvider[log.provider].estimated_cost += cost
    }
  }

  const daily = Array.from(dailyMap.values())
    .map(d => ({ ...d, estimated_cost: estimateCost(d.provider, d.model, d.input_tokens, d.output_tokens, d.audio_seconds, d.web_searches) }))
    .sort((a, b) => b.date.localeCompare(a.date))

  const totalEstimatedCost = Object.values(mtdByProvider).reduce((sum, p) => sum + p.estimated_cost, 0)

  const monthly = Array.from(monthlyMap.values())
    .sort((a, b) => b.month.localeCompare(a.month))

  // Check if user tracking is disabled
  const { data: fundSettings } = await admin
    .from('fund_settings')
    .select('disable_user_tracking')
    .eq('fund_id', fundId)
    .maybeSingle()

  const trackingDisabled = fundSettings?.disable_user_tracking ?? false

  if (trackingDisabled) {
    return NextResponse.json({
      daily,
      monthly,
      mtd: {
        ...mtdByProvider,
        total_estimated_cost: totalEstimatedCost,
      },
      activity: null,
    })
  }

  // This month's activity, from both stores: what features logged (user_activity_logs) and every
  // change to the books (the audit trail), whichever door it came through. Paged in full, so the
  // per-person totals count the whole month rather than its latest few hundred rows. Only the
  // columns the feed shows are read: an audit event's details can carry a whole tool call.
  let activityLogs: ActivityLogRow[]
  let auditEvents: AuditFeedRow[]
  try {
    ;[activityLogs, auditEvents] = await Promise.all([
      fetchAllRows<ActivityLogRow>((from, to) => (admin as any)
        .from('user_activity_logs')
        .select('user_id, action, metadata, created_at')
        .eq('fund_id', fundId)
        .gte('created_at', monthStart)
        .order('created_at', { ascending: false })
        .range(from, to)),
      fetchAllRows<AuditFeedRow>((from, to) => (admin as any)
        .from('accounting_audit_events')
        .select('actor_id, action, subject_type, subject_id, source, legacy_source:details->>source, tool:details->>tool, created_at')
        .eq('fund_id', fundId)
        .gte('created_at', monthStart)
        .order('created_at', { ascending: false })
        .range(from, to)),
    ])
  } catch {
    return NextResponse.json({ error: 'Failed to fetch activity' }, { status: 500 })
  }

  const feed = mergeActivityFeed(activityLogs, auditEvents)
  const userActionMap = countByUser(feed)

  // Resolve user info from fund_members + auth
  const { data: members } = await admin
    .from('fund_members')
    .select('user_id, display_name')
    .eq('fund_id', fundId) as { data: { user_id: string; display_name: string | null }[] | null }

  const memberMap: Record<string, string | null> = {}
  for (const m of members ?? []) {
    memberMap[m.user_id] = m.display_name
  }

  // Collect all unique user IDs from the feed
  const activityUserIds = Array.from(userActionMap.keys())

  // Resolve emails
  const emailMap: Record<string, string> = {}
  for (let offset = 0; offset < activityUserIds.length; offset += 5) {
    await Promise.all(activityUserIds.slice(offset, offset + 5).map(async uid => {
      const { data: { user: activityUser } } = await admin.auth.admin.getUserById(uid)
      emailMap[uid] = activityUser?.email ?? 'Unknown'
    }))
  }

  const userSummary = Array.from(userActionMap.entries()).map(([userId, actions]) => ({
    userId,
    email: emailMap[userId] ?? 'Unknown',
    displayName: memberMap[userId] ?? null,
    actions,
    total: Object.values(actions).reduce((s, n) => s + n, 0),
  }))

  // Recent activity: enough that filtering the feed to one door (the page's Source filter) still
  // leaves a full page, since a busy MCP connection can push the web entries out of the latest 50.
  const recent = feed.slice(0, RECENT_LIMIT).map(e => ({
    userId: e.userId,
    email: emailMap[e.userId] ?? 'Unknown',
    displayName: memberMap[e.userId] ?? null,
    action: e.action,
    metadata: e.metadata,
    // Which door it came through; older entries have none.
    source: e.source,
    kind: e.kind,
    createdAt: e.createdAt,
  }))

  return NextResponse.json({
    daily,
    monthly,
    mtd: {
      ...mtdByProvider,
      total_estimated_cost: totalEstimatedCost,
    },
    activity: {
      userSummary,
      recent,
    },
  })
}
