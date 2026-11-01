import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { assertAdminAccess } from '@/lib/api-helpers'

/**
 * Whether this fund's members may link their sign-in with sign-ins they hold in other funds on this
 * deployment (lib/account-links.ts), and which of them have. Admin only.
 *
 *   GET                 { allow, linked: [{ userId, email }] }
 *   PUT { allow }
 *
 * Turning it off takes this fund out of every linked connection at once, and gives this fund's own
 * members' connections no linked funds; nothing is deleted, so turning it back on restores them.
 */

async function ctx() {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return { error: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }) }
  const admin = createAdminClient()
  const gate = await assertAdminAccess(admin, user.id)
  if (gate instanceof NextResponse) return { error: gate }
  return { admin: admin as any, fundId: gate.fundId }
}

export async function GET() {
  const c = await ctx()
  if ('error' in c) return c.error
  const [{ data: s }, { data: ms }] = await Promise.all([
    c.admin.from('fund_settings').select('allow_linked_sign_ins').eq('fund_id', c.fundId).maybeSingle(),
    c.admin.from('fund_members').select('user_id').eq('fund_id', c.fundId),
  ])
  const ids = ((ms ?? []) as { user_id: string }[]).map(m => m.user_id)
  const { data: links } = ids.length ? await c.admin.from('account_links').select('user_id').in('user_id', ids) : { data: [] }
  const linked = await Promise.all(((links ?? []) as { user_id: string }[]).map(async l => {
    const { data } = await c.admin.auth.admin.getUserById(l.user_id)
    return { userId: l.user_id, email: data?.user?.email ?? null }
  }))
  return NextResponse.json({ allow: s?.allow_linked_sign_ins !== false, linked })
}

export async function PUT(req: NextRequest) {
  const c = await ctx()
  if ('error' in c) return c.error
  const body = await req.json().catch(() => ({}))
  if (typeof body?.allow !== 'boolean') return NextResponse.json({ error: 'allow must be true or false' }, { status: 400 })
  const { error } = await c.admin.from('fund_settings').update({ allow_linked_sign_ins: body.allow }).eq('fund_id', c.fundId)
  if (error) {
    console.error('[linked-sign-ins] update failed:', error.message)
    return NextResponse.json({ error: 'An unexpected error occurred.' }, { status: 500 })
  }
  return NextResponse.json({ allow: body.allow })
}
