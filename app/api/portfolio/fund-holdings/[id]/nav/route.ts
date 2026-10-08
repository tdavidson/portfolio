import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { resolveHoldingVehicle } from '@/lib/portfolio/fof-register'
import { deleteNavStatement, editNavStatement, rebookNavsFrom, saveNavStatement, type NavFields } from '@/lib/portfolio/fof-nav'
// portfolio domain, investments feature (lib/access/route-domains.ts).
import { assertReadAccess, assertWriteAccess } from '@/lib/api-helpers'
import { loadAccessContext } from '@/lib/access/effective'
import { canSeeVehicle, scopeCompanyRows, visibleVehicleIds } from '@/lib/access/scope'

// Manager NAV statements for one fund holding, newest valuation date first.
export async function GET(_req: NextRequest, props: { params: Promise<{ id: string }> }) {
  const params = await props.params;
  const supabase = await createClient()
  const admin = createAdminClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  const gate = await assertReadAccess(admin, user.id)
  if (gate instanceof NextResponse) return gate

  const { data } = await (admin as any)
    .from('fund_nav_statements').select('*')
    .eq('fund_id', gate.fundId).eq('company_id', params.id)
    .order('as_of_date', { ascending: false })
  // Only the caller's entities' statements.
  const access = await loadAccessContext(admin, gate.fundId, gate.userId, gate.role)
  return NextResponse.json({ navStatements: scopeCompanyRows((data as any[]) ?? [], visibleVehicleIds(access), 'vehicle_id') })
}

/** The statement's figures present in a request body. Absent keys stay absent; '' clears a reported figure. */
function navFields(body: any): Partial<NavFields> {
  const out: Partial<NavFields> = {}
  if ('reportedNav' in body) out.reportedNav = Number(body.reportedNav)
  if ('basis' in body) out.basis = body.basis
  if ('receivedDate' in body) out.receivedDate = body.receivedDate || null
  for (const k of ['reportedContributions', 'reportedDistributions', 'reportedUnfunded'] as const) {
    if (k in body) out[k] = body[k] === null || body[k] === '' ? null : Number(body[k])
  }
  return out
}

/** 404 unless this id is a fund holding in the caller's fund. */
async function notAFundHolding(admin: any, fundId: string, companyId: string): Promise<NextResponse | null> {
  const { data } = await admin.from('companies').select('id, holding_type').eq('id', companyId).eq('fund_id', fundId).maybeSingle()
  return data?.holding_type === 'fund' ? null : NextResponse.json({ error: 'Not found' }, { status: 404 })
}

/** 404 unless the statement is this holding's and belongs to one of the caller's entities. */
async function navDenial(admin: any, gate: { fundId: string; userId: string; role: string }, companyId: string, navId: string): Promise<NextResponse | null> {
  const { data: nav } = await admin.from('fund_nav_statements').select('vehicle_id')
    .eq('id', navId).eq('fund_id', gate.fundId).eq('company_id', companyId).maybeSingle()
  const access = await loadAccessContext(admin, gate.fundId, gate.userId, gate.role)
  return nav && canSeeVehicle(access, nav.vehicle_id ?? null) ? null : NextResponse.json({ error: 'Not found' }, { status: 404 })
}

// POST — record a manager statement and book its mark (lib/portfolio/fof-nav.ts).
// { asOfDate, reportedNav, basis?, receivedDate?, vehicleId?, reportedContributions?, reportedDistributions?, reportedUnfunded? }
//
// A statement for a date already recorded for this entity REPLACES it, and its mark is re-derived:
// the old link is not preserved, because the old mark no longer describes the statement.
// The result's `later` is an array: every newer statement re-booked, oldest first.
//
// { rebook: true, vehicleId } — RE-BOOK the mark of this entity's newest statement against what the
// ledger carries now. A mark is a delta against the ledger, so a ledger changed after it booked (a
// transaction edited by hand) leaves it stale, and the close blocks until it is re-booked.
export async function POST(req: NextRequest, props: { params: Promise<{ id: string }> }) {
  const params = await props.params
  const supabase = await createClient()
  const admin = createAdminClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  const gate = await assertWriteAccess(admin, user.id)
  if (gate instanceof NextResponse) return gate

  const body = await req.json().catch(() => ({}))
  if (body?.rebook === true) return rebook(admin, gate, params.id, body?.vehicleId, user.id)
  if (typeof body?.asOfDate !== 'string') {
    return NextResponse.json({ error: 'asOfDate is required' }, { status: 400 })
  }
  const reportedNav = Number(body?.reportedNav)
  if (!Number.isFinite(reportedNav)) {
    return NextResponse.json({ error: 'reportedNav must be a number' }, { status: 400 })
  }
  const notFund = await notAFundHolding(admin, gate.fundId, params.id)
  if (notFund) return notFund

  // The entity this statement belongs to, inferred from the holding's register when not named. A
  // statement with no entity would hide from the schedule of investments and book nothing.
  const resolved = await resolveHoldingVehicle(admin, gate.fundId, params.id, body?.vehicleId,
    await loadAccessContext(admin, gate.fundId, gate.userId, gate.role))
  if ('error' in resolved) return NextResponse.json({ error: resolved.error }, { status: 400 })

  const result = await saveNavStatement(admin, gate.fundId, user.id, {
    ...navFields(body),
    companyId: params.id,
    vehicleId: resolved.vehicleId,
    asOfDate: body.asOfDate,
    reportedNav,
    source: 'manual',
  })
  if (!result.ok) return NextResponse.json({ error: result.error }, { status: 400 })
  return NextResponse.json(result)
}

// PATCH — correct a statement's figures; its mark is re-derived, and so is every newer statement's.
// { navId, reportedNav?, basis?, receivedDate?, reportedContributions?, reportedDistributions?, reportedUnfunded? }
export async function PATCH(req: NextRequest, props: { params: Promise<{ id: string }> }) {
  const params = await props.params
  const supabase = await createClient()
  const admin = createAdminClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  const gate = await assertWriteAccess(admin, user.id)
  if (gate instanceof NextResponse) return gate

  const body = await req.json().catch(() => ({}))
  if (typeof body?.navId !== 'string') return NextResponse.json({ error: 'navId is required' }, { status: 400 })
  if ('asOfDate' in body) {
    return NextResponse.json({ error: 'The valuation date cannot be changed — delete the statement and record it again.' }, { status: 400 })
  }
  const denied = await navDenial(admin, gate, params.id, body.navId)
  if (denied) return denied

  const result = await editNavStatement(admin, gate.fundId, user.id, body.navId, navFields(body))
  if (!result.ok) return NextResponse.json({ error: result.error }, { status: 400 })
  return NextResponse.json(result)
}

// DELETE ?navId= — take the statement's mark off the ledger, then delete it. Refused, with the
// reason, when the mark cannot be taken back (a closed period).
export async function DELETE(req: NextRequest, props: { params: Promise<{ id: string }> }) {
  const params = await props.params
  const supabase = await createClient()
  const admin = createAdminClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  const gate = await assertWriteAccess(admin, user.id)
  if (gate instanceof NextResponse) return gate

  const navId = req.nextUrl.searchParams.get('navId')
  if (!navId) return NextResponse.json({ error: 'navId is required' }, { status: 400 })
  const denied = await navDenial(admin, gate, params.id, navId)
  if (denied) return denied

  const result = await deleteNavStatement(admin, gate.fundId, user.id, navId)
  if (!result.ok) return NextResponse.json({ error: result.error }, { status: 400 })
  return NextResponse.json(result)
}

async function rebook(
  admin: any, gate: { fundId: string; userId: string; role: string }, companyId: string, vehicleId: unknown, userId: string,
): Promise<NextResponse> {
  if (typeof vehicleId !== 'string' || !vehicleId) return NextResponse.json({ error: 'vehicleId is required' }, { status: 400 })
  const notFund = await notAFundHolding(admin, gate.fundId, companyId)
  if (notFund) return notFund
  const access = await loadAccessContext(admin, gate.fundId, gate.userId, gate.role)
  if (!canSeeVehicle(access, vehicleId)) return NextResponse.json({ error: 'Not found' }, { status: 404 })

  const { data: newest, error } = await admin.from('fund_nav_statements').select('as_of_date')
    .eq('fund_id', gate.fundId).eq('company_id', companyId).eq('vehicle_id', vehicleId)
    .order('as_of_date', { ascending: false }).limit(1).maybeSingle()
  if (error) return NextResponse.json({ error: `The statements could not be read: ${error.message}` }, { status: 500 })
  if (!newest) return NextResponse.json({ error: 'This entity has no statement for this fund to re-book.' }, { status: 400 })

  const [booking] = await rebookNavsFrom(admin, gate.fundId, userId, { companyId, vehicleId, since: newest.as_of_date, inclusive: true })
  if (!booking) return NextResponse.json({ error: 'This entity has no statement for this fund to re-book.' }, { status: 400 })
  return NextResponse.json({ ok: true, booking })
}
