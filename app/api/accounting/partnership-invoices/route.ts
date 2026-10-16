import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
// accounting domain (lib/access/route-domains.ts). The middleware has already checked the caller's
// grant for this route + method; resolveGroupOr400 checks BOTH entities of an invoice, so a manco
// side still needs the management-company grant.
import { assertReadAccess, assertWriteAccess } from '@/lib/api-helpers'
import { resolveGroupOr400 } from '@/lib/accounting/http-vehicle'
import { vehicleIdByName, vehicleNameById } from '@/lib/accounting/vehicle-id'
import { listVehiclesWithId } from '@/lib/accounting/load'
import { previousQuarter } from '@/lib/accounting/receipts-core'
import { ensureIntercompanyAccounts } from '@/lib/accounting/intercompany'
import {
  previewPartnershipInvoice, createPartnershipInvoice, issuePartnershipInvoice, voidPartnershipInvoice,
  listPartnershipInvoices, unbilledByCounterparty, getPartnershipInvoice,
} from '@/lib/accounting/partnership-invoices'

type Gate = Exclude<Awaited<ReturnType<typeof assertReadAccess>>, NextResponse>

/** The billed entity, by id, checked the same way as the billing one. */
async function counterparty(admin: ReturnType<typeof createAdminClient>, gate: Gate, id: unknown): Promise<{ vehicleId: string; name: string } | NextResponse> {
  const vehicleId = typeof id === 'string' ? id : ''
  const name = vehicleId ? await vehicleNameById(admin, gate.fundId, vehicleId) : null
  if (!name) return NextResponse.json({ error: 'The entity to bill is not in this fund.' }, { status: 400 })
  const ok = await resolveGroupOr400(admin, gate, name)
  if (ok instanceof NextResponse) return ok
  return { vehicleId, name }
}

/**
 * GET ?group=<billing entity>
 *   → { invoices, unbilled, counterparties, defaultQuarter }
 * GET ?group=…&to=<entity id>&year=2026&quarter=3
 *   → the preview: what an invoice for that quarter would bill
 * GET ?group=…&id=<invoice id>
 *   → one invoice with its lines
 */
export async function GET(req: NextRequest) {
  const supabase = await createClient()
  const admin = createAdminClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  const gate = await assertReadAccess(admin, user.id)
  if (gate instanceof NextResponse) return gate
  const sp = req.nextUrl.searchParams
  const group = await resolveGroupOr400(admin, gate, sp.get('group'))
  if (group instanceof NextResponse) return group
  const vehicleId = await vehicleIdByName(admin, gate.fundId, group)
  if (!vehicleId) return NextResponse.json({ error: `Unknown vehicle "${group}".` }, { status: 400 })

  const id = sp.get('id')
  if (id) {
    const inv = await getPartnershipInvoice(admin, gate.fundId, id)
    if (!inv || (inv.from.vehicleId !== vehicleId && inv.to.vehicleId !== vehicleId)) return NextResponse.json({ error: 'Invoice not found' }, { status: 404 })
    const other = await counterparty(admin, gate, inv.from.vehicleId === vehicleId ? inv.to.vehicleId : inv.from.vehicleId)
    if (other instanceof NextResponse) return other
    return NextResponse.json({ invoice: inv })
  }

  if (sp.get('to')) {
    const to = await counterparty(admin, gate, sp.get('to'))
    if (to instanceof NextResponse) return to
    const preview = await previewPartnershipInvoice(admin, gate.fundId, {
      fromVehicleId: vehicleId, toVehicleId: to.vehicleId, year: Number(sp.get('year')), quarter: Number(sp.get('quarter')),
    })
    if ('error' in preview) return NextResponse.json({ error: preview.error }, { status: 400 })
    return NextResponse.json({ preview })
  }

  const [invoices, unbilled, vehicles] = await Promise.all([
    listPartnershipInvoices(admin, gate.fundId, vehicleId),
    unbilledByCounterparty(admin, gate.fundId, vehicleId),
    listVehiclesWithId(admin, gate.fundId),
  ])
  const names = new Map(vehicles.map(v => [v.id, v.name]))
  return NextResponse.json({
    vehicleId,
    invoices: invoices.map(i => ({ ...i, from_name: names.get(i.from_vehicle_id) ?? null, to_name: names.get(i.to_vehicle_id) ?? null })),
    unbilled,
    // Who this entity can bill: every other fund vehicle (a manco is not billed for fund expenses).
    counterparties: vehicles.filter(v => v.id && v.id !== vehicleId),
    defaultQuarter: previousQuarter(new Date().toISOString().slice(0, 10)),
  })
}

/**
 * POST
 *   { group, action: 'create', to, year, quarter, invoiceDate?, memo? }  freeze the quarter into a draft
 *   { group, action: 'issue', id }   book the fund's side (Dr partnership expenses, Cr due to <group>)
 *   { group, action: 'void', id }    release its lines; an issued one needs the fund's entry voided first
 *   { group, action: 'accounts', to } add "Due from <to>" (and "Due to <to>") to group's chart
 */
export async function POST(req: NextRequest) {
  const supabase = await createClient()
  const admin = createAdminClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  const gate = await assertWriteAccess(admin, user.id)
  if (gate instanceof NextResponse) return gate
  const body = await req.json().catch(() => ({}))
  const group = await resolveGroupOr400(admin, gate, body?.group)
  if (group instanceof NextResponse) return group
  const vehicleId = await vehicleIdByName(admin, gate.fundId, group)
  if (!vehicleId) return NextResponse.json({ error: `Unknown vehicle "${group}".` }, { status: 400 })

  if (body?.action === 'create') {
    const to = await counterparty(admin, gate, body?.to)
    if (to instanceof NextResponse) return to
    const res = await createPartnershipInvoice(admin, gate.fundId, user.id, {
      fromVehicleId: vehicleId, toVehicleId: to.vehicleId,
      year: Number(body?.year), quarter: Number(body?.quarter),
      invoiceDate: typeof body?.invoiceDate === 'string' ? body.invoiceDate : null,
      memo: typeof body?.memo === 'string' ? body.memo : null,
    })
    if ('error' in res) return NextResponse.json({ error: res.error }, { status: res.status ?? 400 })
    return NextResponse.json({ ok: true, ...res })
  }

  if (body?.action === 'issue' || body?.action === 'void') {
    const id = String(body?.id ?? '')
    const inv = await getPartnershipInvoice(admin, gate.fundId, id)
    // Only the billing entity issues or voids its own invoices.
    if (!inv || inv.from.vehicleId !== vehicleId) return NextResponse.json({ error: 'Invoice not found' }, { status: 404 })
    const to = await counterparty(admin, gate, inv.to.vehicleId)
    if (to instanceof NextResponse) return to
    const res = body.action === 'issue'
      ? await issuePartnershipInvoice(admin, gate.fundId, user.id, id)
      : await voidPartnershipInvoice(admin, gate.fundId, id)
    if ('error' in res) return NextResponse.json({ error: res.error }, { status: res.status ?? 400 })
    return NextResponse.json(res)
  }

  if (body?.action === 'accounts') {
    const to = await counterparty(admin, gate, body?.to)
    if (to instanceof NextResponse) return to
    if (to.vehicleId === vehicleId) return NextResponse.json({ error: 'An entity cannot bill itself.' }, { status: 400 })
    try {
      const ids = await ensureIntercompanyAccounts(admin, gate.fundId, group, to)
      return NextResponse.json({ ok: true, receivableAccountId: ids.receivableAccountId })
    } catch (e) {
      return NextResponse.json({ error: (e as Error).message }, { status: 400 })
    }
  }

  return NextResponse.json({ error: 'action must be create, issue, void or accounts' }, { status: 400 })
}
