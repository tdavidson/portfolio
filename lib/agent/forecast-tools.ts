import type { AgentToolContext, AgentToolHandler } from '@/lib/accounting/agent-tools'
import { getPlan, getSeries, getVariance, listFeeLinks, listPlans, saveFeeLink, suggestRules, type ForecastServiceContext } from '@/lib/forecast/service'
import { applyCreate, applyPublish, applyUpdate } from '@/lib/forecast/actions'

const svc = ({ admin, fundId, userId, access }: AgentToolContext): ForecastServiceContext => ({
  admin, fundId, userId: userId ?? '', access,
})

const vehicleOf = (input: any): string => {
  if (typeof input?.vehicle !== 'string' || !input.vehicle.trim()) throw new Error('vehicle is required')
  return input.vehicle
}

export const FORECAST_HANDLERS: Record<string, AgentToolHandler> = {
  forecast_list_plans: async (ctx, input) => listPlans(svc(ctx), { vehicle: vehicleOf(input) }),
  forecast_series: async (ctx, input) =>
    getSeries(svc(ctx), {
      vehicle: vehicleOf(input),
      planId: input.planId,
      versionId: input.versionId,
      view: input.view,
      start: input.start,
      end: input.end,
      interval: input.interval,
    }),
  forecast_explain: async (ctx, input) => {
    const d = await getPlan(svc(ctx), { vehicle: vehicleOf(input), planId: input.planId })
    // Only the entries a hand edit can touch — construction, opening balances and hand entries —
    // with account codes, not every rule's monthly line (those are explained by `rules`). A
    // 60-month plan's full list would crowd out the answer.
    const code = new Map(d.allAccounts.map(a => [a.id, a.code]))
    const { allAccounts: _accounts, entries, ...rest } = d
    void _accounts
    return {
      ...rest,
      editableEntries: entries.filter(e => e.key).map(e => ({
        key: e.key, date: e.date, memo: e.memo, source: e.source,
        lines: e.postings.map(p => ({ account: code.get(p.accountId) ?? p.accountId, amount: p.amount })),
      })),
    }
  },
  forecast_variance: async (ctx, input) => {
    const ver = (v: unknown, fallback: string | null) => {
      const x = typeof v === 'string' && v ? v : fallback
      return x === 'draft' ? null : x
    }
    return getVariance(svc(ctx), {
      vehicle: vehicleOf(input),
      base: { planId: input.planId, versionId: ver(input.baseVersionId, 'approved') },
      compare: input.comparePlanId ? { planId: input.comparePlanId, versionId: ver(input.compareVersionId, 'draft') } : 'actual',
      start: input.start,
      end: input.end,
      interval: input.interval,
    })
  },
  forecast_create_plan: async (ctx, input) => applyCreate(svc(ctx), { ...input, vehicle: vehicleOf(input) }),
  forecast_update_plan: async (ctx, input) => applyUpdate(svc(ctx), { ...input, vehicle: vehicleOf(input) }),
  forecast_publish: async (ctx, input) => applyPublish(svc(ctx), { ...input, vehicle: vehicleOf(input) }),
  forecast_suggest_rules: async (ctx, input) => suggestRules(svc(ctx), { vehicle: vehicleOf(input), lookbackMonths: input.lookbackMonths }),
  forecast_fee_links: async (ctx, input) => listFeeLinks(svc(ctx), { vehicle: vehicleOf(input) }),
  forecast_set_fee_link: async (ctx, input) => saveFeeLink(svc(ctx), { ...input, manco: vehicleOf(input) }),
}
