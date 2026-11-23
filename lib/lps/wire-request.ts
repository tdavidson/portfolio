// Ask partners for their bank details, with or without the LP portal.
//
// One email per recipient: a partner's portal account (authorized users Cc'd), or, with no
// account, the contact or notice email on their record. It names the entities whose details are
// missing or unverified, asks for them on letterhead or a bank-verified form, and says plainly that
// the fund confirms every set of details by calling a number it already holds and never changes
// them on the strength of an email. Each send is logged (lp_deliveries, onboarding_request).
//
// Shared by the route (app/api/lps/wire-instructions/request) and anything else that sends it, so
// both say the same thing to the same people.

import type { SupabaseClient } from '@supabase/supabase-js'
import { getOutboundConfig, sendOutboundEmail } from '@/lib/email'
import { resolveContactRecipients, resolveLpRecipients } from '@/lib/lp-recipients'
import { buildLpEmailHtml, siteUrl } from '@/lib/lp-email'
import { logDelivery } from '@/lib/lp-deliveries'
import { loadWireSummaries } from './wire-instructions'

export interface WireRequestRecipient {
  to: string
  cc: string[]
  /** 'portal': they upload in the portal; 'contact': no account, they reply with the form. */
  via: 'portal' | 'contact'
  entities: { id: string; name: string; why: string }[]
}

export interface WireRequestPlan {
  subject: string
  recipients: WireRequestRecipient[]
  /** Entities nobody can be emailed about: no portal account, contact or notice email. */
  unreachable: string[]
  /** Entities left out because verified details are already on file. */
  alreadyVerified: string[]
}

/** Who would be asked, about which entities, and why. Nothing is sent. */
export async function planWireRequest(
  admin: SupabaseClient,
  fundId: string,
  entityIds: string[],
  opts: { includeVerified?: boolean } = {},
): Promise<WireRequestPlan | { error: string }> {
  const a = admin as any
  const [{ data: entities }, { data: fund }, { data: fs }] = await Promise.all([
    a.from('lp_entities').select('id, entity_name, investor_id').eq('fund_id', fundId).in('id', entityIds),
    a.from('funds').select('name').eq('id', fundId).maybeSingle(),
    a.from('fund_settings').select('lp_portal_enabled').eq('fund_id', fundId).maybeSingle(),
  ])
  const list = ((entities ?? []) as { id: string; entity_name: string; investor_id: string | null }[])
  if (list.length === 0) return { error: 'None of those LP entities are in this fund.' }
  const wires = await loadWireSummaries(admin, fundId, list.map(e => e.id))
  const alreadyVerified: string[] = []
  const wanted = list.filter(e => {
    const w = wires.get(e.id)
    if (w?.status === 'verified' && !opts.includeVerified) { alreadyVerified.push(e.entity_name); return false }
    return true
  })
  const why = (id: string) => {
    const w = wires.get(id)
    return !w ? 'no bank details on file' : w.status === 'verified' ? `re-confirm the details on file (account ending ${w.accountMasked.slice(-4)})` : 'details on file not yet confirmed'
  }

  const portalOn = !!fs?.lp_portal_enabled
  const investorIds = Array.from(new Set(wanted.map(e => e.investor_id).filter(Boolean) as string[]))
  const groups = portalOn ? await resolveLpRecipients(admin, fundId, investorIds) : []
  const reached = new Set(groups.flatMap(g => g.investorIds))
  const contacts = await resolveContactRecipients(admin, fundId, investorIds.filter(id => !reached.has(id)))

  const recipients: WireRequestRecipient[] = []
  for (const g of groups) {
    const ents = wanted.filter(e => e.investor_id && g.investorIds.includes(e.investor_id))
    if (ents.length) recipients.push({ to: g.primaryEmail, cc: g.ccEmails, via: 'portal', entities: ents.map(e => ({ id: e.id, name: e.entity_name, why: why(e.id) })) })
  }
  for (const [investorId, c] of Array.from(contacts.entries())) {
    const ents = wanted.filter(e => e.investor_id === investorId)
    if (ents.length) recipients.push({ to: c.to, cc: c.cc, via: 'contact', entities: ents.map(e => ({ id: e.id, name: e.entity_name, why: why(e.id) })) })
  }
  const covered = new Set(recipients.flatMap(r => r.entities.map(e => e.id)))
  const unreachable = wanted.filter(e => !covered.has(e.id)).map(e => e.entity_name)
  const fundName = (fund?.name as string | undefined) || 'Your fund'
  return { subject: `${fundName}: bank details for distributions`, recipients, unreachable, alreadyVerified }
}

/** A few sends at a time (lib/lp-report-pdf's runPool would pull headless Chrome into this route). */
async function runPool<T>(items: T[], size: number, fn: (item: T) => Promise<void>): Promise<void> {
  let next = 0
  await Promise.all(Array.from({ length: Math.min(size, items.length) }, async () => {
    while (next < items.length) await fn(items[next++])
  }))
}

const SAFETY =
  'We confirm every set of bank details by calling a number we already hold for you before we pay against it. ' +
  'We will never ask you to change bank details by email, and will not act on an email asking us to. If you receive one ' +
  'that appears to come from us, please call us.'

export function wireRequestBody(fundName: string, r: WireRequestRecipient, message: string | null): { text: string; facts: { label: string; value: string }[] } {
  const how = r.via === 'portal'
    ? 'Please upload them under Onboarding in your investor portal, as wire instructions on your letterhead or a form from your bank.'
    : 'Please reply with them as a signed letter on your letterhead or a form from your bank, giving the beneficiary name and address, bank name and address, ABA routing number or SWIFT/BIC, account number or IBAN, and any reference or further-credit details.'
  const intro = message?.trim() || `${fundName} needs bank details to pay distributions to the entities below.`
  return { text: `${intro}\n\n${how}\n\n${SAFETY}`, facts: r.entities.map(e => ({ label: e.name, value: e.why })) }
}

/** Send the request planned for these entities, logging every send. */
export async function sendWireRequest(
  admin: SupabaseClient,
  ctx: { fundId: string; userId: string },
  entityIds: string[],
  opts: { message?: string | null; includeVerified?: boolean } = {},
): Promise<{ sent: number; failures: string[]; unreachable: string[]; alreadyVerified: string[] } | { error: string }> {
  const plan = await planWireRequest(admin, ctx.fundId, entityIds, opts)
  if ('error' in plan) return plan
  if (plan.recipients.length === 0) {
    return { error: plan.unreachable.length ? 'Nobody to email: add a contact or notice email on these entities’ profiles, or invite them to the portal.' : 'Every selected entity already has verified bank details.' }
  }
  const config = await getOutboundConfig(admin as any, ctx.fundId)
  if (!config) return { error: 'No outbound email provider is configured for this fund.' }
  const { data: fund } = await (admin as any).from('funds').select('name').eq('id', ctx.fundId).maybeSingle()
  const fundName = (fund?.name as string | undefined) || 'Your fund'
  const out = { sent: 0, failures: [] as string[], unreachable: plan.unreachable, alreadyVerified: plan.alreadyVerified }
  await runPool(plan.recipients, 3, async r => {
    const { text, facts } = wireRequestBody(fundName, r, opts.message ?? null)
    const html = buildLpEmailHtml({
      fundName, itemTitle: 'Bank details for distributions', message: text, facts,
      link: r.via === 'portal' ? `${siteUrl()}/portal/onboarding` : null, linkLabel: 'Upload in your portal',
    })
    const log = (extra: { providerMessageId?: string | null; status?: 'sent' | 'failed'; error?: string }) => Promise.all(r.entities.map(e => logDelivery(admin, {
      fundId: ctx.fundId, kind: 'onboarding_request', lpEntityId: e.id, toEmail: r.to, ccEmails: r.cc, subject: plan.subject,
      provider: config.provider, sentBy: ctx.userId, ...extra,
    })))
    try {
      const sent = await sendOutboundEmail(config, { to: r.to, cc: r.cc.length ? r.cc.join(', ') : undefined, subject: plan.subject, html })
      out.sent += 1
      await log({ providerMessageId: sent?.id ?? null })
    } catch (e) {
      const msg = (e as Error)?.message ?? 'send failed'
      out.failures.push(`${r.to}: ${msg}`)
      await log({ status: 'failed', error: msg })
    }
  })
  return out
}
