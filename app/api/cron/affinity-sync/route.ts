import { NextRequest, NextResponse } from 'next/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { kickWorker } from '@/lib/memo-agent/kick'
import { dbError } from '@/lib/api-error'
import { cronAuthDenial } from '@/lib/security/cron-auth'

/**
 * Affinity sync scheduler. Started by the daily /api/cron/tick when a deal is linked to Affinity;
 * enqueues an `affinity_sync` job for every active, Affinity-linked deal that is due.
 *
 * This endpoint only ENQUEUES — the actual pull runs in the memo-agent worker,
 * which already handles claiming, retries, stale-job reaping, and the function
 * time budget. Doing the network work here would duplicate all of that and risk
 * a long fan-out blowing the cron's ceiling.
 *
 * Auth: same `Authorization: Bearer ${CRON_SECRET}` pattern as the other crons.
 */

export const maxDuration = 60

// Don't re-sync a deal more often than this. Affinity notes are written by
// humans over hours and days; polling harder just burns rate limit.
const MIN_SYNC_INTERVAL_MS = 60 * 60 * 1000  // 1 hour

export async function GET(req: NextRequest) {
  const denied = cronAuthDenial(req)
  if (denied) return denied

  const admin = createAdminClient()
  const dueBefore = new Date(Date.now() - MIN_SYNC_INTERVAL_MS).toISOString()

  // Only active deals: a passed or won deal's CRM notes are no longer evidence
  // anyone is waiting on, and syncing them forever would be pure cost.
  // Cast through `any`: the generated Supabase types lag the Affinity columns
  // until `supabase gen types` is re-run after this migration lands. Same
  // pattern the rest of the repo uses for freshly-added columns.
  const { data: deals, error } = await (admin as any)
    .from('diligence_deals')
    .select('id, fund_id, affinity_last_synced_at')
    .eq('deal_status', 'active')
    .not('affinity_organization_id', 'is', null)
    .or(`affinity_last_synced_at.is.null,affinity_last_synced_at.lt.${dueBefore}`)
    .limit(200)

  if (error) return dbError(error, 'cron-affinity-sync')

  const candidates = (deals ?? []) as Array<{ id: string; fund_id: string }>
  if (candidates.length === 0) {
    return NextResponse.json({ ok: true, enqueued: 0 })
  }

  // Skip deals that already have a job in flight — the worker runs one job per
  // deal at a time, and stacking sync jobs behind a long ingest would just make
  // the queue misleading.
  const { data: activeJobs } = await admin
    .from('memo_agent_jobs')
    .select('deal_id')
    .in('status', ['pending', 'running'])
    .in('deal_id', candidates.map(d => d.id))

  const busy = new Set(((activeJobs as any[]) ?? []).map(j => j.deal_id as string))

  const rows = candidates
    .filter(d => !busy.has(d.id))
    .map(d => ({
      fund_id: d.fund_id,
      deal_id: d.id,
      kind: 'affinity_sync' as const,
      payload: { scheduled: true },
      enqueued_by: null,
    }))

  if (rows.length === 0) {
    return NextResponse.json({ ok: true, enqueued: 0, skipped_busy: busy.size })
  }

  const { error: insErr } = await admin.from('memo_agent_jobs').insert(rows as any)
  if (insErr) return dbError(insErr, 'cron-affinity-sync')

  await kickWorker()

  return NextResponse.json({
    ok: true,
    enqueued: rows.length,
    skipped_busy: busy.size,
  })
}
