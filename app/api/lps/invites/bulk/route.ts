import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { assertWriteAccess } from '@/lib/api-helpers'
import { outcomeResponse } from '@/lib/service-outcome'
import { bulkInvite } from '@/lib/lps/portal-access'

/**
 * Admin-only bulk LP onboarding (gap 3). Paste a sheet of investors + emails
 * (+ authorized-user emails); we match investors by name, create the ones that
 * don't exist, create/link lp_accounts, and email invites.
 *
 * POST { rows: Row[], commit: boolean }
 *   - commit:false → dry-run preview (no writes, no emails): what would happen.
 *   - commit:true  → create investors/accounts/links + send invites, batched.
 *
 * Sending is concurrency-limited so a few hundred invites don't fire all at
 * once. Every send goes through sendLpInvite (Supabase invite, then the fund's
 * outbound email as the fallback) and is logged; an address that could not be
 * emailed is listed in `failed` with the reason, and can be resent from the
 * accounts table on the LP Portal page. Supabase's built-in mailer allows only
 * a handful of emails an hour, so a fund without custom SMTP or an outbound
 * provider will see most of a large sheet land here.
 *
 * The logic is bulkInvite (lib/lps/portal-access.ts), shared with lp_portal_invite_bulk.
 */
export async function POST(req: NextRequest) {
  const supabase = await createClient()
  const admin = createAdminClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const writeCheck = await assertWriteAccess(admin, user.id)
  if (writeCheck instanceof NextResponse) return writeCheck
  if (writeCheck.role !== 'admin') return NextResponse.json({ error: 'Admin access required' }, { status: 403 })

  const body = await req.json().catch(() => ({}))
  return outcomeResponse(await bulkInvite(admin, { fundId: writeCheck.fundId, userId: user.id }, body.rows, !!body.commit))
}
