import type { ActionDeps, PreviewResult } from './types'
import { resolveVehicle } from '@/lib/accounting/agent-tools'
import { declareDistribution } from '@/lib/accounting/distributions'
import { previewWithChecks, ISO_DATE } from '@/lib/accounting/distribution-review'

export interface DeclareDistributionActionInput {
  vehicle?: string
  distributionDate: string
  /** Fund-wide amount to distribute, split through the vehicle's waterfall (or pro-rata). */
  total: number
  description?: string | null
  /** 'pro_rata' forces the capital-balance split even when the vehicle has carry terms. */
  method?: 'waterfall' | 'pro_rata' | null
}

function validate(input: DeclareDistributionActionInput) {
  if (!ISO_DATE.test(String(input?.distributionDate ?? ''))) throw new Error('distributionDate must be YYYY-MM-DD.')
  const total = Number(input?.total)
  if (!Number.isFinite(total) || total <= 0) throw new Error('total must be a positive amount.')
  return { total: Math.round(total * 100) / 100, method: input?.method === 'pro_rata' ? 'pro_rata' as const : 'waterfall' as const }
}

/**
 * The split the distribution would get, writing nothing: each partner's line (the GP's own capital
 * and its carry apart), the tiers, and the checks. The approver reads this; nothing is posted.
 */
export async function previewDeclareDistribution(deps: ActionDeps, input: DeclareDistributionActionInput): Promise<PreviewResult> {
  const { total, method } = validate(input)
  const group = await resolveVehicle(deps.admin, deps.fundId, input.vehicle, { access: deps.access })
  const p = await previewWithChecks(deps.admin, deps.fundId, group, total, input.distributionDate, method)
  const breakdown = new Map(p.lineBreakdown.map(b => [b.lpEntityId, b]))
  const name = (id: string) => p.names[id] ?? id
  return {
    summary: `Declare a ${total} distribution in ${group} on ${input.distributionDate}, ${p.method === 'waterfall' ? 'through the waterfall' : 'pro-rata by capital'}`,
    details: {
      vehicle: group,
      distributionDate: input.distributionDate,
      description: input.description ?? null,
      total,
      method: p.method,
      terms: p.terms,
      tiers: p.method === 'waterfall' ? p.tiers : null,
      perPartner: [
        ...p.lines.map(l => ({ partner: name(l.lpEntityId), line: 'distribution on capital', amount: l.amount, ...(breakdown.get(l.lpEntityId) ?? {}) })),
        ...p.carryLines.map(l => ({ partner: name(l.lpEntityId), line: 'carried interest', amount: l.amount })),
      ].map(r => { const { lpEntityId: _id, ...rest } = r as Record<string, unknown>; return rest }),
      suggestedCharacter: p.suggestedCharacter,
      missing: p.checks.missing,
      flags: p.checks.flags,
    },
  }
}

/**
 * Declare it: split again from the LIVE books (a stale preview cannot post outdated amounts),
 * refuse what the checks call a blocker, and declare through the same path the Capital accounts
 * page uses, with the waterfall's tiers, per-line breakdown and suggested character.
 */
export async function executeDeclareDistribution(deps: ActionDeps, input: DeclareDistributionActionInput): Promise<{ distributionId: string }> {
  const { total, method } = validate(input)
  const group = await resolveVehicle(deps.admin, deps.fundId, input.vehicle, { access: deps.access })
  const p = await previewWithChecks(deps.admin, deps.fundId, group, total, input.distributionDate, method)
  const blockers = p.checks.flags.filter(f => f.severity === 'blocker')
  if (blockers.length > 0) throw new Error(blockers.map(f => f.message).join(' '))
  const required = p.checks.missing.filter(m => m.required)
  if (required.length > 0) throw new Error(`Missing: ${required.map(m => m.label).join(', ')}.`)
  const waterfall = p.method === 'waterfall'
  const result = await declareDistribution(deps.admin, deps.fundId, group, deps.userId, {
    requestKey: `agent:${deps.userId}:${group}:${input.distributionDate}:${total}:${p.method}`.slice(0, 100),
    distributionDate: input.distributionDate,
    description: input.description ?? null,
    scope: 'fund_wide',
    lines: p.lines,
    carryLines: p.carryLines,
    splitMethod: p.method,
    tiers: waterfall ? p.tiers : null,
    lineBreakdown: waterfall ? p.lineBreakdown : null,
    character: waterfall ? p.suggestedCharacter : undefined,
  })
  if ('error' in result) throw new Error(result.error)
  return { distributionId: result.distributionId }
}
