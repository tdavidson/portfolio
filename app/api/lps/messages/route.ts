import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
// lp_relations domain (lib/access/route-domains.ts). The middleware has already checked the grant.
import { assertReadAccess, assertWriteAccess } from '@/lib/api-helpers'
import { dbError } from '@/lib/api-error'
import { getOutboundConfig, sendOutboundEmail } from '@/lib/email'
import { resolveLpRecipients } from '@/lib/lp-recipients'
import { buildLpEmailHtml, siteUrl } from '@/lib/lp-email'
import { logDelivery } from '@/lib/lp-deliveries'
import { loadLpScope, lpVisible } from '@/lib/access/lp-scope'

// The GP's LP message inbox — threads started by LPs from their portal's Contact form, and the
// fund's replies to them.
//
//   GET                            → every message, newest first, with its replies nested
//   POST  { replyTo, body }        → reply to an inbound message: emails the LP (Cc their
//                                    authorized users), records the outbound row, resolves the thread
//   PATCH { id, status }           → open / resolved

export async function GET() {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  const admin = createAdminClient() as any
  const access = await assertReadAccess(admin, user.id)
  if (access instanceof NextResponse) return access
  const { data } = await admin
    .from('lp_messages')
    .select('id, from_email, subject, body, status, created_at, direction, parent_id, announcement_id, lp_investor_id, lp_investors(name)')
    .eq('fund_id', access.fundId)
    .order('created_at', { ascending: false })
    .limit(500)
  // Only messages from or to investors the caller can see.
  const lp = await loadLpScope(admin, access)
  const rows = ((data ?? []) as any[]).filter(r => lpVisible(lp.investorIds, r.lp_investor_id))
  const repliesByParent = new Map<string, any[]>()
  for (const r of rows) {
    if (r.direction === 'outbound' && r.parent_id) {
      repliesByParent.set(r.parent_id, [...(repliesByParent.get(r.parent_id) ?? []), r])
    }
  }
  const shape = (r: any) => ({
    id: r.id,
    from_email: r.from_email,
    subject: r.subject,
    body: r.body,
    status: r.status,
    created_at: r.created_at,
    direction: r.direction ?? 'inbound',
    investor_id: r.lp_investor_id ?? null,
    investor_name: r.lp_investors?.name ?? null,
  })
  // Inbound threads, each with its replies oldest first; announcements are listed separately
  // (one row per investor collapses to one card per announcement).
  const messages = rows.filter(r => r.direction !== 'outbound').map(r => ({
    ...shape(r),
    replies: (repliesByParent.get(r.id) ?? []).slice().reverse().map(shape),
  }))
  const seen = new Set<string>()
  const announcements: any[] = []
  for (const r of rows) {
    if (r.direction !== 'outbound' || !r.announcement_id || seen.has(r.announcement_id)) continue
    seen.add(r.announcement_id)
    const group = rows.filter(x => x.announcement_id === r.announcement_id)
    announcements.push({ ...shape(r), announcement_id: r.announcement_id, recipients: group.length, investor_names: group.map(x => x.lp_investors?.name).filter(Boolean) })
  }
  return NextResponse.json({ messages, announcements })
}

export async function POST(req: NextRequest) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  const admin = createAdminClient() as any
  const access = await assertWriteAccess(admin, user.id)
  if (access instanceof NextResponse) return access
  const fundId = access.fundId

  const body = await req.json().catch(() => ({}))
  const replyTo = typeof body.replyTo === 'string' ? body.replyTo : ''
  const text = typeof body.body === 'string' ? body.body.trim().slice(0, 10_000) : ''
  if (!replyTo) return NextResponse.json({ error: 'replyTo is required' }, { status: 400 })
  if (!text) return NextResponse.json({ error: 'A reply needs a body' }, { status: 400 })

  const { data: original } = await admin
    .from('lp_messages').select('id, fund_id, subject, from_email, lp_investor_id, lp_account_id, direction')
    .eq('id', replyTo).eq('fund_id', fundId).maybeSingle()
  const replyScope = await loadLpScope(admin, access)
  if (!original || !lpVisible(replyScope.investorIds, (original as any).lp_investor_id)) return NextResponse.json({ error: 'Message not found' }, { status: 404 })
  if (original.direction === 'outbound') return NextResponse.json({ error: 'Reply to the LP’s message, not to a reply' }, { status: 400 })

  // Who to email: the investor's portal account (and its authorized users), falling back to the
  // address the message came from when the investor has no account any more.
  const groups = original.lp_investor_id ? await resolveLpRecipients(admin, fundId, [original.lp_investor_id]) : []
  const to = groups[0]?.primaryEmail ?? original.from_email ?? null
  const cc = groups[0]?.ccEmails ?? []
  if (!to) return NextResponse.json({ error: 'This LP has no email address to reply to' }, { status: 400 })

  const config = await getOutboundConfig(admin, fundId)
  if (!config) return NextResponse.json({ error: 'No outbound email provider is configured for this fund.' }, { status: 400 })
  const { data: fund } = await admin.from('funds').select('name').eq('id', fundId).maybeSingle()
  const fundName = (fund?.name as string | undefined) || 'Your fund'
  const subject = original.subject ? `Re: ${original.subject}` : `Re: your message to ${fundName}`

  const { data: fs } = await admin.from('fund_settings').select('lp_portal_enabled').eq('fund_id', fundId).maybeSingle()
  const html = buildLpEmailHtml({
    fundName, itemTitle: subject, message: text,
    link: fs?.lp_portal_enabled ? `${siteUrl()}/portal/contact` : null, linkLabel: 'Reply in your portal',
  })

  // Record first: the reply exists in the portal even if the email fails, and the delivery log
  // says whether it did.
  const { data: row, error } = await admin.from('lp_messages').insert({
    fund_id: fundId,
    lp_account_id: original.lp_account_id ?? null,
    lp_investor_id: original.lp_investor_id ?? null,
    from_email: null,
    subject,
    body: text,
    status: 'resolved',
    direction: 'outbound',
    parent_id: original.id,
    sent_by: user.id,
  }).select('id').single()
  if (error) return dbError(error, 'lps-messages-reply')
  await admin.from('lp_messages').update({ status: 'resolved' }).eq('id', original.id).eq('fund_id', fundId)

  let emailed = false
  let emailError: string | null = null
  try {
    const sent = await sendOutboundEmail(config, { to, cc: cc.length ? cc.join(', ') : undefined, subject, html })
    emailed = true
    await logDelivery(admin, { fundId, kind: 'reply', itemId: row.id, lpInvestorId: original.lp_investor_id ?? null, toEmail: to, ccEmails: cc, subject, provider: config.provider, providerMessageId: sent.id ?? null, sentBy: user.id })
  } catch (e) {
    emailError = (e as Error)?.message ?? 'send failed'
    await logDelivery(admin, { fundId, kind: 'reply', itemId: row.id, lpInvestorId: original.lp_investor_id ?? null, toEmail: to, ccEmails: cc, subject, provider: config.provider, status: 'failed', error: emailError, sentBy: user.id })
  }
  return NextResponse.json({ ok: true, id: row.id, emailed, emailError, to, cc })
}

export async function PATCH(req: NextRequest) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  const admin = createAdminClient() as any
  const access = await assertWriteAccess(admin, user.id)
  if (access instanceof NextResponse) return access
  const body = await req.json().catch(() => ({}))
  const id = typeof body.id === 'string' ? body.id : ''
  const status = body.status === 'resolved' ? 'resolved' : 'open'
  if (!id) return NextResponse.json({ error: 'id required' }, { status: 400 })
  // Only a message from or to an investor the caller can see.
  const statusScope = await loadLpScope(admin, access)
  const { data: msg } = await admin.from('lp_messages').select('lp_investor_id').eq('id', id).eq('fund_id', access.fundId).maybeSingle()
  if (!msg || !lpVisible(statusScope.investorIds, (msg as any).lp_investor_id)) return NextResponse.json({ error: 'Message not found' }, { status: 404 })
  const { error } = await admin.from('lp_messages').update({ status }).eq('id', id).eq('fund_id', access.fundId)
  if (error) return dbError(error, 'lps-messages')
  return NextResponse.json({ ok: true })
}
