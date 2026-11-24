import { NextRequest, NextResponse } from 'next/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { runDueRecurringEntries } from '@/lib/accounting/recurring-entries'
import { cronAuthDenial } from '@/lib/security/cron-auth'

export const maxDuration = 300

/**
 * Books the recurring journal entries set to draft or post (lib/accounting/recurring-entries.ts):
 * each due date from the day the mode was set through today that has nothing booked yet. Started by
 * the daily /api/cron/tick only when such an entry exists. Fee spreads run with the fee periods
 * (app/api/cron/fee-periods), not here. Errors stay on each entry (last_error).
 *
 * Auth: `Authorization: Bearer ${CRON_SECRET}`.
 */
export async function GET(req: NextRequest) {
  const denied = cronAuthDenial(req)
  if (denied) return denied
  const out = await runDueRecurringEntries(createAdminClient(), new Date().toISOString().slice(0, 10), 'fixed')
  return NextResponse.json({ ok: true, ...out })
}
