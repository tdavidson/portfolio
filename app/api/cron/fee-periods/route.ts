import { NextRequest, NextResponse } from 'next/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { postDueFeePeriods } from '@/lib/accounting/fee-periods'
import { cronAuthDenial } from '@/lib/security/cron-auth'

export const maxDuration = 300

/**
 * Books and invoices the management fee periods that fell due, for every vehicle whose fee schedule
 * posts on its own (postMode 'draft' or 'post'; lib/accounting/fee-periods.ts). Started by the daily
 * /api/cron/tick only when such a vehicle exists. Errors stay on each period (last_error), where the
 * schedule shows them.
 *
 * Auth: `Authorization: Bearer ${CRON_SECRET}`.
 */
export async function GET(req: NextRequest) {
  const denied = cronAuthDenial(req)
  if (denied) return denied
  const out = await postDueFeePeriods(createAdminClient(), new Date().toISOString().slice(0, 10))
  return NextResponse.json({ ok: true, ...out })
}
