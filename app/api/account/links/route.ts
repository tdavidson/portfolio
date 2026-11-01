import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { outcomeResponse } from '@/lib/service-outcome'
import { logActivity } from '@/lib/activity'
import { confirmLinkRequest, createLinkCode, declineLinkRequest, fundAllowsLinking, linkedSignIns, pendingLinkRequest, redeemLinkCode, unlinkSignIn } from '@/lib/account-links'
import { sendLinkNotice } from '@/lib/account-links-notice'
import { getClientIp, rateLimit } from '@/lib/rate-limit'

/**
 * This person's linked sign-ins (lib/account-links.ts): the sign-ins they hold in other funds on
 * this deployment, linked so one assistant connection can switch between those funds.
 *
 *   GET                              { links: LinkedSignIn[], allowed, pending }
 *   POST { action: 'code' }          → { code, expiresAt }: enter it while signed in as the other one
 *   POST { action: 'link', code }    → { pending: true }: the sign-in that showed the code confirms
 *   POST { action: 'confirm' }       → { linked }: from the sign-in that showed the code
 *   POST { action: 'decline' }       → the code stops working
 *   DELETE                           → take this sign-in out of its links
 *
 * Entering a code is metered per sign-in and per address, and every step emails both addresses.
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
  const [links, allowed, pending] = await Promise.all([
    linkedSignIns(c.admin, c.userId), fundAllowsLinking(c.admin, c.fundId), pendingLinkRequest(c.admin, c.userId),
  ])
  return NextResponse.json({ links, allowed, pending })
}

export async function POST(req: NextRequest) {
  const c = await ctx()
  if ('error' in c) return c.error
  const body = await req.json().catch(() => ({}))
  if (body?.action === 'code') {
    const limited = await rateLimit({ key: `account-link-code:${c.userId}`, limit: 10, windowSeconds: 600 })
    if (limited) return limited
    return outcomeResponse(await createLinkCode(c.admin, c.userId))
  }
  if (body?.action === 'link') {
    const limited = await rateLimit({ key: `account-link:${c.userId}`, limit: 10, windowSeconds: 60 })
      ?? await rateLimit({ key: `account-link-ip:${getClientIp(req)}`, limit: 30, windowSeconds: 60 })
    if (limited) return limited
    const out = await redeemLinkCode(c.admin, c.userId, body.code)
    if (out.ok) {
      void logActivity(c.admin as any, c.fundId, c.userId, 'account.link_requested', {})
      void sendLinkNotice(c.admin, 'requested', c.userId, out.value.otherUserId)
      return NextResponse.json({ pending: true })
    }
    return outcomeResponse(out)
  }
  if (body?.action === 'confirm') {
    const out = await confirmLinkRequest(c.admin, c.userId)
    if (out.ok) {
      void logActivity(c.admin as any, c.fundId, c.userId, 'account.link', { linked: out.value.linked })
      void sendLinkNotice(c.admin, 'linked', c.userId, out.value.otherUserId)
      return NextResponse.json({ linked: out.value.linked })
    }
    return outcomeResponse(out)
  }
  if (body?.action === 'decline') return outcomeResponse(await declineLinkRequest(c.admin, c.userId))
  return NextResponse.json({ error: "action must be 'code', 'link', 'confirm' or 'decline'" }, { status: 400 })
}

export async function DELETE() {
  const c = await ctx()
  if ('error' in c) return c.error
  const out = await unlinkSignIn(c.admin, c.userId)
  if (out.ok) void logActivity(c.admin as any, c.fundId, c.userId, 'account.unlink', {})
  return outcomeResponse(out)
}
