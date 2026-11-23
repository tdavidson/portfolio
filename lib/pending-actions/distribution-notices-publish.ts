// The real approval of a staged publish_distribution_notices (distribution-notices.ts). Imported
// only by routes that ship Chromium (lib/pdf-routes.mjs): rendering each notice launches it.

import type { ActionDeps } from './types'
import { resolveVehicle } from '@/lib/accounting/vehicle-resolver'
import { normalizeNoticeEmail, reviewDistributionNotices } from '@/lib/accounting/distribution-notice-review'
import { emailNotices, loadNoticeRegister, publishNotices } from '@/lib/accounting/notices'
import { unwrap } from '@/lib/service-outcome'
import { STALE_DISTRIBUTION_PREVIEW_MESSAGE, type PublishDistributionNoticesInput } from './distribution-notices'

export async function executePublishDistributionNotices(deps: ActionDeps, input: PublishDistributionNoticesInput): Promise<Record<string, unknown>> {
  const group = await resolveVehicle(deps.admin, deps.fundId, input.vehicle, { access: deps.access })
  const distributionId = String(input.distributionId ?? '')
  const email = normalizeNoticeEmail(input.email)
  // Re-read now: what goes out, and to whom, must be what the approver was shown.
  const review = unwrap(await reviewDistributionNotices(deps.admin, { fundId: deps.fundId, group }, distributionId, { lpEntityIds: input.lpEntityIds, email }))
  if (input.previewToken !== review.previewToken) throw new Error(STALE_DISTRIBUTION_PREVIEW_MESSAGE)
  const blockers = review.flags.filter(f => f.severity === 'blocker')
  if (blockers.length) throw new Error(blockers.map(f => f.message).join(' '))

  const reg = await loadNoticeRegister(deps.admin, deps.fundId, group, 'distribution', distributionId)
  if ('error' in reg) throw new Error(reg.error)
  const ctx = { fundId: deps.fundId, group, userId: deps.userId }
  const { published, errors } = await publishNotices(deps.admin, ctx, reg, { lpEntityIds: review.partners.map(p => p.lpEntityId) })
  const result: Record<string, unknown> = {
    distributionId,
    published: published.filter(p => !p.reused).length,
    reused: published.filter(p => p.reused).length,
    errors,
  }
  if (email) {
    const sent = await emailNotices(deps.admin, ctx, reg, published.filter(p => p.investorId), email)
    if ('error' in sent) return { ...result, emailError: sent.error }
    Object.assign(result, sent)
  }
  return result
}
