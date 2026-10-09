import { NextRequest } from 'next/server'
import { deleteFeeLink, listFeeLinks, saveFeeLink } from '@/lib/forecast/service'
import { forecastRequest, readJson } from '@/lib/forecast/http'

// Fee links: which funds pay which management company, and on what billing cycle. GET lists the
// links touching ?group=; PUT and DELETE take { manco, fund, … } and need write on both vehicles,
// which the service checks (the route gate covers accounting + budgeting only).

export async function GET(req: NextRequest) {
  return forecastRequest(req, 'read', (ctx, vehicle) => listFeeLinks(ctx, { vehicle }))
}

export async function PUT(req: NextRequest) {
  const body = await readJson(req)
  return forecastRequest(req, 'write', ctx =>
    saveFeeLink(ctx, {
      manco: body.manco, fund: body.fund, everyMonths: body.everyMonths, anchorMonth: body.anchorMonth,
      direction: body.direction, cashLagMonths: body.cashLagMonths, active: body.active,
    }), body.group ?? body.manco ?? null)
}

export async function DELETE(req: NextRequest) {
  const body = await readJson(req)
  return forecastRequest(req, 'write', ctx => deleteFeeLink(ctx, { manco: body.manco, fund: body.fund }), body.group ?? body.manco ?? null)
}
