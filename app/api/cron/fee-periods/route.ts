import { NextRequest, NextResponse } from 'next/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { postDueFeePeriods } from '@/lib/accounting/fee-periods'
import { runDueRecurringEntries } from '@/lib/accounting/recurring-entries'
import { cronAuthDenial } from '@/lib/security/cron-auth'

export const maxDuration = 300

/**
 * Books and invoices the management fee periods that fell due, for every vehicle whose fee schedule
 * posts on its own (postMode 'draft' or 'post'; lib/accounting/fee-periods.ts), then books the
 * monthly fee spreads set to draft or post (recurring entries of kind management_fee_spread), in
 * that order so a month recognized on the 1st finds its quarter's bill booked. Started by the daily
 * /api/cron/tick only when there is either. Errors stay on each period or spread (last_error).
 *
 * Auth: `Authorization: Bearer ${CRON_SECRET}`.
 */
export async function GET(req: NextRequest) {
  const denied = cronAuthDenial(req)
  if (denied) return denied
  const admin = createAdminClient()
  const today = new Date().toISOString().slice(0, 10)
  const out = await postDueFeePeriods(admin, today)
  const spreads = await runDueRecurringEntries(admin, today, 'management_fee_spread')
  return NextResponse.json({ ok: true, ...out, spreads })
}
