// Write operations as an agent states them — accounts by CODE, a plan by id — normalised onto the
// service. Shared by the MCP write tools (which run directly) and the Analyst's staged actions
// (preview now, execute on approval), so the two cannot interpret the same request differently.

import { getPlan, savePlan, publishPlan, createPlan, ForecastError, type ForecastServiceContext, type PlanDetail, type SavePlanInput } from './service'
import { isMonthKey } from './months'

export interface UpdatePlanAction {
  vehicle: string
  planId: string
  /** Optional: the revision the request was made against. Omitted = the plan as it is when applied. */
  expectedRevision?: number
  rules?: { account: string; method: string; params: unknown; cashTiming?: unknown; note?: string | null }[]
  removeRules?: string[]
  overrides?: { account: string; month: string; amount: number | null; note?: string | null }[]
  patch?: SavePlanInput['patch']
  explanation?: string
}

export const UPDATE_PLAN_SCHEMA = {
  type: 'object',
  required: ['vehicle', 'planId'],
  additionalProperties: false,
  properties: {
    vehicle: { type: 'string', description: 'Vehicle name.' },
    planId: { type: 'string', description: 'Plan id from forecast_list_plans.' },
    expectedRevision: { type: 'number', description: 'The plan revision you read; a stale one is refused.' },
    rules: {
      type: 'array',
      description: 'Set the rule on an account (replaces any existing rule on it).',
      items: {
        type: 'object',
        required: ['account', 'method', 'params'],
        additionalProperties: false,
        properties: {
          account: { type: 'string', description: 'Account code (e.g. "5210") or id.' },
          method: { type: 'string', enum: ['manual', 'fixed', 'recurring', 'run_rate', 'growth', 'linked_fee', 'linked_construction'] },
          params: {
            type: 'object',
            description:
              'manual {amounts:{"YYYY-MM":n}} · fixed {amount,start?,end?} · recurring {amount,everyMonths,anchor:"YYYY-MM",start?,end?,annualEscalation?,exceptions?,oneOffs?} · ' +
              'run_rate {window:3|6|12} or {from,to}, includeUnclosed? · growth {base,baseMonth,rate,per:"month"|"year"} · ' +
              'linked_fee {fundVehicle} · linked_construction {flow:"fees"|"expenses"}. Amounts are positive for revenue and for expense.',
          },
          cashTiming: {
            type: 'object',
            description: '{mode:"same"} · {mode:"offset",months:n} (negative = in advance) · {mode:"month",month:1-12,direction:"advance"|"arrears"}',
          },
          note: { type: 'string' },
        },
      },
    },
    removeRules: { type: 'array', items: { type: 'string' }, description: 'Account codes whose rule to remove.' },
    overrides: {
      type: 'array',
      description: 'Set one month of one account (amount null clears the override).',
      items: {
        type: 'object',
        required: ['account', 'month', 'amount'],
        additionalProperties: false,
        properties: {
          account: { type: 'string' },
          month: { type: 'string', description: 'YYYY-MM' },
          amount: { type: ['number', 'null'] },
          note: { type: 'string' },
        },
      },
    },
    patch: {
      type: 'object',
      additionalProperties: false,
      properties: {
        name: { type: 'string' },
        scenario: { type: ['string', 'null'] },
        actualsCutoff: { type: ['string', 'null'], description: 'YYYY-MM; null = the last closed month.' },
        horizonMonths: { type: 'number' },
        endMonth: { type: 'string' },
        status: { type: 'string', enum: ['active', 'archived'] },
        includeConstruction: { type: 'boolean', description: "Fund/SPV: include construction's investments, exits, calls and distributions." },
        openingSettlementMonths: { type: 'number', description: 'When payables/receivables open at the start settle (1 = first month, 0 = never).' },
      },
    },
    explanation: { type: 'string', description: 'Why — shown to the approver.' },
  },
} as const

export const PUBLISH_PLAN_SCHEMA = {
  type: 'object',
  required: ['vehicle', 'planId', 'status'],
  additionalProperties: false,
  properties: {
    vehicle: { type: 'string' },
    planId: { type: 'string' },
    status: { type: 'string', enum: ['published', 'approved'], description: "'approved' = the budget baseline (one per plan)." },
    label: { type: 'string' },
    notes: { type: 'string' },
    expectedRevision: { type: 'number' },
  },
} as const

export const CREATE_PLAN_SCHEMA = {
  type: 'object',
  required: ['vehicle', 'kind', 'name'],
  additionalProperties: false,
  properties: {
    vehicle: { type: 'string' },
    kind: { type: 'string', enum: ['budget', 'rolling_forecast'] },
    name: { type: 'string' },
    fiscalYear: { type: 'number', description: 'Required for a budget.' },
    horizonMonths: { type: 'number', description: 'Rolling forecast: 12, 18, 24 or 36.' },
    endMonth: { type: 'string', description: 'Rolling forecast: a fixed end month instead of a horizon.' },
    actualsCutoff: { type: 'string', description: 'YYYY-MM; omit for the last closed month.' },
    includeConstruction: { type: 'boolean', description: "Fund/SPV: include construction's investment and capital flows." },
    seed: {
      type: 'object',
      properties: { from: { type: 'string', enum: ['blank', 'actuals', 'plan'] }, planId: { type: 'string' } },
      required: ['from'],
      additionalProperties: false,
    },
  },
} as const

function accountId(detail: PlanDetail, ref: unknown): string {
  if (typeof ref !== 'string' || !ref.trim()) throw new ForecastError('account is required')
  const hit = detail.accounts.find(a => a.id === ref || a.code === ref.trim())
  if (!hit) throw new ForecastError(`No income or expense account "${ref}" in ${detail.plan.vehicle}'s chart`)
  return hit.id
}

export function toSaveInput(detail: PlanDetail, a: UpdatePlanAction): SavePlanInput {
  for (const o of a.overrides ?? []) if (!isMonthKey(o.month)) throw new ForecastError(`override month "${o.month}" must be YYYY-MM`)
  return {
    vehicle: detail.plan.vehicle,
    planId: detail.plan.id,
    expectedRevision: a.expectedRevision ?? detail.plan.revision,
    patch: a.patch,
    rules: (a.rules ?? []).map(r => ({ accountId: accountId(detail, r.account), method: r.method as any, params: r.params, cashTiming: r.cashTiming, note: r.note ?? null })),
    removeRules: (a.removeRules ?? []).map(r => accountId(detail, r)),
    overrides: (a.overrides ?? []).map(o => ({ accountId: accountId(detail, o.account), month: o.month, amount: o.amount, note: o.note ?? null })),
  }
}

export async function applyUpdate(ctx: ForecastServiceContext, a: UpdatePlanAction): Promise<PlanDetail> {
  const detail = await getPlan(ctx, { vehicle: a.vehicle, planId: a.planId })
  return savePlan(ctx, toSaveInput(detail, a))
}

/** What an update would change, account by account — for the approver, before anything runs. */
export async function describeUpdate(ctx: ForecastServiceContext, a: UpdatePlanAction) {
  const detail = await getPlan(ctx, { vehicle: a.vehicle, planId: a.planId })
  const save = toSaveInput(detail, a) // validates account references now, not at approval
  const name = (id: string) => {
    const acct = detail.accounts.find(x => x.id === id)!
    return `${acct.code} ${acct.name}`
  }
  const rules = (save.rules ?? []).map(r => ({
    account: name(r.accountId),
    before: detail.rules.find(x => x.accountId === r.accountId) ?? null,
    after: { method: r.method, params: r.params, cashTiming: r.cashTiming ?? { mode: 'same' } },
  }))
  const removed = (save.removeRules ?? []).map(id => ({ account: name(id), before: detail.rules.find(x => x.accountId === id) ?? null }))
  const overrides = (save.overrides ?? []).map(o => ({
    account: name(o.accountId),
    month: o.month,
    before: detail.overrides.find(x => x.accountId === o.accountId && x.month === o.month)?.amount ?? null,
    after: o.amount,
  }))
  const parts = [
    rules.length && `${rules.length} rule${rules.length === 1 ? '' : 's'}`,
    removed.length && `remove ${removed.length} rule${removed.length === 1 ? '' : 's'}`,
    overrides.length && `${overrides.length} month override${overrides.length === 1 ? '' : 's'}`,
    a.patch && Object.keys(a.patch).length && 'plan settings',
  ].filter(Boolean)
  return {
    summary: `Update ${detail.plan.name} (${detail.plan.vehicle}): ${parts.join(', ') || 'recompile against current actuals'}`,
    details: {
      vehicle: detail.plan.vehicle,
      plan: detail.plan.name,
      revision: detail.plan.revision,
      rules,
      removed,
      overrides,
      ...(a.patch ? { patch: a.patch } : {}),
      ...(a.explanation ? { explanation: a.explanation } : {}),
    },
  }
}

export interface PublishAction {
  vehicle: string
  planId: string
  status: 'published' | 'approved'
  label?: string | null
  notes?: string | null
  expectedRevision?: number
}

export async function applyPublish(ctx: ForecastServiceContext, a: PublishAction) {
  const detail = await getPlan(ctx, { vehicle: a.vehicle, planId: a.planId })
  return publishPlan(ctx, {
    vehicle: detail.plan.vehicle, planId: detail.plan.id, expectedRevision: a.expectedRevision ?? detail.plan.revision,
    status: a.status, label: a.label ?? null, notes: a.notes ?? null,
  })
}

export async function describePublish(ctx: ForecastServiceContext, a: PublishAction) {
  const detail = await getPlan(ctx, { vehicle: a.vehicle, planId: a.planId })
  if (a.status === 'approved' && detail.versions.some(v => v.status === 'approved')) {
    throw new ForecastError(`${detail.plan.name} already has an approved baseline; publish a revision instead`, 409)
  }
  return {
    summary: `${a.status === 'approved' ? 'Approve' : 'Publish'} ${detail.plan.name} (${detail.plan.vehicle}) as version ${(detail.versions[0]?.versionNo ?? 0) + 1}, actuals through ${detail.cutoff}`,
    details: { vehicle: detail.plan.vehicle, plan: detail.plan.name, status: a.status, label: a.label ?? null, cutoff: detail.cutoff, stale: detail.stale },
  }
}

export async function applyCreate(ctx: ForecastServiceContext, input: any) {
  return createPlan(ctx, input)
}
