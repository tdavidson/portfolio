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
  forecast_explain: async (ctx, input) => getPlan(svc(ctx), { vehicle: vehicleOf(input), planId: input.planId }),
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
