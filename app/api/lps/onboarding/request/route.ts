import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
// lp_relations domain (lib/access/route-domains.ts). The middleware has already checked the grant.
import { assertWriteAccess } from '@/lib/api-helpers'
import { getOutboundConfig, sendOutboundEmail } from '@/lib/email'
import { resolveLpRecipients } from '@/lib/lp-recipients'
import { buildLpEmailHtml, siteUrl } from '@/lib/lp-email'
import { logDelivery } from '@/lib/lp-deliveries'
import { runPool } from '@/lib/lp-report-pdf'
import {
  buildOnboardingMatrix, normalizeKinds, DEFAULT_ONBOARDING_KINDS, ONBOARDING_STATUS_LABEL, loadClosingsByEntity, closingPhrase,
  type OnboardingEntity, type OnboardingItemRow,
} from '@/lib/lp-onboarding'
import { loadLpScope, lpVisible } from '@/lib/access/lp-scope'

/**
 * Ask LPs for what they still owe.
 *
 *   POST { lp_entity_ids?: string[] | 'all', message?: string, preview?: boolean }
 *
 * One email per LP account (their authorized users Cc'd, like every other LP send), listing the
 * outstanding and sent-back items for each of their entities with a link to the portal's
 * Onboarding page. Entities with nothing outstanding are left out; an investor with no portal
 * account is reported as unreachable rather than silently skipped. `preview` returns the exact
 * addresses and the items each would be asked for, without sending.
 */
export async function POST(req: NextRequest): Promise<NextResponse> {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  const admin = createAdminClient() as any
  const access = await assertWriteAccess(admin, user.id)
  if (access instanceof NextResponse) return access
  const fundId = access.fundId

  const body = await req.json().catch(() => ({}))
  const message = typeof body.message === 'string' ? body.message.trim().slice(0, 5000) : ''

  const [{ data: fs }, { data: entities }, { data: items }, { data: fund }] = await Promise.all([
    admin.from('fund_settings').select('lp_onboarding_kinds, lp_portal_enabled').eq('fund_id', fundId).maybeSingle(),
    admin.from('lp_entities').select('id, entity_name, investor_id, lp_investors(name)').eq('fund_id', fundId).eq('onboarding_excluded', false).order('entity_name'),
    admin.from('lp_onboarding_items').select('id, lp_entity_id, kind, status, document_id, submitted_at, reviewed_at, expires_on, note').eq('fund_id', fundId),
    admin.from('funds').select('name').eq('id', fundId).maybeSingle(),
  ])
  if (!fs?.lp_portal_enabled) return NextResponse.json({ error: 'Turn on the LP portal before requesting documents — LPs upload through it.' }, { status: 400 })

  const kinds = fs?.lp_onboarding_kinds == null ? DEFAULT_ONBOARDING_KINDS : normalizeKinds(fs.lp_onboarding_kinds)
  // Only LPs with a position in one of the caller's entities.
  const lp = await loadLpScope(admin, access)
  const closings = await loadClosingsByEntity(admin, ((entities ?? []) as any[]).map(e => e.id), lp.scope.vehicleNames)
  let list: OnboardingEntity[] = ((entities ?? []) as any[]).filter(e => lpVisible(lp.entityIds, e.id)).map(e => ({
    id: e.id, name: e.entity_name, investorId: e.investor_id, investorName: e.lp_investors?.name ?? '',
    closing: closings.get(e.id) ?? null,
  }))
  if (Array.isArray(body.lp_entity_ids)) {
    const wanted = new Set(body.lp_entity_ids.filter((x: unknown): x is string => typeof x === 'string'))
    list = list.filter(e => wanted.has(e.id))
  }
  const rows = buildOnboardingMatrix(list, kinds, (items ?? []) as OnboardingItemRow[])
    .filter(r => r.outstanding > 0)
    // Only what the LP can act on: not the uploads already waiting on the fund.
    .map(r => ({ ...r, items: r.items.filter(i => kinds.includes(i.kind) && (i.status === 'outstanding' || i.status === 'rejected' || i.expired)) }))
    .filter(r => r.items.length > 0)
  if (rows.length === 0) return NextResponse.json({ error: 'Nothing is outstanding for the selected entities.' }, { status: 400 })

  const investorIds = Array.from(new Set(rows.map(r => r.investorId)))
  const groups = await resolveLpRecipients(admin, fundId, investorIds)
  const reachable = new Set(groups.flatMap(g => g.investorIds))
  // An investor with no portal account can still be asked, at the relationship contact on their
  // record — no Cc, and the email says the portal is where to upload once they have access.
  const { data: contacts } = await admin.from('lp_investors').select('id, name, contact_email').eq('fund_id', fundId).in('id', investorIds.filter(id => !reachable.has(id)))
  const fallback = ((contacts ?? []) as { id: string; name: string; contact_email: string | null }[]).filter(c => !!c.contact_email)
  for (const c of fallback) reachable.add(c.id)
  const unreachable = rows.filter(r => !reachable.has(r.investorId)).map(r => `${r.investorName || r.name}`)
  if (groups.length === 0 && fallback.length === 0) {
    return NextResponse.json({ error: 'None of these LPs have portal accounts or a contact email yet. Invite them from LP Portal → Access, or add a contact on the entity profile.' }, { status: 400 })
  }

  const fundName = (fund?.name as string | undefined) || 'Your fund'
  const link = `${siteUrl()}/portal/onboarding`
  const subject = `${fundName}: documents needed to complete your onboarding`

  // The body per recipient: their entities and what each still owes.
  function bodyFor(investorIdsOfGroup: string[]): { text: string; facts: { label: string; value: string }[] } {
    const mine = rows.filter(r => investorIdsOfGroup.includes(r.investorId))
    const facts = mine.flatMap(r => [
      ...(r.closing ? [{ label: r.name, value: `Needed ${closingPhrase(r.closing, r.daysToClose)}` }] : []),
      ...r.items.map(i => ({
        label: r.name,
        value: i.status === 'rejected' ? `${i.label} — sent back${i.note ? `: ${i.note}` : ''}` : i.expired ? `${i.label} — expired, please send a current one` : i.label,
      })),
    ])
    const intro = message || `To complete your onboarding with ${fundName}, please upload the following through your investor portal. Each item can be uploaded as a PDF or a photo.`
    return { text: intro, facts }
  }

  if (body.preview === true) {
    return NextResponse.json({
      preview: true, subject,
      recipients: [
        ...groups.map(g => ({ to: g.primaryEmail, name: g.primaryName, cc: g.ccEmails, items: bodyFor(g.investorIds).facts.map(f => `${f.label}: ${f.value}`), viaContact: false })),
        ...fallback.map(c => ({ to: c.contact_email!, name: c.name, cc: [] as string[], items: bodyFor([c.id]).facts.map(f => `${f.label}: ${f.value}`), viaContact: true })),
      ],
      unreachable,
    })
  }

  const config = await getOutboundConfig(admin, fundId)
  if (!config) return NextResponse.json({ error: 'No outbound email provider is configured for this fund.' }, { status: 400 })

  const summary = { sent: 0, failures: [] as string[], unreachable }
  await runPool(groups, 3, async g => {
    const { text, facts } = bodyFor(g.investorIds)
    const html = buildLpEmailHtml({ fundName, itemTitle: 'Documents needed', message: text, facts, link, linkLabel: 'Upload in your portal' })
    const common = { fundId, kind: 'onboarding_request' as const, toEmail: g.primaryEmail, ccEmails: g.ccEmails, subject, provider: config.provider, sentBy: user.id }
    try {
      const sent = await sendOutboundEmail(config, { to: g.primaryEmail, cc: g.ccEmails.length ? g.ccEmails.join(', ') : undefined, subject, html })
      summary.sent += 1
      for (const investorId of g.investorIds) await logDelivery(admin, { ...common, lpInvestorId: investorId, providerMessageId: sent?.id ?? null })
    } catch (e) {
      const msg = (e as Error)?.message ?? 'send failed'
      summary.failures.push(g.primaryEmail)
      for (const investorId of g.investorIds) await logDelivery(admin, { ...common, lpInvestorId: investorId, status: 'failed', error: msg })
    }
  })

  // The contacts without a portal account, one email each, logged against their investor.
  await runPool(fallback, 3, async c => {
    const { text, facts } = bodyFor([c.id])
    const html = buildLpEmailHtml({ fundName, itemTitle: 'Documents needed', message: `${text}\n\nYou will be invited to the investor portal to upload these; if you already have access, use the link below.`, facts, link, linkLabel: 'Open the investor portal' })
    const common = { fundId, kind: 'onboarding_request' as const, lpInvestorId: c.id, toEmail: c.contact_email!, subject, provider: config.provider, sentBy: user.id }
    try {
      const sent = await sendOutboundEmail(config, { to: c.contact_email!, subject, html })
      summary.sent += 1
      await logDelivery(admin, { ...common, providerMessageId: sent?.id ?? null })
    } catch (e) {
      summary.failures.push(c.contact_email!)
      await logDelivery(admin, { ...common, status: 'failed', error: (e as Error)?.message ?? 'send failed' })
    }
  })

  return NextResponse.json({ ok: true, ...summary, viaContact: fallback.length, statusLabels: ONBOARDING_STATUS_LABEL })
}
