import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
// lp_capital domain, gated on the lp_tracking switch (lib/access/route-domains.ts). The middleware
// has already checked the caller's grant for this route + method.
import { assertReadAccess, assertWriteAccess } from '@/lib/api-helpers'
import { resolveGroupOr400 } from '@/lib/accounting/http-vehicle'
import { vehicleIdByName } from '@/lib/accounting/vehicle-id'
import { outcomeResponse } from '@/lib/service-outcome'
import { rateLimit } from '@/lib/rate-limit'
import { loadVehicleRecordSource } from '@/lib/admin-reporting/load'
import { listAdminPulls, previewAdminPull, saveAdminPull, setVehicleRecordSource } from '@/lib/admin-reporting/store'
import { positionsFromCsv } from '@/lib/admin-reporting/csv'
import { adapterFor, pullFromAdmin } from '@/lib/admin-reporting/adapters'
import { fundAdminMcpServers } from '@/lib/mcp-client/servers'

// An admin-reported vehicle's administrator figures (lib/admin-reporting).
//
//   GET  ?group=…                                   → { recordSource, provider, fundRef, administrators, pulls }
//   PUT  { group, record_source, provider?, fund_ref? } → set who keeps the vehicle's books
//   POST { group, step: 'pull', as_of }              → fetch from the administrator's MCP server with the caller's own sign-in, and check
//   POST { group, step: 'preview', figures | csv }   → check figures given (or a CSV), save nothing
//   POST { group, step: 'save', figures, raw? }      → check again and save; the person's click is the confirmation
//
// A CSV carries the partners; its date, source and fund figures come alongside it:
//   { csv, as_of, source, fund: { irr, tvpi, dpi } }

async function gateFor(req: NextRequest, write: boolean) {
  const supabase = await createClient()
  const admin = createAdminClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return { error: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }) }
  const gate = write ? await assertWriteAccess(admin, user.id) : await assertReadAccess(admin, user.id)
  if (gate instanceof NextResponse) return { error: gate }
  return { admin, user, gate }
}

async function vehicleFor(admin: ReturnType<typeof createAdminClient>, gate: any, requested: unknown) {
  const group = await resolveGroupOr400(admin, gate, typeof requested === 'string' ? requested : null)
  if (group instanceof NextResponse) return { error: group }
  const id = await vehicleIdByName(admin, gate.fundId, group)
  if (!id) return { error: NextResponse.json({ error: 'Unknown vehicle' }, { status: 400 }) }
  return { vehicle: { id, name: group } }
}

export async function GET(req: NextRequest) {
  const g = await gateFor(req, false)
  if ('error' in g) return g.error
  const v = await vehicleFor(g.admin, g.gate, req.nextUrl.searchParams.get('group'))
  if ('error' in v) return v.error
  const [source, pulls] = await Promise.all([
    loadVehicleRecordSource(g.admin, g.gate.fundId, v.vehicle.id),
    listAdminPulls(g.admin, g.gate.fundId, v.vehicle.id),
  ])
  // Any fund administrator's MCP server can be a vehicle's source; builtInPull says whether the app's
  // own Pull button reads it, or the assistant (or a CSV) does.
  const administrators = fundAdminMcpServers().map(s => ({ id: s.id, name: s.name, builtInPull: !!adapterFor(s) }))
  return NextResponse.json({ vehicle: v.vehicle.name, ...source, administrators, pulls })
}

export async function PUT(req: NextRequest) {
  const g = await gateFor(req, true)
  if ('error' in g) return g.error
  const body = await req.json().catch(() => ({}))
  const v = await vehicleFor(g.admin, g.gate, body?.group)
  if ('error' in v) return v.error
  return outcomeResponse(await setVehicleRecordSource(g.admin, g.gate.fundId, v.vehicle.id, {
    recordSource: body?.record_source, provider: body?.provider, fundRef: body?.fund_ref,
  }))
}

export async function POST(req: NextRequest) {
  const g = await gateFor(req, true)
  if ('error' in g) return g.error
  const body = await req.json().catch(() => ({}))
  const v = await vehicleFor(g.admin, g.gate, body?.group)
  if ('error' in v) return v.error
  const { admin, user, gate } = g
  const vehicle = v.vehicle

  const source = await loadVehicleRecordSource(admin, gate.fundId, vehicle.id)
  if (source.recordSource !== 'admin') {
    return NextResponse.json({ error: `${vehicle.name} keeps its own books. Set it to report its administrator's figures first.` }, { status: 409 })
  }

  const step = body?.step
  if (step === 'pull') {
    const limited = await rateLimit({ key: `admin-pull:${user.id}`, limit: 20, windowSeconds: 600 })
    if (limited) return limited
    const pulled = await pullFromAdmin(admin, user.id, source.provider, source.fundRef, String(body?.as_of ?? ''))
    if (!pulled.ok) return NextResponse.json({ error: pulled.error }, { status: 'viaAssistant' in pulled ? 400 : 502 })
    const checked = await previewAdminPull(admin, gate.fundId, vehicle, pulled.input)
    return outcomeResponse(checked, value => ({ ...value, raw: pulled.raw }))
  }

  let figures: unknown = body?.figures
  if (step === 'preview' && typeof body?.csv === 'string') {
    if (body.csv.length > 2_000_000) return NextResponse.json({ error: 'The file is too large.' }, { status: 413 })
    const positions = positionsFromCsv(body.csv)
    if (typeof positions === 'string') return NextResponse.json({ error: positions }, { status: 400 })
    figures = { as_of: body?.as_of, source: body?.source || 'CSV upload', positions, fund: body?.fund ?? {} }
  }
  if (step === 'preview') return outcomeResponse(await previewAdminPull(admin, gate.fundId, vehicle, figures))
  if (step === 'save') {
    return outcomeResponse(await saveAdminPull(admin, {
      // resolveGroupOr400 has already checked the caller may write to this vehicle.
      fundId: gate.fundId, userId: user.id, vehicleNames: null, channel: 'app',
    }, vehicle, figures, body?.raw))
  }
  return NextResponse.json({ error: "step must be 'pull', 'preview' or 'save'" }, { status: 400 })
}
