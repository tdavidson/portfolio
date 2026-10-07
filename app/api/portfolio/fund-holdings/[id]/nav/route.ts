import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { resolveHoldingVehicle } from '@/lib/portfolio/fof-register'
// portfolio domain, investments feature (lib/access/route-domains.ts).
import { assertReadAccess, assertWriteAccess } from '@/lib/api-helpers'
import { loadAccessContext } from '@/lib/access/effective'
import { scopeCompanyRows, visibleVehicleIds } from '@/lib/access/scope'

const BASES = ['final', 'preliminary', 'estimate']

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

// POST — record a manager statement.
// { asOfDate, reportedNav, basis?, receivedDate?, vehicleId?,
//   reportedContributions?, reportedDistributions?, reportedUnfunded? }
export async function POST(req: NextRequest, props: { params: Promise<{ id: string }> }) {
  const params = await props.params;
  const supabase = await createClient()
  const admin = createAdminClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  const gate = await assertWriteAccess(admin, user.id)
  if (gate instanceof NextResponse) return gate

  const body = await req.json().catch(() => ({}))
  if (typeof body?.asOfDate !== 'string') {
    return NextResponse.json({ error: 'asOfDate is required' }, { status: 400 })
  }
  const reportedNav = Number(body?.reportedNav)
  if (!Number.isFinite(reportedNav)) {
    return NextResponse.json({ error: 'reportedNav must be a number' }, { status: 400 })
  }

  // UPSERT on (company_id, as_of_date): a corrected statement REPLACES the one we had for
  // that valuation date. A second row would win or lose by insertion order, which is not a
  // property anyone should have to reason about when reading a NAV.
  //
  // Deliberately does NOT clear investment_transaction_id. If the original already posted, a
  // restatement needs a correcting mark — until then the link is the honest record of what
  // was posted, not something to quietly orphan.
  // The entity this statement belongs to. Inferred from the holding's register, because a null
  // here would hide the NAV from the schedule of investments and leave the position carried at
  // cost — a quieter failure than the unconfirmable notice the same bug caused on the event side.
  const resolved = await resolveHoldingVehicle(admin, gate.fundId, params.id, body?.vehicleId,
    await loadAccessContext(admin, gate.fundId, gate.userId, gate.role))
  if ('error' in resolved) return NextResponse.json({ error: resolved.error }, { status: 400 })

  const { error } = await (admin as any)
    .from('fund_nav_statements')
    .upsert({
      fund_id: gate.fundId,
      vehicle_id: resolved.vehicleId,
      company_id: params.id,
      as_of_date: body.asOfDate,
      received_date: body?.receivedDate ?? null,
      reported_nav: reportedNav,
      basis: BASES.includes(body?.basis) ? body.basis : 'final',
      reported_contributions: body?.reportedContributions ?? null,
      reported_distributions: body?.reportedDistributions ?? null,
      reported_unfunded: body?.reportedUnfunded ?? null,
      source: 'manual',
      created_by: user.id,
    }, { onConflict: 'company_id,vehicle_id,as_of_date' })

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ ok: true })
}
