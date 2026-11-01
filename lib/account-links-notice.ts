// The emails a linked sign-in sends (lib/account-links.ts): one to each address involved, each time
// a link is asked for, made or undone, so a link made by someone reading a code off another
// person's screen does not go unnoticed. Sent through each address's own fund's system email; a fund
// with none configured just logs. Best effort: a failed send never undoes the link.

import type { SupabaseClient } from '@supabase/supabase-js'
import { getOutboundConfig, sendOutboundEmail } from '@/lib/email'

const esc = (s: string) => s.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!))

export type LinkNoticeKind = 'requested' | 'linked' | 'unlinked'

async function who(admin: SupabaseClient, userId: string): Promise<{ email: string | null; fundId: string | null; fundName: string | null }> {
  const db = admin as any
  const [{ data: u }, { data: m }] = await Promise.all([
    admin.auth.admin.getUserById(userId),
    db.from('fund_members').select('fund_id').eq('user_id', userId).maybeSingle(),
  ])
  const { data: f } = m?.fund_id ? await db.from('funds').select('name').eq('id', m.fund_id).maybeSingle() : { data: null }
  return { email: u?.user?.email ?? null, fundId: m?.fund_id ?? null, fundName: f?.name ?? null }
}

/** Email both sign-ins of a link about what just happened to it. */
export async function sendLinkNotice(admin: SupabaseClient, kind: LinkNoticeKind, a: string, b: string): Promise<void> {
  try {
    const [pa, pb] = await Promise.all([who(admin, a), who(admin, b)])
    const site = process.env.NEXT_PUBLIC_SITE_URL || process.env.NEXT_PUBLIC_APP_URL || ''
    for (const [me, other] of [[pa, pb], [pb, pa]] as const) {
      if (!me.email || !me.fundId) continue
      const config = await getOutboundConfig(admin, me.fundId)
      if (!config) { console.warn('[account-links] no system email configured; link notice not sent'); continue }
      const them = `${other.email ?? 'another sign-in'}${other.fundName ? ` (${other.fundName})` : ''}`
      const subject = kind === 'requested' ? 'A request to link your sign-in'
        : kind === 'linked' ? 'Your sign-in was linked' : 'Your sign-in was unlinked'
      const line = kind === 'requested'
        ? `A link code shown to one of these sign-ins was entered by the other: ${esc(them)}. Nothing is linked until the sign-in that showed the code confirms it.`
        : kind === 'linked'
          ? `Your sign-in is now linked with ${esc(them)}. An assistant connection made with either can now work in both funds, as each fund's own member.`
          : `Your sign-in is no longer linked with ${esc(them)}.`
      const html = `<p>${line}</p><p>If this wasn't you, unlink it under Settings, Account${site ? ` at ${esc(site)}` : ''}, and tell your fund's admin.</p>`
      await sendOutboundEmail(config, { to: me.email, subject, html })
    }
  } catch (e) {
    console.error('[account-links] link notice failed:', (e as Error).message)
  }
}
