import { NextRequest } from 'next/server'
import { createPlan, listPlans } from '@/lib/forecast/service'
import { forecastRequest, readJson } from '@/lib/forecast/http'

// Budget & forecast plans for one vehicle. GET lists them; POST creates one (seeded blank, from
// actuals, or from another plan) and returns it compiled.

export async function GET(req: NextRequest) {
  return forecastRequest(req, 'read', (ctx, vehicle) =>
    listPlans(ctx, { vehicle, includeArchived: req.nextUrl.searchParams.get('archived') === '1' }),
  )
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
