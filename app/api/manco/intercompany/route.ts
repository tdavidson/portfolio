import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
// management_company domain (lib/access/route-domains.ts). The middleware has already checked the
// caller's grant for this route + method; these resolve identity and keep the demo out of writes.
import { assertReadAccess, assertWriteAccess } from '@/lib/api-helpers'
import { resolveMancoGroupOr400 } from '@/lib/accounting/http-vehicle'
import { vehicleIdByName } from '@/lib/accounting/vehicle-id'
import { listVehiclesWithId } from '@/lib/accounting/load'
import {
  INTERCOMPANY_KINDS, postIntercompanyCharge, settleIntercompanyCharge,
  listIntercompanyCharges, intercompanyBalances, type IntercompanyKind,
} from '@/lib/accounting/intercompany'

const isDate = (v: unknown): v is string => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v)

// GET — the charge register and balances for one management company, plus the counterparties it
// can charge (every other vehicle in the fund). `?group=<manco>`
export async function GET(req: NextRequest) {
  const supabase = await createClient()
  const admin = createAdminClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  const gate = await assertReadAccess(admin, user.id)
  if (gate instanceof NextResponse) return gate

  const group = await resolveMancoGroupOr400(admin, gate, req.nextUrl.searchParams.get('group'))
  if (group instanceof NextResponse) return group
  const vehicleId = await vehicleIdByName(admin, gate.fundId, group)
  if (!vehicleId) return NextResponse.json({ error: `Unknown vehicle "${group}".` }, { status: 400 })

  const [charges, balances, vehicles] = await Promise.all([
    listIntercompanyCharges(admin, gate.fundId, vehicleId),
    intercompanyBalances(admin, gate.fundId, group),
    listVehiclesWithId(admin, gate.fundId),
  ])

  return NextResponse.json({
    vehicleId,
    charges,
    balances,
    // The funds and SPVs this manco can bill. `listVehiclesWithId` already excludes management
    // companies, which is right for the common case (a manco bills the funds) and means a
    // manco-to-manco charge has to be entered as a journal entry on both sides. That is a real
    // limitation, and the honest place to relax it is here, once a firm asks for it.
    counterparties: vehicles.filter(v => v.id && v.id !== vehicleId),
  })
}

/**
 * POST — record a charge and post BOTH sides, or settle an accrued one.
 *
 *   { group, action: 'charge',  kind, chargeDate, amount, counterpartyVehicleId, direction, memo? }
 *   { group, action: 'settle',  id, settledDate }
 *
 * `direction` is from the management company's point of view — 'receivable' means the manco is
 * billing the counterparty (the ordinary case: a management fee), 'payable' means the counterparty
 * is billing the manco. Expressing it that way rather than as payer/payee ids means the caller
 * cannot silently get the two the wrong way round, which on an intercompany charge is an error that
 * balances perfectly and is invisible until someone reconciles.
 */
export async function POST(req: NextRequest) {
  const supabase = await createClient()
  const admin = createAdminClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  const gate = await assertWriteAccess(admin, user.id)
  if (gate instanceof NextResponse) return gate

  const body = await req.json().catch(() => ({}))
  const group = await resolveMancoGroupOr400(admin, gate, body?.group)
  if (group instanceof NextResponse) return group
  const mancoId = await vehicleIdByName(admin, gate.fundId, group)
  if (!mancoId) return NextResponse.json({ error: `Unknown vehicle "${group}".` }, { status: 400 })

  if (body?.action === 'settle') {
    const id = String(body?.id ?? '')
    if (!id) return NextResponse.json({ error: 'id is required' }, { status: 400 })
    if (!isDate(body?.settledDate)) {
      return NextResponse.json({ error: 'settledDate must be YYYY-MM-DD' }, { status: 400 })
    }
    const res = await settleIntercompanyCharge(admin, gate.fundId, user.id, id, body.settledDate)
    if ('error' in res) return NextResponse.json({ error: res.error }, { status: 400 })
    return NextResponse.json({ ok: true })
  }

  const kind = body?.kind as IntercompanyKind
  if (!INTERCOMPANY_KINDS.includes(kind)) {
    return NextResponse.json({ error: `kind must be one of ${INTERCOMPANY_KINDS.join(', ')}` }, { status: 400 })
  }
  if (!isDate(body?.chargeDate)) {
    return NextResponse.json({ error: 'chargeDate must be YYYY-MM-DD' }, { status: 400 })
  }
  const amount = Number(body?.amount)
  if (!Number.isFinite(amount) || amount <= 0) {
    return NextResponse.json({ error: 'amount must be a positive number' }, { status: 400 })
  }
  const direction = body?.direction === 'payable' ? 'payable' : 'receivable'

  // SCOPED TO THE FUND, like every id that arrives in a request body here. Without this a charge
  // could name another tenant's vehicle, and posting it would create a chart account on their books
  // titled "Due to <our manco>" — a cross-tenant write, not merely a bad reference.
  const counterpartyId = String(body?.counterpartyVehicleId ?? '')
  const { data: counterparty } = await admin
    .from('fund_vehicles' as any)
    .select('id, name')
    .eq('fund_id', gate.fundId).eq('id', counterpartyId).maybeSingle()
  if (!counterparty) {
    return NextResponse.json({ error: 'That counterparty is not a vehicle in this fund.' }, { status: 400 })
  }

  const manco = { vehicleId: mancoId, name: group }
  const other = { vehicleId: (counterparty as any).id as string, name: (counterparty as any).name as string }

  const res = await postIntercompanyCharge(admin, {
    fundId: gate.fundId,
    userId: user.id,
    kind,
    chargeDate: body.chargeDate,
    amount,
    memo: typeof body?.memo === 'string' && body.memo.trim() ? body.memo.trim() : null,
    // receivable: the manco is owed, so the counterparty is the payer.
    payee: direction === 'receivable' ? manco : other,
    payer: direction === 'receivable' ? other : manco,
  })
  if ('error' in res) return NextResponse.json({ error: res.error }, { status: 400 })
  return NextResponse.json({ ok: true, id: res.id })
}
