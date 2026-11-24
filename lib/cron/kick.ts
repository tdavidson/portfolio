// Start a background worker NOW instead of waiting for the daily tick. Best-effort and
// fire-and-forget: we only need the request to reach the worker route (which then runs on its own
// function budget), so we start the fetch and stop waiting after a moment. Any failure is
// swallowed: the daily /api/cron/tick picks up whatever a missed kick left behind.

/** Every route under app/api/cron/ that a kick or the dispatcher may start. */
export const CRON_WORKERS = [
  'memo-agent-worker',
  'company-updates-ocr',
  'entity-documents-ocr',
  'deal-research',
  'company-updates-backfill',
  'document-hashes',
  'affinity-sync',
  'access-expiry',
  'ops-reminders',
  'deals-digest',
  'fee-periods',
] as const

export type CronWorker = typeof CRON_WORKERS[number]

export function cronBaseUrl(): string | null {
  const base = process.env.NEXT_PUBLIC_SITE_URL
    ?? process.env.NEXT_PUBLIC_APP_URL
    ?? process.env.VERCEL_PROJECT_PRODUCTION_URL
    ?? process.env.VERCEL_URL
  if (!base) return null
  return (base.startsWith('http') ? base : `https://${base}`).replace(/\/$/, '')
}

export async function kickCron(worker: CronWorker): Promise<void> {
  const secret = process.env.CRON_SECRET
  const base = cronBaseUrl()
  if (!secret || !base) return // not configured (e.g. local dev): the daily tick handles it
  try {
    await fetch(`${base}/api/cron/${worker}`, {
      headers: { authorization: `Bearer ${secret}` },
      // We just need to trigger the invocation; abort our own wait quickly so the caller isn't
      // blocked on the worker's full run. The worker keeps running.
      signal: AbortSignal.timeout(1500),
    })
  } catch {
    // Aborted (expected) or unreachable: the daily tick will pick it up.
  }
}
