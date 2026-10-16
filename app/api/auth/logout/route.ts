import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { logActivity } from '@/lib/activity'
import { safeNextPath } from '@/lib/safe-redirect'

export async function POST(req: Request) {
  // "Switch account" posts here too: one email is one fund, so switching funds is signing out and
  // back in as the other address. It lands on the sign-in page with the recent accounts offered,
  // carrying `next` along when the switch started mid-flow (the agent consent screen).
  const form = await req.formData().catch(() => null)
  const switching = form?.get('switch') === '1'
  const next = safeNextPath(typeof form?.get('next') === 'string' ? (form.get('next') as string) : null)

  const supabase = await createClient()

  const { data: { user } } = await supabase.auth.getUser()
  if (user) {
    const admin = createAdminClient()
    const { data: membership } = await admin
      .from('fund_members')
      .select('fund_id')
      .eq('user_id', user.id)
      .maybeSingle()
    if (membership) {
      logActivity(admin, membership.fund_id, user.id, 'logout')
    }
  }

  await supabase.auth.signOut()

  // Use request origin so redirect stays on the same URL (preview, production, etc.)
  const origin = new URL(req.url).origin
  const target = new URL('/auth', origin)
  if (switching) target.searchParams.set('switch', '1')
  if (next) target.searchParams.set('next', next)
  // 303, not the default 307: a 307 would re-POST to /auth, which is a page.
  return NextResponse.redirect(target, 303)
}
