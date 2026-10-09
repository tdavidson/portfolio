import { NextRequest } from 'next/server'
import { getPlan, savePlan } from '@/lib/forecast/service'
import { forecastRequest, readJson } from '@/lib/forecast/http'

// One plan. GET returns it with its rules, overrides, versions and freshness; PATCH applies a change
// (plan fields, rules, month overrides — or nothing, which recompiles against today's actuals) and
// requires the revision the caller loaded, answering 409 when someone saved in between.

export async function GET(req: NextRequest, props: { params: Promise<{ id: string }> }) {
  const { id } = await props.params
  return forecastRequest(req, 'read', (ctx, vehicle) => getPlan(ctx, { vehicle, planId: id }))
}

export async function PATCH(req: NextRequest, props: { params: Promise<{ id: string }> }) {
  const { id } = await props.params
  const body = await readJson(req)
  return forecastRequest(req, 'write', (ctx, vehicle) =>
    savePlan(ctx, {
      vehicle,
      planId: id,
      expectedRevision: body.expectedRevision,
      patch: body.patch,
      rules: body.rules,
      removeRules: body.removeRules,
      overrides: body.overrides,
    }), body.group ?? null)
}
