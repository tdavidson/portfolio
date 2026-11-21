// A change to a portfolio company's record, staged from the chat for a person to approve: the
// in-app chat's `update_company`. Applied through lib/companies/holding-edit.ts, the same function
// the connector's update_company tool runs, so both doors check and write a change the same way.

import type { ActionDeps, PreviewResult } from './types'
import { resolveCompany } from '@/lib/agent/portfolio-tools'
import { entityScopeFor } from '@/lib/access/entity-scope'
import { companyChangeFromInput, planCompanyChange, updateCompanyDetails } from '@/lib/companies/holding-edit'
import { unwrap } from '@/lib/service-outcome'

const LABELS: Record<string, string> = {
  name: 'name', status: 'status', aliases: 'aliases', tags: 'tags', industry: 'industry',
  contact_email: 'contact emails', portfolio_group: 'entities', stage: 'stage', country: 'country', founded_year: 'founded year',
  overview: 'overview', founders: 'founders', why_invested: 'why invested', current_update: 'current update', notes: 'notes',
  metrics_enabled: 'use metrics', analyst_enabled: 'use AI Analyst', price_feed_enabled: 'use a price feed',
}

const shown = (v: unknown) => (Array.isArray(v) ? (v.length ? v.join(', ') : 'none') : v === null || v === undefined || v === '' ? 'blank' : String(v))

export async function previewUpdateCompany(deps: ActionDeps, input: any): Promise<PreviewResult> {
  // Only a company linked to one of the stager's entities resolves.
  const company = await resolveCompany(deps.admin, deps.fundId, String(input?.company ?? ''), deps.access)
  const { vehicleNames } = await entityScopeFor(deps.admin, deps.access)
  const plan = unwrap(await planCompanyChange(deps.admin, { fundId: deps.fundId, vehicleNames }, company.id, companyChangeFromInput(input)))
  const changes = Object.fromEntries(Object.keys(plan.updates).map(k => [LABELS[k] ?? k, { from: plan.before[k], to: plan.updates[k] }]))
  // Short fields read in the summary; long text is in the details.
  const brief = Object.entries(changes).map(([label, c]) => {
    const to = shown(c.to)
    return to.length <= 80 ? `${label} to ${to}` : label
  })
  return {
    summary: `Change ${plan.company.name}: ${brief.join('; ')}`,
    details: { company: plan.company.name, companyId: plan.company.id, changes },
  }
}

export async function executeUpdateCompany(deps: ActionDeps, input: any): Promise<Record<string, unknown>> {
  // Resolved again with the approver's access, and planned again against the live record.
  const company = await resolveCompany(deps.admin, deps.fundId, String(input?.company ?? ''), deps.access)
  const { vehicleNames } = await entityScopeFor(deps.admin, deps.access)
  return unwrap(await updateCompanyDetails(deps.admin, { fundId: deps.fundId, userId: deps.userId, vehicleNames }, company.id, companyChangeFromInput(input)))
}
