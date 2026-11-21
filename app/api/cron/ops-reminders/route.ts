import { NextRequest, NextResponse } from 'next/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { runFundReminders, type FundRunResult } from '@/lib/reminders/run'
import { sweepOrphanedUploads } from '@/lib/lp-onboarding-sweep'
import { cronAuthDenial } from '@/lib/security/cron-auth'

/**
 * Daily operational reminders (compliance filings, the quarterly data request, data-request
 * follow-ups) for every fund that turned them on. Started by the daily /api/cron/tick.
 * Idempotent within a day: reminder_deliveries means a re-run sends nothing new.
 *
 * Auth: `Authorization: Bearer ${CRON_SECRET}`.
 */
export async function GET(req: NextRequest) {
  // Fail-closed: missing CRON_SECRET refuses traffic rather than opening the loop to anyone.
  const denied = cronAuthDenial(req)
  if (denied) return denied

  const admin = createAdminClient()
  const { data: funds } = await (admin as any)
    .from('fund_settings')
    .select('fund_id')
    .eq('reminders_enabled', true) as { data: { fund_id: string }[] | null }

  const results: FundRunResult[] = []
  for (const { fund_id } of funds ?? []) {
    try {
      results.push(await runFundReminders(admin, fund_id))
      // Uploads nobody finished with — abandoned sorter batches, LP uploads that never recorded.
      await sweepOrphanedUploads(admin, fund_id)
    } catch (err) {
      // One fund failing must not stop the others.
      results.push({ fundId: fund_id, items: 0, newKeys: 0, sent: false, error: err instanceof Error ? err.message : 'failed' })
    }
  }

  return NextResponse.json({ ok: true, results })
}
