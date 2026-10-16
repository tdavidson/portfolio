import { NextRequest } from 'next/server'
import { createPlan, listPlans, getPlan } from '@/lib/forecast/service'
import { forecastRequest, readJson } from '@/lib/forecast/http'

// Forecast plans for one vehicle. GET lists them; POST creates one (seeded blank, from
// actuals, or from another plan) and returns it compiled.

export async function GET(req: NextRequest) {
  return forecastRequest(req, 'read', async (ctx, vehicle) => {
    const list = await listPlans(ctx, { vehicle, includeArchived: req.nextUrl.searchParams.get('archived') === '1' })
    if (req.nextUrl.searchParams.get('initial') !== '1') return list
    const initialPlan = list.plans[0] ? await getPlan(ctx, { vehicle, planId: list.plans[0].id }) : null
    return { ...list, initialPlan }
  })
}

export async function POST(req: NextRequest) {
  const body = await readJson(req)
  return forecastRequest(req, 'write', (ctx, vehicle) =>
    createPlan(ctx, {
      vehicle,
      kind: body.kind,
      name: body.name,
      scenario: body.scenario ?? null,
      fiscalYear: body.fiscalYear,
      horizonMonths: body.horizonMonths,
      endMonth: body.endMonth,
      actualsCutoff: body.actualsCutoff ?? null,
      includeConstruction: body.includeConstruction === true,
      seed: body.seed,
    }), body.group ?? null)
}
