import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { logActivity } from '@/lib/activity'
import { safeNextPath } from '@/lib/safe-redirect'
import { requestOrigin } from '@/lib/site-links'

// Handles magic link, password reset, and OAuth redirects from Supabase Auth.
// Supabase appends ?code= to the redirect URL after authentication.
export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url)
  const origin = requestOrigin(request)
  const code = searchParams.get('code')
  // Prevent open redirect. Not exploitable here as it stands (origin is prepended,
  // so a stray backslash lands in the path and can't re-enter the authority) — but
  // it's the same shape as the check that WAS exploitable on /auth and
  // /auth/mfa-verify, so it uses the same validated helper rather than a lookalike
  // inline check that a future edit could lean on. See lib/safe-redirect.ts.
  const next = safeNextPath(searchParams.get('next')) ?? '/'

  if (!code) {
    return NextResponse.redirect(`${origin}/auth?error=${encodeURIComponent('Invalid or expired link. Please try again.')}`)
  }

  const supabase = await createClient()
  const { error } = await supabase.auth.exchangeCodeForSession(code)
  if (!error) {
    const { data: { user } } = await supabase.auth.getUser()
    if (user) {
      const admin = createAdminClient()
      const { data: membership } = await admin
        .from('fund_members')
        .select('fund_id')
        .eq('user_id', user.id)
        .maybeSingle()
      if (membership) {
        logActivity(admin, membership.fund_id, user.id, 'login', { method: 'magic_link' })
      } else if (next === '/') {
        // New user with no fund — send to onboarding with confirmation message
        return NextResponse.redirect(`${origin}/onboarding?confirmed=true`)
      }
    }
    return NextResponse.redirect(`${origin}${next}`)
  }

  return NextResponse.redirect(`${origin}/auth?error=${encodeURIComponent(error.message)}`)
}
