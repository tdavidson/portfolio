import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { resolveHoldingVehicle } from '@/lib/portfolio/fof-register'
import { loadFundRegister } from '@/lib/portfolio/fund-register-read'
// portfolio domain, investments feature (lib/access/route-domains.ts).
import { assertReadAccess, assertWriteAccess } from '@/lib/api-helpers'
import { loadAccessContext } from '@/lib/access/effective'
import { loadEntityScope } from '@/lib/access/entity-scope'
import { FUND_REVIEW_TYPES, scopeFundReviews } from '@/lib/portfolio/fof-review-types'
import { deleteFundHolding } from '@/lib/portfolio/fund-holding-delete'
import { outcomeResponse } from '@/lib/service-outcome'

// One fund holding and its terms.
export async function GET(req: NextRequest, props: { params: Promise<{ id: string }> }) {
  const params = await props.params;
  const supabase = await createClient()
  const admin = createAdminClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  const gate = await assertReadAccess(admin, user.id)
  if (gate instanceof NextResponse) return gate

  const access = await loadAccessContext(admin, gate.fundId, gate.userId, gate.role)
  const reg = await loadFundRegister(admin, gate.fundId, params.id, access, req.nextUrl.searchParams.get('entity'))
  if (!reg.holding) return NextResponse.json({ error: 'Not found' }, { status: 404 })
  const selected = reg.vehicleId

  // What the manager's emails propose for this holding, waiting for review — the shown entity's,
  // and unassigned ones for a caller who may assign them (scopeFundReviews).
  const { data: reviewRows, error: reviewsError } = await (admin as any).from('parsing_reviews')
    .select('id, issue_type, payload, vehicle_id, context_snippet, created_at')
    .eq('fund_id', gate.fundId).eq('company_id', params.id).is('resolution', null)
    .in('issue_type', [...FUND_REVIEW_TYPES]).order('created_at', { ascending: false })
  const reviews = scopeFundReviews(((reviewRows as any[]) ?? []), access)
    .filter(r => r.vehicle_id == null || r.vehicle_id === selected)
  // A failed lookup is not "nothing to review": the panel says so instead of showing an empty list.
  if (reviewsError) console.error('[fund-holdings-id] reviews lookup failed:', reviewsError.message)

  return NextResponse.json({
    holding: reg.holding,
    terms: reg.terms,
    events: reg.events,
    navStatements: reg.navStatements,
    /** The entity shown; null until the holding's first notice or statement names one. */
    vehicleId: selected,
    /** Every entity of this holding the caller can see, by name. */
    vehicles: reg.vehicles,
    /** Open manager-email proposals for this holding (api/review/[id]/resolve approves them). */
    reviews,
    ...(reviewsError ? { reviewsWarning: 'The manager-email proposals for this holding could not be loaded.' } : {}),
  })
}

const TERM_FIELDS: Record<string, string> = {
  managerName: 'manager_name',
  vintageYear: 'vintage_year',
  fundSize: 'fund_size',
  strategy: 'strategy',
  geography: 'geography',
  commitment: 'commitment',
  commitmentDate: 'commitment_date',
  finalCloseDate: 'final_close_date',
  termEndDate: 'term_end_date',
  notes: 'notes',
}

// PATCH — the terms. Upsert, because a holding created outside this route (QuickBooks
// discovery, an import) may have no terms row yet.
export async function PATCH(req: NextRequest, props: { params: Promise<{ id: string }> }) {
  const params = await props.params;
  const supabase = await createClient()
  const admin = createAdminClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  const gate = await assertWriteAccess(admin, user.id)
  if (gate instanceof NextResponse) return gate

  const body = await req.json().catch(() => ({}))
  const patch: Record<string, unknown> = {}
  for (const [key, column] of Object.entries(TERM_FIELDS)) {
    if (key in body) patch[column] = body[key]
  }
  if (Object.keys(patch).length === 0) {
    return NextResponse.json({ error: 'No recognized fields to update' }, { status: 400 })
  }

  // The entity whose commitment this is. Inferred from the register when the caller does not say,
  // and allowed to stay null while the holding has no activity to infer from — the constraint is
  // NULLS NOT DISTINCT, so an unassigned terms row keeps the old one-per-fund rule.
  const access = await loadAccessContext(admin, gate.fundId, gate.userId, gate.role)
  const held = await resolveHoldingVehicle(admin, gate.fundId, params.id, body?.vehicleId, access)
  // A member writes terms only for one of their entities; an entity-less row is an admin's call.
  if ('error' in held && !access.vehicles.all) return NextResponse.json({ error: held.error }, { status: 403 })
  const vehicleId = 'vehicleId' in held ? held.vehicleId : null

  const { error } = await (admin as any).from('fund_holding_terms').upsert({
    fund_id: gate.fundId,
    company_id: params.id,
    vehicle_id: vehicleId,
    ...patch,
    updated_at: new Date().toISOString(),
  }, { onConflict: 'company_id,vehicle_id' })
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })

  return NextResponse.json({ ok: true })
}

// DELETE — the holding, cascading its terms, register and NAV statements. The checks and the
// delete are lib/portfolio/fund-holding-delete.ts, shared with the delete_fund_holding tool.
export async function DELETE(_req: NextRequest, props: { params: Promise<{ id: string }> }) {
  const params = await props.params;
  const supabase = await createClient()
  const admin = createAdminClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  const gate = await assertWriteAccess(admin, user.id)
  if (gate instanceof NextResponse) return gate

  const out = await deleteFundHolding(admin, gate, params.id, () => loadEntityScope(admin, gate))
  return outcomeResponse(out, v => ({ ok: true, accountsRemoved: v.accountsRemoved, ...(v.warning ? { warning: v.warning } : {}) }))
}
