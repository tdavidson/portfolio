import { NextRequest } from 'next/server'
import { publishPlan } from '@/lib/forecast/service'
import { forecastRequest, readJson } from '@/lib/forecast/http'

// Freeze the plan as an immutable version. status 'approved' makes it the budget baseline (one per
// plan); 'published' is a revision or a forecast snapshot.

export async function POST(req: NextRequest, props: { params: Promise<{ id: string }> }) {
  const { id } = await props.params
  const body = await readJson(req)
  return forecastRequest(req, 'write', (ctx, vehicle) =>
    publishPlan(ctx, {
      vehicle,
      planId: id,
      expectedRevision: body.expectedRevision,
      status: body.status,
      label: body.label ?? null,
      notes: body.notes ?? null,
    }), body.group ?? null)
}
