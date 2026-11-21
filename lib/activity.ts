import { currentChangeSource } from '@/lib/audit/source'

type SupabaseAdmin = { from: (table: string) => any }

export async function logActivity(
  admin: SupabaseAdmin,
  fundId: string,
  userId: string,
  action: string,
  metadata: Record<string, unknown> = {}
) {
  try {
    // Check if user tracking is disabled for this fund
    const { data: settings } = await admin
      .from('fund_settings')
      .select('disable_user_tracking')
      .eq('fund_id', fundId)
      .maybeSingle()

    if (settings?.disable_user_tracking) return

    await admin.from('user_activity_logs').insert({
      fund_id: fundId,
      user_id: userId,
      action,
      // Which door the action came through (web, api, mcp). Its own key: some callers already
      // record a `source` of their own (what produced a summary, say), which means something else.
      // A caller that knows the door better than the request context (logConnection, from a route
      // that is not wrapped) passes its own changeSource, which wins.
      metadata: { changeSource: currentChangeSource(), ...metadata },
    })
  } catch (err) {
    console.error('[activity] Failed to log activity:', err)
  }
}

// One "connect" entry per person, door and credential per day: the MCP and API counterpart of a
// web login. A connected assistant calls the server many times a minute, so logging every call
// would flood the table; a day's first call is what says "this person used Claude (or a script)
// today". Remembered per server instance so a busy connection costs one lookup a day, not one a
// call. Two instances can each write one on the same day; that is a duplicate, not a gap.
const connectedToday = new Set<string>()

function utcDay(now: Date) {
  return now.toISOString().slice(0, 10)
}

export async function logConnection(
  admin: SupabaseAdmin,
  fundId: string,
  userId: string,
  source: 'mcp' | 'api',
  credential: string,
  now: Date = new Date(),
) {
  const day = utcDay(now)
  const key = `${day}|${fundId}|${userId}|${source}|${credential}`
  if (connectedToday.has(key)) return
  connectedToday.add(key)
  // Yesterday's keys are dead weight once the day turns.
  if (connectedToday.size > 5000) {
    for (const k of connectedToday) if (!k.startsWith(day)) connectedToday.delete(k)
  }
  try {
    const { data: existing } = await admin
      .from('user_activity_logs')
      .select('id')
      .eq('fund_id', fundId)
      .eq('user_id', userId)
      .eq('action', 'connect')
      .eq('metadata->>changeSource', source)
      .eq('metadata->>credential', credential)
      .gte('created_at', `${day}T00:00:00.000Z`)
      .limit(1)
    if (existing?.length) return
  } catch {
    // An unreadable check is no reason to lose the entry.
  }
  await logActivity(admin, fundId, userId, 'connect', { credential, changeSource: source })
}

/** For tests: forget which connections were logged today. */
export function resetConnectionCache() {
  connectedToday.clear()
}
