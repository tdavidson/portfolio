import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { outcomeResponse } from '@/lib/service-outcome'
import { logActivity } from '@/lib/activity'
import { createLinkCode, fundAllowsLinking, linkedSignIns, redeemLinkCode, unlinkSignIn } from '@/lib/account-links'

/**
 * This person's linked sign-ins (lib/account-links.ts): the sign-ins they hold in other funds on
 * this deployment, linked so one assistant connection can switch between those funds.
 *
 *   GET                              { links: LinkedSignIn[], allowed }
 *   POST { action: 'code' }          → { code, expiresAt }: enter it while signed in as the other one
 *   POST { action: 'link', code }    → { linked }
 *   DELETE                           → take this sign-in out of its links
 *
 * The caller's own links only. Level 'any' in route-domains.ts: it serves a user their own data.
 */

async function ctx() {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return { error: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }) }
  const admin = createAdminClient()
  const { data: m } = await admin.from('fund_members').select('fund_id').eq('user_id', user.id).maybeSingle()
  if (!m) return { error: NextResponse.json({ error: 'No fund found' }, { status: 403 }) }
  return { admin, userId: user.id, fundId: (m as { fund_id: string }).fund_id }
}

export async function GET() {
  const c = await ctx()
  if ('error' in c) return c.error
  const [links, allowed] = await Promise.all([linkedSignIns(c.admin, c.userId), fundAllowsLinking(c.admin, c.fundId)])
  return NextResponse.json({ links, allowed })
}

export async function POST(req: NextRequest) {
  const c = await ctx()
  if ('error' in c) return c.error
  const body = await req.json().catch(() => ({}))
  if (body?.action === 'code') return outcomeResponse(await createLinkCode(c.admin, c.userId))
  if (body?.action === 'link') {
    const out = await redeemLinkCode(c.admin, c.userId, body.code)
    if (out.ok) void logActivity(c.admin as any, c.fundId, c.userId, 'account.link', { linked: out.value.linked })
    return outcomeResponse(out)
  }
  return NextResponse.json({ error: "action must be 'code' or 'link'" }, { status: 400 })
}

export async function DELETE() {
  const c = await ctx()
  if ('error' in c) return c.error
  const out = await unlinkSignIn(c.admin, c.userId)
  if (out.ok) void logActivity(c.admin as any, c.fundId, c.userId, 'account.unlink', {})
  return outcomeResponse(out)
}
