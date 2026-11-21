import { NextRequest, NextResponse } from 'next/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { getOutboundConfig, sendOutboundEmail } from '@/lib/email'
import { cronAuthDenial } from '@/lib/security/cron-auth'

/**
 * Weekly digest of deals auto-archived as out_of_thesis. Sent to fund admins.
 * Started by the daily /api/cron/tick on Mondays (UTC) when a fund screens inbound deals.
 *
 * Auth: Vercel cron jobs invoke this endpoint with header
 * `Authorization: Bearer ${CRON_SECRET}`. Set CRON_SECRET in env.
 */
export async function GET(req: NextRequest) {
  // Fail-closed: missing CRON_SECRET refuses traffic rather than opening the
  // digest loop to anonymous callers.
  const denied = cronAuthDenial(req)
  if (denied) return denied

  const admin = createAdminClient()

  // Find every fund with deal_intake_enabled and deals archived in the last 7 days.
  const since = new Date()
  since.setDate(since.getDate() - 7)

  const { data: enabledFunds } = await admin
    .from('fund_settings')
    .select('fund_id, deal_intake_enabled')
    .eq('deal_intake_enabled', true) as { data: { fund_id: string }[] | null }

  if (!enabledFunds || enabledFunds.length === 0) {
    return NextResponse.json({ ok: true, fundsProcessed: 0 })
  }

  const results: { fund_id: string; archivedCount: number; sent: boolean; error?: string }[] = []

  for (const f of enabledFunds) {
    const fundId = f.fund_id

    const { data: deals } = await admin
      .from('inbound_deals')
      .select('id, company_name, founder_name, founder_email, thesis_fit_analysis, created_at')
      .eq('fund_id', fundId)
      .in('thesis_fit_score', ['out_of_thesis', 'spam'])
      .gte('created_at', since.toISOString())
      .order('created_at', { ascending: false })

    const archived = (deals as Array<{ id: string; company_name: string | null; founder_name: string | null; founder_email: string | null; thesis_fit_analysis: string | null; created_at: string | null }> | null) ?? []
    if (archived.length === 0) {
      results.push({ fund_id: fundId, archivedCount: 0, sent: false })
      continue
    }

    // Find admins for this fund.
    const { data: admins } = await admin
      .from('fund_members')
      .select('user_id, role')
      .eq('fund_id', fundId)
      .eq('role', 'admin')
    if (!admins || admins.length === 0) {
      results.push({ fund_id: fundId, archivedCount: archived.length, sent: false, error: 'no admins' })
      continue
    }

    const adminUserIds = (admins as { user_id: string }[]).map(a => a.user_id)
    const { data: users } = await admin.auth.admin.listUsers()
    const adminEmails = (users.users ?? [])
      .filter(u => u.email && adminUserIds.includes(u.id))
      .map(u => u.email!)

    if (adminEmails.length === 0) {
      results.push({ fund_id: fundId, archivedCount: archived.length, sent: false, error: 'no admin emails' })
      continue
    }

    const config = await getOutboundConfig(admin, fundId, 'system')
    if (!config) {
      results.push({ fund_id: fundId, archivedCount: archived.length, sent: false, error: 'no outbound config' })
      continue
    }

    const html = renderDigest(archived)
    const subject = `Out-of-thesis deals (${archived.length}), last 7 days`

    let sent = 0
    let lastErr: string | undefined
    for (const to of adminEmails) {
      try {
        await sendOutboundEmail(config, { to, subject, html })
        sent++
      } catch (err) {
        lastErr = err instanceof Error ? err.message : 'send failed'
      }
    }

    results.push({ fund_id: fundId, archivedCount: archived.length, sent: sent > 0, error: lastErr })
  }

  return NextResponse.json({ ok: true, results })
}

function renderDigest(deals: Array<{ id: string; company_name: string | null; founder_name: string | null; founder_email: string | null; thesis_fit_analysis: string | null; created_at: string | null }>): string {
  const baseUrl = process.env.NEXT_PUBLIC_APP_URL ?? ''
  const items = deals.map(d => `
    <li style="margin: 0 0 12px 0;">
      <strong>${escapeHtml(d.company_name ?? 'Unknown company')}</strong>
      ${d.founder_name ? `, ${escapeHtml(d.founder_name)}` : ''}
      ${d.founder_email ? ` &lt;${escapeHtml(d.founder_email)}&gt;` : ''}<br/>
      ${d.thesis_fit_analysis ? `<span style="color:#666; font-size: 13px;">${escapeHtml(truncate(d.thesis_fit_analysis, 240))}</span><br/>` : ''}
      <a href="${baseUrl}/deals/${d.id}" style="font-size: 13px;">View →</a>
    </li>
  `).join('')

  return `
    <div style="font-family: -apple-system, BlinkMacSystemFont, sans-serif; max-width: 640px;">
      <p>The classifier flagged ${deals.length} pitch${deals.length === 1 ? '' : 'es'} as out-of-thesis or spam this week. Skim them for any misclassifications, open the deal page and use the status or fit controls to recover one.</p>
      <ul style="list-style: none; padding: 0;">${items}</ul>
      <p style="font-size: 12px; color: #888;">— Sent automatically by your deal screening pipeline.</p>
    </div>
  `
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

function truncate(s: string, n: number): string {
  return s.length <= n ? s : s.slice(0, n - 1) + '…'
}
