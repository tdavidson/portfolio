import { NextRequest, NextResponse } from 'next/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { endExpiredAccess } from '@/lib/access/expiry'
import { expireTag } from '@/lib/cache/tags'
import { cronAuthDenial } from '@/lib/security/cron-auth'

/**
 * Removes memberships whose end date has passed (fund_members.access_expires_at). Their access
 * already stopped resolving the moment the date passed (access_context); this closes the rest.
 * Started by the daily /api/cron/tick when a membership has passed its end date.
 *
 * Auth: `Authorization: Bearer ${CRON_SECRET}`.
 */
export async function GET(req: NextRequest) {
  const denied = cronAuthDenial(req)
  if (denied) return denied

  const ended = await endExpiredAccess(createAdminClient())
  if (ended.length > 0) expireTag('membership')
  return NextResponse.json({ ok: true, ended: ended.length })
}
