import type { ActionDeps, PreviewResult } from './types'
import {
  applyPublish, applyUpdate, describePublish, describeUpdate, type PublishAction, type UpdatePlanAction,
} from '@/lib/forecast/actions'

// Budget & forecast changes the Analyst may draft. Preview reads the plan with the stager's access;
// execute re-reads it with the approver's and applies to the plan as it is THEN — unless the draft
// named an expectedRevision, in which case a plan that moved since is refused (409) rather than
// overwritten.

const ctx = (d: ActionDeps) => ({ admin: d.admin, fundId: d.fundId, userId: d.userId, access: d.access })

export async function previewUpdateForecast(deps: ActionDeps, input: UpdatePlanAction): Promise<PreviewResult> {
  return describeUpdate(ctx(deps), input)
}

export async function executeUpdateForecast(deps: ActionDeps, input: UpdatePlanAction): Promise<Record<string, unknown>> {
  const plan = await applyUpdate(ctx(deps), input)
  return { planId: plan.plan.id, revision: plan.plan.revision }
}

export async function previewPublishForecast(deps: ActionDeps, input: PublishAction): Promise<PreviewResult> {
  return describePublish(ctx(deps), input)
}

export async function executePublishForecast(deps: ActionDeps, input: PublishAction): Promise<Record<string, unknown>> {
  return applyPublish(ctx(deps), input)
}
