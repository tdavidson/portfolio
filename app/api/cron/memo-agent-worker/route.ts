import { NextRequest, NextResponse } from 'next/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { isAwaitingCallback } from '@/lib/memo-agent/jobs/transcribe-job'
import { AWAITING_ASSISTANT_JOB, MODEL_JOB_KINDS, runJobHandler, type MemoJob } from '@/lib/memo-agent/jobs/dispatch'
import { ASSISTANT_RUNNER } from '@/lib/memo-agent/assistant-runner'
import { fundHasAIKey } from '@/lib/ai/keyless'
import { kickWorker } from '@/lib/memo-agent/kick'
import { cronAuthDenial } from '@/lib/security/cron-auth'

/**
 * Memo Agent worker. Started whenever a job is enqueued (lib/memo-agent/kick.ts), and by the daily
 * /api/cron/tick as a safety net when jobs are pending or stuck. Claims one pending job from
 * `memo_agent_jobs`, dispatches it to the right stage handler, and writes
 * the outcome back. Designed to fit comfortably inside a 120s function
 * — long stages must internally chunk to that ceiling.
 *
 * Auth: same `Authorization: Bearer ${CRON_SECRET}` pattern as the
 * deals-digest cron.
 */
export async function GET(req: NextRequest) {
  // Fail-closed: an unset CRON_SECRET means the endpoint refuses traffic.
  // The prior "if cronSecret then check" pattern silently opened the worker
  // to anonymous callers in any environment where the env var wasn't set
  // (PR previews, staging, misconfigured prod).
  const denied = cronAuthDenial(req)
  if (denied) return denied

  const admin = createAdminClient()

  // Self-heal: any job stuck in `running` past the function ceiling was killed
  // by Vercel mid-stage and will never finish on its own. Fail them so the UI
  // unblocks and the user can retry without manual DB edits. The cutoff has to
  // be at least the worker's maxDuration (300s in vercel.json) plus headroom,
  // or we'll kill jobs that are still alive — 6m gives a clean buffer.
  // Transcribe jobs with an external_job_id are legitimately awaiting a
  // provider callback and can take much longer than a Vercel function — they
  // get a separate, looser timeout below.
  const STALE_RUNNING_MS = 6 * 60 * 1000
  const staleCutoff = new Date(Date.now() - STALE_RUNNING_MS).toISOString()
  await admin
    .from('memo_agent_jobs')
    .update({
      status: 'failed',
      error: 'killed: worker timed out (no progress for >6m)',
      finished_at: new Date().toISOString(),
      progress_message: 'killed: timeout',
    } as any)
    .eq('status', 'running')
    .is('external_job_id', null)
    .lt('started_at', staleCutoff)

  // Transcribe jobs stuck awaiting an external callback for >1h are presumed
  // lost (Deepgram didn't call back, our webhook 500'd, etc).
  const STALE_CALLBACK_MS = 60 * 60 * 1000
  const callbackCutoff = new Date(Date.now() - STALE_CALLBACK_MS).toISOString()
  await admin
    .from('memo_agent_jobs')
    .update({
      status: 'failed',
      error: 'killed: external callback never arrived (>1h)',
      finished_at: new Date().toISOString(),
      progress_message: 'killed: callback timeout',
    } as any)
    .eq('status', 'running')
    .not('external_job_id', 'is', null)
    // A job waiting for the person's assistant waits as long as it takes.
    .neq('external_job_id', ASSISTANT_RUNNER)
    .lt('started_at', callbackCutoff)

  // Drain the queue: process jobs back-to-back until it's empty or we approach
  // the function's time ceiling. Because each stage enqueues the next, this
  // chains a whole memo pipeline in one invocation instead of one stage per cron
  // tick. The budget leaves headroom below the 300s maxDuration for one more
  // in-flight job; if we stop with jobs still pending, we hand off to a fresh
  // invocation so the queue keeps draining without waiting for the cron.
  const DRAIN_BUDGET_MS = 120_000
  const startedAt = Date.now()
  let processed = 0

  while (Date.now() - startedAt < DRAIN_BUDGET_MS) {
    const { data: claimed, error: claimErr } = await (admin as any)
      .rpc('memo_agent_claim_next_job') as { data: any; error: any }
    if (claimErr) {
      console.error('[memo-agent-worker] claim error:', claimErr)
      return NextResponse.json({ error: 'An unexpected error occurred.', processed }, { status: 500 })
    }
    if (!claimed || !claimed.id) {
      // Queue empty — nothing left to do.
      return NextResponse.json({ ok: true, idle: processed === 0, processed })
    }
    await processJob(admin, claimed as Job)
    processed++
  }

  // Time budget hit with jobs likely still pending — kick a fresh invocation to
  // continue the drain immediately rather than waiting for the next cron tick.
  await kickWorker()
  return NextResponse.json({ ok: true, processed, handedOff: true })
}

type Job = MemoJob

/** Run one claimed job and write its outcome back. Never throws. */
async function processJob(admin: ReturnType<typeof createAdminClient>, job: Job): Promise<void> {
  console.log(`[memo-agent-worker] claimed ${job.kind} job ${job.id} (deal ${job.deal_id})`)
  try {
    // No key: hand the job to the person's assistant instead of failing it. It stays `running`, so
    // the deal page shows it in flight with this message, and nothing else starts on the deal.
    if (MODEL_JOB_KINDS.has(job.kind) && !(await fundHasAIKey(admin, job.fund_id))) {
      await admin
        .from('memo_agent_jobs')
        .update({ external_job_id: ASSISTANT_RUNNER, progress_message: AWAITING_ASSISTANT_JOB } as any)
        .eq('id', job.id)
      return
    }

    const result = await runJobHandler(admin, job)

    // Async jobs that handed work to an external provider stay `running` until
    // the provider's webhook finishes them — leave their status untouched.
    if (isAwaitingCallback(result)) return

    await admin
      .from('memo_agent_jobs')
      .update({
        status: 'success',
        result: result as any,
        finished_at: new Date().toISOString(),
        progress_message: 'completed',
      })
      .eq('id', job.id)
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    console.error(`[memo-agent-worker] ${job.kind} job ${job.id} failed:`, err)
    await markFailed(admin, job.id, message)
  }
}

async function markFailed(admin: ReturnType<typeof createAdminClient>, id: string, error: string) {
  await admin
    .from('memo_agent_jobs')
    .update({
      status: 'failed',
      error,
      finished_at: new Date().toISOString(),
      progress_message: 'failed',
    })
    .eq('id', id)
}
