// Nudge the memo-agent worker to start draining the job queue NOW. See lib/cron/kick.ts: the
// daily /api/cron/tick is the safety net that guarantees jobs still run if a kick is lost.
import { kickCron } from '@/lib/cron/kick'

export async function kickWorker(): Promise<void> {
  await kickCron('memo-agent-worker')
}
