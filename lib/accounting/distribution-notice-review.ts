// What publishing (and optionally emailing) a DECLARED distribution's notices would do, before
// anything goes out. The distribution twin of call-notice-review.ts.
//
// A chat may ask for it only after this review has been shown, and an admin approves it
// (lib/pending-actions/distribution-notices.ts). The review lists each partner's notice (one per
// partner: the GP's capital and carry together, shown apart on the notice), who it would reach and
// how, and what is missing or wrong. The preview token fingerprints everything the notices would
// say and who they would be emailed to; publishing refuses when any of it changed since.
//
// Reads only. Nothing here renders a PDF (lib/pdf-routes.mjs).

import { createHash } from 'crypto'
import type { SupabaseClient } from '@supabase/supabase-js'
import { loadNoticeRegister, previewNoticeRecipients, type NoticeLine } from './notice-register'
import { roundCents } from './ledger'
import type { DraftFlag, MissingItem } from '@/lib/drafting/checks'
import { done, fail, type Outcome } from '@/lib/service-outcome'
// Kept here, not imported from ./notices, which reaches headless Chrome (tests/pdf-routes.test.ts).
export type NoticeDelivery = 'link' | 'attachment' | 'both'

export interface DistributionNoticeEmail {
  delivery: NoticeDelivery
  subject?: string | null
  message?: string | null
}

export interface DistributionNoticePartner {
  lpEntityId: string
  name: string
  amount: number
  /** The distribution on their capital and any carried interest, as the notice shows them. */
  capital: number
  carry: number
  alreadyPublished: boolean
  /** Who the email would go to, when emailing. */
  to: string | null
  cc: string[]
  via: 'portal' | 'contact' | null
  /** Why this partner would not be emailed, or could not open the notice. */
  unreachable: string | null
}

export interface DistributionNoticeReview {
  vehicle: string
  distribution: { id: string; date: string; description: string | null; total: number }
  partners: DistributionNoticePartner[]
  newNotices: number
  email: DistributionNoticeEmail | null
  portalEnabled: boolean
  missing: MissingItem[]
  flags: DraftFlag[]
  previewToken: string
}

export function normalizeNoticeEmail(e: unknown): DistributionNoticeEmail | null {
  if (!e || typeof e !== 'object') return null
  const o = e as Record<string, unknown>
  const delivery = (['link', 'attachment', 'both'] as const).includes(o.delivery as NoticeDelivery) ? (o.delivery as NoticeDelivery) : 'attachment'
  const text = (v: unknown, max: number) => (typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : null)
  return { delivery, subject: text(o.subject, 300), message: text(o.message, 5000) }
}

/** Everything the notices state and where they would be sent, hashed. */
export function distributionNoticeFingerprint(parts: {
  distributionId: string
  date: string
  description: string | null
  lines: Pick<NoticeLine, 'id' | 'lpEntityId' | 'amount' | 'noticeDocumentId' | 'parts'>[]
  email: DistributionNoticeEmail | null
  recipients: { lpEntityId: string; to: string | null; cc: string[] }[]
}): string {
  const lines = [...parts.lines]
    .sort((a, b) => a.id.localeCompare(b.id))
    .map(l => [l.id, l.lpEntityId, roundCents(l.amount), l.noticeDocumentId ?? null,
      (l.parts ?? []).map(p => [p.lineId, p.role, roundCents(p.amount), p.returnOfCapital, p.preferred, p.profit])])
  const recipients = parts.email
    ? [...parts.recipients].sort((a, b) => a.lpEntityId.localeCompare(b.lpEntityId)).map(r => [r.lpEntityId, r.to, [...r.cc].sort()])
    : null
  const canonical = JSON.stringify([parts.distributionId, parts.date, parts.description, lines, parts.email, recipients])
  return createHash('sha256').update(canonical).digest('hex').slice(0, 32)
}

export async function reviewDistributionNotices(
  admin: SupabaseClient,
  ctx: { fundId: string; group: string },
  distributionId: string,
  opts: { lpEntityIds?: string[] | null; email?: DistributionNoticeEmail | null } = {},
): Promise<Outcome<DistributionNoticeReview>> {
  const reg = await loadNoticeRegister(admin, ctx.fundId, ctx.group, 'distribution', distributionId)
  if ('error' in reg) return fail(reg.status, reg.error)
  const requested = (opts.lpEntityIds ?? []).filter(Boolean)
  const unknown = requested.filter(id => !reg.lines.some(l => l.lpEntityId === id))
  if (unknown.length) return fail(400, `Not partners on this distribution: ${unknown.join(', ')}.`)
  const targets = requested.length ? reg.lines.filter(l => requested.includes(l.lpEntityId)) : reg.lines
  const email = opts.email ?? null

  const [recipients, signOff] = await Promise.all([
    previewNoticeRecipients(admin, ctx.fundId, ctx.group, reg, targets.map(t => t.lpEntityId)),
    (admin as any).from('distributions').select('reviewed_at').eq('id', distributionId).eq('fund_id', ctx.fundId).maybeSingle()
      .then((r: any) => (r.error ? null : r.data?.reviewed_at ?? null), () => null),
  ])
  const byEntity = new Map(recipients.recipients.map(r => [r.lpEntityId, r]))

  const partners: DistributionNoticePartner[] = targets.map(l => {
    const r = byEntity.get(l.lpEntityId)
    const parts = l.parts ?? [{ role: l.role, amount: l.amount }]
    return {
      lpEntityId: l.lpEntityId,
      name: r?.name ?? l.lpEntityId,
      amount: l.amount,
      capital: roundCents(parts.filter(p => p.role === 'lp').reduce((s, p) => s + p.amount, 0)),
      carry: roundCents(parts.filter(p => p.role === 'carry').reduce((s, p) => s + p.amount, 0)),
      alreadyPublished: !!l.noticeDocumentId,
      to: r?.to ?? null,
      cc: r?.cc ?? [],
      via: r?.via ?? null,
      unreachable: r?.skipped ?? null,
    }
  })

  const missing: MissingItem[] = []
  const flags: DraftFlag[] = []
  if (!signOff) {
    flags.push({ code: 'not_signed_off', severity: 'warning', message: 'Nobody has signed off this distribution’s calculation. distribution_sign_off records it once someone has checked it.' })
  }
  if (email) {
    if (!recipients.hasProvider) flags.push({ code: 'no_email_provider', severity: 'blocker', message: 'No outbound email provider is configured for this fund, so nothing can be emailed.' })
    if (!recipients.portalEnabled && email.delivery !== 'attachment') {
      flags.push({ code: 'portal_off_link', severity: 'blocker', message: 'The LP portal is off, so a portal link would not work. Send the notices as PDF attachments instead.' })
    }
    for (const p of partners.filter(p => p.unreachable)) {
      flags.push({ code: 'not_emailed', severity: 'warning', subject: p.lpEntityId, message: `${p.name}: ${p.unreachable} The notice is filed but not emailed.` })
    }
  } else {
    if (!recipients.portalEnabled) flags.push({ code: 'portal_off', severity: 'warning', message: 'The LP portal is off, so no partner can open a published notice. Email them as PDF attachments instead.' })
    if (partners.every(p => p.alreadyPublished)) {
      flags.push({ code: 'nothing_to_publish', severity: 'blocker', message: 'Every selected partner already has this notice. Pass email to send it to them.' })
    }
  }

  return done({
    vehicle: ctx.group,
    distribution: { id: reg.id, date: reg.noticeDate, description: reg.description, total: roundCents(targets.reduce((s, l) => s + l.amount, 0)) },
    partners,
    newNotices: partners.filter(p => !p.alreadyPublished).length,
    email,
    portalEnabled: recipients.portalEnabled,
    missing,
    flags,
    previewToken: distributionNoticeFingerprint({
      distributionId: reg.id, date: reg.noticeDate, description: reg.description, lines: targets, email,
      recipients: partners.map(p => ({ lpEntityId: p.lpEntityId, to: p.to, cc: p.cc })),
    }),
  })
}

export function describeDistributionNotices(r: DistributionNoticeReview): string {
  const reused = r.partners.length - r.newNotices
  const send = r.email
    ? `, and email ${r.partners.filter(p => !p.unreachable).length} of them (${r.email.delivery === 'attachment' ? 'PDF attached' : r.email.delivery === 'link' ? 'portal link' : 'link and PDF'})`
    : ''
  return `Publish ${r.newNotices} distribution notice${r.newNotices === 1 ? '' : 's'} for ${r.distribution.date} on ${r.vehicle}` +
    (reused ? ` (${reused} already published, reused)` : '') + send + '.'
}
