import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
// portfolio domain, investments feature (lib/access/route-domains.ts). The middleware has
// already checked the grant.
import { assertReadAccess, assertWriteAccess } from '@/lib/api-helpers'
import { computeFundPositions } from '@/lib/portfolio/fof-metrics'
import { loadEntityScope } from '@/lib/access/entity-scope'
import { dealEntityProblem, scopeCompanyRows, visibleVehicleIds } from '@/lib/access/scope'

// The fund-of-funds position table: one row per underlying fund, every figure derived.
// Nothing here is stored — see lib/portfolio/fof-metrics.ts for why carrying value is a
// roll-forward rather than a column.
export async function GET(req: NextRequest) {
  const supabase = await createClient()
  const admin = createAdminClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  const gate = await assertReadAccess(admin, user.id)
  if (gate instanceof NextResponse) return gate

  const asOf = req.nextUrl.searchParams.get('asOf') ?? new Date().toISOString().slice(0, 10)

  const [holdings, terms, events, navs] = await Promise.all([
    admin.from('companies').select('id, name')
      .eq('fund_id', gate.fundId).eq('holding_type', 'fund').order('name'),
    (admin as any).from('fund_holding_terms').select('*').eq('fund_id', gate.fundId),
    (admin as any).from('fund_capital_events').select('*').eq('fund_id', gate.fundId),
    (admin as any).from('fund_nav_statements').select('*').eq('fund_id', gate.fundId),
  ])

  // Only fund holdings linked to the caller's entities, and only their entities' calls,
  // distributions and statements — another entity's commitment to the same fund is not theirs.
  const scope = await loadEntityScope(admin, gate)
  const vehicleIds = visibleVehicleIds(scope.access)
  holdings.data = scopeCompanyRows((holdings.data ?? []) as any[], scope.companyIds) as any
  events.data = scopeCompanyRows((events.data ?? []) as any[], vehicleIds, 'vehicle_id')
  navs.data = scopeCompanyRows((navs.data ?? []) as any[], vehicleIds, 'vehicle_id')
  terms.data = scopeCompanyRows((terms.data ?? []) as any[], vehicleIds, 'vehicle_id')

  const termByCompany = new Map((terms.data ?? []).map((t: any) => [t.company_id, t]))

  const positions = computeFundPositions({
    asOf,
    terms: ((holdings.data ?? []) as any[]).map(h => {
      const t: any = termByCompany.get(h.id)
      return {
        companyId: h.id,
        name: h.name,
        managerName: t?.manager_name ?? null,
        vintageYear: t?.vintage_year ?? null,
        strategy: t?.strategy ?? null,
        commitment: Number(t?.commitment ?? 0),
      }
    }),
    events: ((events.data ?? []) as any[]).map(e => ({
      companyId: e.company_id,
      kind: e.kind,
      eventDate: e.event_date,
      amount: Number(e.amount),
      recallableAmount: Number(e.recallable_amount ?? 0),
      charReturnOfCapital: Number(e.char_return_of_capital ?? 0),
      charRealizedGain: Number(e.char_realized_gain ?? 0),
      charIncome: Number(e.char_income ?? 0),
    })),
    navs: ((navs.data ?? []) as any[]).map(n => ({
      companyId: n.company_id,
      asOfDate: n.as_of_date,
      reportedNav: Number(n.reported_nav),
      basis: n.basis,
    })),
  })

  return NextResponse.json({ positions, asOf })
}

// POST — create a fund holding and its terms in one call.
// { name, managerName?, vintageYear?, strategy?, commitment?, commitmentDate?, fundSize?, geography? }
export async function POST(req: NextRequest) {
  const supabase = await createClient()
  const admin = createAdminClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  const gate = await assertWriteAccess(admin, user.id)
  if (gate instanceof NextResponse) return gate

  const body = await req.json().catch(() => ({}))
  const name = typeof body?.name === 'string' ? body.name.trim() : ''
  if (!name) return NextResponse.json({ error: 'name is required' }, { status: 400 })

  // WHICH ENTITY IS COMMITTING. Optional, because a fund can be recorded before anyone decides
  // which entity will hold it, but validated when given: the commitment and everything derived
  // from it (unfunded, % called) belongs to one entity, not to the firm.
  let vehicleId: string | null = null
  if (typeof body?.vehicleId === 'string' && body.vehicleId) {
    const { data: vehicle } = await admin
      .from('fund_vehicles' as any).select('id')
      .eq('fund_id', gate.fundId).eq('id', body.vehicleId).maybeSingle()
    if (!vehicle) return NextResponse.json({ error: 'That entity is not in this fund.' }, { status: 400 })
    vehicleId = body.vehicleId
  }
  // A member records a holding only for one of their entities — one with no entity would be
  // admin-only, and they would lose it the moment they made it.
  const createScope = await loadEntityScope(admin, gate)
  const entityProblem = dealEntityProblem(createScope.access, vehicleId)
  if (entityProblem) return NextResponse.json({ error: entityProblem }, { status: 403 })

  const { data: holding, error } = await admin
    .from('companies')
    .insert({ fund_id: gate.fundId, name, holding_type: 'fund', status: 'active' })
    .select('id').single()
  if (error || !holding) {
    return NextResponse.json({ error: error?.message ?? 'Create failed' }, { status: 500 })
  }

  const { error: termErr } = await (admin as any).from('fund_holding_terms').insert({
    fund_id: gate.fundId,
    company_id: holding.id,
    vehicle_id: vehicleId,
    manager_name: body?.managerName ?? null,
    vintage_year: body?.vintageYear ?? null,
    fund_size: body?.fundSize ?? null,
    strategy: body?.strategy ?? null,
    geography: body?.geography ?? null,
    commitment: Number(body?.commitment ?? 0),
    commitment_date: body?.commitmentDate ?? null,
  })
  if (termErr) return NextResponse.json({ error: termErr.message }, { status: 500 })

  return NextResponse.json({ id: holding.id })
}
