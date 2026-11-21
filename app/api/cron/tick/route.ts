import { NextRequest, NextResponse } from 'next/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { dueWorkers, type TickScope } from '@/lib/cron/dispatch'
import { kickCron } from '@/lib/cron/kick'
import { cronAuthDenial } from '@/lib/security/cron-auth'

export const maxDuration = 60

/**
 * The one scheduled entry point (vercel.json runs it once a day, which fits Vercel's Hobby plan).
 * It reads which optional features are in use and have work (lib/cron/dispatch.ts) and starts only
 * those workers, each on its own function budget. Nothing runs for a feature that is off.
 *
 * `?scope=queues` checks only the queue safety nets (memo jobs, OCR, deal research, backfills) and
 * never the once-a-day jobs, so a host that allows it can schedule that path as often as it likes.
 *
 * Auth: `Authorization: Bearer ${CRON_SECRET}`.
 */
export async function GET(req: NextRequest) {
  const denied = cronAuthDenial(req)
  if (denied) return denied

  const scope: TickScope = req.nextUrl.searchParams.get('scope') === 'queues' ? 'queues' : 'all'
  const workers = await dueWorkers(createAdminClient() as any, { scope })
  await Promise.all(workers.map(w => kickCron(w)))
  return NextResponse.json({ ok: true, scope, started: workers })
}
