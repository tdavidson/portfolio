import { NextRequest, NextResponse } from 'next/server'
import { randomUUID } from 'node:crypto'
import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
// lp_relations domain (lib/access/route-domains.ts). The middleware has already checked the grant.
import { assertWriteAccess } from '@/lib/api-helpers'
import { getOutboundConfig, sendOutboundEmail } from '@/lib/email'
import { resolveLpRecipients } from '@/lib/lp-recipients'
import { buildLpEmailHtml, siteUrl } from '@/lib/lp-email'
import { logDelivery } from '@/lib/lp-deliveries'
import { runPool } from '@/lib/lp-report-pdf'
import { loadLpScope, lpVisible } from '@/lib/access/lp-scope'

// An announcement: a message to chosen LPs (or all of them) with nothing attached to it.
//
//   POST { subject, body, lp_investor_ids?: string[] | 'all', preview?: boolean }
//
// Every other LP email hangs off an item — a statement, a letter, a document. This is the plain
// message: a close, a change of address, a heads-up before a call. It goes out through the same
// recipient resolution (the investor's account To, their authorized users Cc), is recorded as an
// outbound message per investor so the portal shows it, and is logged per send. `preview`
// returns the exact addresses without sending.
export async function POST(req: NextRequest) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  const admin = createAdminClient() as any
  const access = await assertWriteAccess(admin, user.id)
  if (access instanceof NextResponse) return access
  const fundId = access.fundId

  const body = await req.json().catch(() => ({}))
  const subject = typeof body.subject === 'string' ? body.subject.trim().slice(0, 200) : ''
  const text = typeof body.body === 'string' ? body.body.trim().slice(0, 20_000) : ''
  if (!subject) return NextResponse.json({ error: 'A subject is required' }, { status: 400 })
  if (!text) return NextResponse.json({ error: 'A message is required' }, { status: 400 })

  let investorIds: string[]
  if (body.lp_investor_ids === 'all' || body.lp_investor_ids == null) {
    const { data: invs } = await admin.from('lp_investors').select('id').eq('fund_id', fundId)
    investorIds = ((invs ?? []) as { id: string }[]).map(i => i.id)
  } else if (Array.isArray(body.lp_investor_ids)) {
    const requested = body.lp_investor_ids.filter((x: unknown): x is string => typeof x === 'string')
    const { data: invs } = await admin.from('lp_investors').select('id').eq('fund_id', fundId).in('id', requested)
    investorIds = ((invs ?? []) as { id: string }[]).map(i => i.id)
  } else {
    return NextResponse.json({ error: 'lp_investor_ids must be a list or "all"' }, { status: 400 })
  }
  // Only investors the caller can see — "all" means all of theirs.
  const lp = await loadLpScope(admin, access)
  investorIds = investorIds.filter(id => lpVisible(lp.investorIds, id))
  if (investorIds.length === 0) return NextResponse.json({ error: 'No investors selected' }, { status: 400 })

  const groups = await resolveLpRecipients(admin, fundId, investorIds)
  if (groups.length === 0) {
    return NextResponse.json({ error: 'None of the selected LPs have portal accounts yet. Invite them from LP Portal → Access.' }, { status: 400 })
  }
  const { data: fund } = await admin.from('funds').select('name').eq('id', fundId).maybeSingle()
  const fundName = (fund?.name as string | undefined) || 'Your fund'
  const { data: fs } = await admin.from('fund_settings').select('lp_portal_enabled').eq('fund_id', fundId).maybeSingle()
  const html = buildLpEmailHtml({
    fundName, itemTitle: subject, message: text,
    link: fs?.lp_portal_enabled ? `${siteUrl()}/portal/contact` : null, linkLabel: 'Reply in your portal',
  })
  const fullSubject = `${fundName}: ${subject}`

  if (body.preview === true) {
    return NextResponse.json({
      preview: true, subject: fullSubject, html,
      recipients: groups.map(g => ({ to: g.primaryEmail, name: g.primaryName, cc: g.ccEmails, investorCount: g.investorIds.length })),
      // Investors selected but with nobody to email.
      unreachable: investorIds.length - groups.reduce((n, g) => n + g.investorIds.length, 0),
    })
  }

  const config = await getOutboundConfig(admin, fundId)
  if (!config) return NextResponse.json({ error: 'No outbound email provider is configured for this fund.' }, { status: 400 })

  const announcementId = randomUUID()
  const summary = { sent: 0, primaryRecipients: groups.length, ccRecipients: groups.reduce((a, g) => a + g.ccEmails.length, 0), failures: [] as string[] }

  await runPool(groups, 3, async g => {
    // The message exists in each investor's portal whether or not the email lands.
    const rows = g.investorIds.map(investorId => ({
      fund_id: fundId, lp_account_id: g.primaryAccountId, lp_investor_id: investorId, from_email: null,
      subject, body: text, status: 'resolved', direction: 'outbound', announcement_id: announcementId, sent_by: user.id,
    }))
    const { data: inserted } = await admin.from('lp_messages').insert(rows).select('id, lp_investor_id')
    const itemIdByInvestor = new Map<string, string>(((inserted ?? []) as any[]).map(r => [r.lp_investor_id, r.id]))
    try {
      const sent = await sendOutboundEmail(config, { to: g.primaryEmail, cc: g.ccEmails.length ? g.ccEmails.join(', ') : undefined, subject: fullSubject, html })
      summary.sent += 1
      for (const investorId of g.investorIds) {
        await logDelivery(admin, { fundId, kind: 'announcement', itemId: itemIdByInvestor.get(investorId) ?? null, lpInvestorId: investorId, toEmail: g.primaryEmail, ccEmails: g.ccEmails, subject: fullSubject, provider: config.provider, providerMessageId: sent.id ?? null, sentBy: user.id })
      }
    } catch (e) {
      const msg = (e as Error)?.message ?? 'send failed'
      summary.failures.push(g.primaryEmail)
      for (const investorId of g.investorIds) {
        await logDelivery(admin, { fundId, kind: 'announcement', itemId: itemIdByInvestor.get(investorId) ?? null, lpInvestorId: investorId, toEmail: g.primaryEmail, ccEmails: g.ccEmails, subject: fullSubject, provider: config.provider, status: 'failed', error: msg, sentBy: user.id })
      }
    }
  })

  return NextResponse.json({ ok: true, announcementId, ...summary })
}
