import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { logActivity } from '@/lib/activity'
import { safeNextPath } from '@/lib/safe-redirect'
import { requestOrigin } from '@/lib/site-links'

/**
 * Post-login side effects for the OTP flows.
 *
 * Email OTP verification happens client-side (`verifyOtp`), which sets the
 * session cookies but can't run the server-side work the old link callback did.
 * After a successful verify, the client navigates here to run exactly that:
 * fund-membership lookup + login activity log, with the new-user → onboarding
 * redirect. OAuth still uses `/auth/callback` (code exchange).
 */
export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url)
  const origin = requestOrigin(request)
  // safeNextPath, not startsWith('/') && !startsWith('//') — `/\evil.example` passes that pair.
  const next = safeNextPath(searchParams.get('next')) ?? '/'
  const method = searchParams.get('method') ?? 'otp'

  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) {
    return NextResponse.redirect(`${origin}/auth?error=${encodeURIComponent('Your session expired. Please sign in again.')}`)
  }

  const admin = createAdminClient()
  const { data: membership } = await admin
    .from('fund_members')
    .select('fund_id')
    .eq('user_id', user.id)
    .maybeSingle()

  if (membership) {
    logActivity(admin, membership.fund_id, user.id, 'login', { method })
  } else if (next === '/') {
    // New user with no fund — onboarding, matching the old link callback.
    return NextResponse.redirect(`${origin}/onboarding?confirmed=true`)
  }

  return NextResponse.redirect(`${origin}${next}`)
}
