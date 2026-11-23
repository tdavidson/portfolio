// Publishing a declared distribution's notices, and optionally emailing them, staged from a chat
// and approved by an admin. The distribution twin of call-notices.ts, with the same two
// confirmations: the chat shows preview_distribution_notices (with a DRAFT PDF per partner) and
// stages with its previewToken; an admin approves in the app (confirming twice) or from their own
// chat on an explicit yes. The executor that renders PDFs runs only where Chromium ships: the
// browser's approve route (distribution-notices-publish.ts) or, from a chat,
// app/api/agent/call-notices/publish. A script's key supplies none and is refused.

import type { ActionDeps, PreviewResult } from './types'
import { resolveVehicle } from '@/lib/accounting/vehicle-resolver'
import { describeDistributionNotices, normalizeNoticeEmail, reviewDistributionNotices, type DistributionNoticeEmail } from '@/lib/accounting/distribution-notice-review'
import { CONFIRM_IN_APP_MESSAGE } from './call-notices'

export interface PublishDistributionNoticesInput {
  vehicle?: string
  distributionId: string
  lpEntityIds?: string[] | null
  /** Omit to publish to the portal only. */
  email?: DistributionNoticeEmail | null
  previewToken: string
}

export const STALE_DISTRIBUTION_PREVIEW_MESSAGE =
  'These notices or their recipients have changed since they were previewed. Nothing was published or emailed. Reject this, ' +
  'preview the notices again and stage a new request.'

export async function previewPublishDistributionNotices(deps: ActionDeps, input: PublishDistributionNoticesInput): Promise<PreviewResult> {
  const group = await resolveVehicle(deps.admin, deps.fundId, input.vehicle, { access: deps.access })
  const out = await reviewDistributionNotices(deps.admin, { fundId: deps.fundId, group }, String(input.distributionId ?? ''), {
    lpEntityIds: input.lpEntityIds, email: normalizeNoticeEmail(input.email),
  })
  if (!out.ok) {
    return {
      summary: `Publish notices for a distribution on ${group} that can no longer be noticed.`,
      details: { vehicle: group, flags: [{ code: 'not_noticeable', severity: 'blocker', message: out.error }] },
    }
  }
  const review = out.value
  const flags = input.previewToken === review.previewToken
    ? review.flags
    : [{ code: 'changed_since_preview', severity: 'blocker' as const, message: STALE_DISTRIBUTION_PREVIEW_MESSAGE }, ...review.flags]
  return {
    summary: describeDistributionNotices(review),
    details: {
      vehicle: group,
      distribution: review.distribution,
      partners: review.partners.map(p => ({
        partner: p.name, amount: p.amount, capital: p.capital, carry: p.carry, alreadyPublished: p.alreadyPublished,
        ...(review.email ? { emailTo: p.to, cc: p.cc, by: p.via === 'contact' ? 'contact or notice email, PDF attached' : p.via === 'portal' ? 'portal account' : null } : {}),
      })),
      email: review.email,
      missing: review.missing,
      flags,
    },
  }
}

export async function executePublishDistributionNoticesElsewhere(): Promise<Record<string, unknown>> {
  throw new Error(CONFIRM_IN_APP_MESSAGE)
}
