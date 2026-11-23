// Asking partners for their bank details, staged from a chat and approved by an admin: it emails
// LPs. The approver reads who would be asked about which entities; on approval the plan is worked
// out again, so an entity verified in the meantime is left out.

import type { ActionDeps, PreviewResult } from './types'
import { resolveVehicle } from '@/lib/accounting/agent-tools'
import { lpCapitalSummary } from '@/lib/accounting/capital-calls'
import { planWireRequest, sendWireRequest } from '@/lib/lps/wire-request'

export interface RequestBankDetailsInput {
  vehicle?: string
  /** Only these partners; omitted = every partner in the vehicle without verified details. */
  lpEntityIds?: string[] | null
  message?: string | null
  /** Ask partners whose details are verified to re-confirm them too. */
  includeVerified?: boolean | null
}

async function targets(deps: ActionDeps, input: RequestBankDetailsInput): Promise<{ group: string; ids: string[] }> {
  const group = await resolveVehicle(deps.admin, deps.fundId, input.vehicle, { access: deps.access })
  const partners = (await lpCapitalSummary(deps.admin, deps.fundId, group)).map(r => r.lpEntityId)
  const wanted = Array.isArray(input.lpEntityIds) && input.lpEntityIds.length > 0 ? input.lpEntityIds.map(String) : null
  if (wanted) {
    const outside = wanted.filter(id => !partners.includes(id))
    if (outside.length) throw new Error(`Not partners in ${group}: ${outside.join(', ')}.`)
  }
  return { group, ids: wanted ?? partners }
}

export async function previewRequestBankDetails(deps: ActionDeps, input: RequestBankDetailsInput): Promise<PreviewResult> {
  const { group, ids } = await targets(deps, input)
  const plan = await planWireRequest(deps.admin, deps.fundId, ids, { includeVerified: input.includeVerified === true })
  if ('error' in plan) throw new Error(plan.error)
  const entities = plan.recipients.reduce((n, r) => n + r.entities.length, 0)
  return {
    summary: `Email ${plan.recipients.length} recipient(s) in ${group} asking for bank details for ${entities} entit${entities === 1 ? 'y' : 'ies'}`,
    details: {
      vehicle: group,
      subject: plan.subject,
      recipients: plan.recipients.map(r => ({ to: r.to, cc: r.cc, by: r.via === 'portal' ? 'portal account' : 'contact or notice email (no portal account)', entities: r.entities.map(e => `${e.name}: ${e.why}`) })),
      unreachable: plan.unreachable,
      alreadyVerified: plan.alreadyVerified,
      message: input.message ?? null,
    },
  }
}

export async function executeRequestBankDetails(deps: ActionDeps, input: RequestBankDetailsInput): Promise<Record<string, unknown>> {
  const { ids } = await targets(deps, input)
  const out = await sendWireRequest(deps.admin, { fundId: deps.fundId, userId: deps.userId }, ids, {
    message: typeof input.message === 'string' ? input.message.slice(0, 5000) : null,
    includeVerified: input.includeVerified === true,
  })
  if ('error' in out) throw new Error(out.error)
  return out
}
