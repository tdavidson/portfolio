import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { assertWriteAccess } from '@/lib/api-helpers'
import { outcomeResponse } from '@/lib/service-outcome'
import { resendInvite } from '@/lib/lps/portal-access'

/**
 * Admin-only: re-send an LP's invite.
 *
 *   POST { lp_account_id } → email the welcome link again to an invited (not yet active) account
 *   linked to this fund, through the same helper as the first invite. With an outbound provider
 *   configured that is the fund's own email; without one, Supabase's invite, which cannot re-send
 *   to an address it already knows and says so. Logged to lp_deliveries either way.
 *   (lib/lps/portal-access.ts, shared with lp_portal_resend_invite.)
 */
export async function POST(req: NextRequest): Promise<NextResponse> {
  const supabase = await createClient()
  const admin = createAdminClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  const writeCheck = await assertWriteAccess(admin, user.id)
  if (writeCheck instanceof NextResponse) return writeCheck
  if (writeCheck.role !== 'admin') return NextResponse.json({ error: 'Admin access required' }, { status: 403 })

  const body = await req.json().catch(() => ({}))
  const lpAccountId = typeof body.lp_account_id === 'string' ? body.lp_account_id : ''
  return outcomeResponse(await resendInvite(admin, { fundId: writeCheck.fundId, userId: user.id }, lpAccountId))
}
