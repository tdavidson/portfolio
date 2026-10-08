import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { resolveHoldingVehicle } from '@/lib/portfolio/fof-register'
// portfolio domain, investments feature (lib/access/route-domains.ts).
import { assertReadAccess, assertWriteAccess } from '@/lib/api-helpers'
import { ACTUAL_BOOK } from '@/lib/accounting/books'
import { loadAccessContext } from '@/lib/access/effective'
import { canSeeVehicle, scopeCompanyRows, visibleVehicleIds } from '@/lib/access/scope'
import { companyDeleteDenial } from '@/lib/access/company-delete'
import { loadEntityScope } from '@/lib/access/entity-scope'
import { FUND_REVIEW_TYPES, scopeFundReviews } from '@/lib/portfolio/fof-review-types'

// One fund holding and its terms.
export async function GET(req: NextRequest, props: { params: Promise<{ id: string }> }) {
  const params = await props.params;
  const supabase = await createClient()
  const admin = createAdminClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  const gate = await assertReadAccess(admin, user.id)
  if (gate instanceof NextResponse) return gate

  const [holding, terms, events, navs] = await Promise.all([
    admin.from('companies').select('id, name, holding_type')
      .eq('id', params.id).eq('fund_id', gate.fundId).maybeSingle(),
    (admin as any).from('fund_holding_terms').select('*')
      .eq('company_id', params.id).eq('fund_id', gate.fundId),
    (admin as any).from('fund_capital_events').select('*')
      .eq('company_id', params.id).eq('fund_id', gate.fundId).order('event_date'),
    (admin as any).from('fund_nav_statements').select('*')
      .eq('company_id', params.id).eq('fund_id', gate.fundId).order('as_of_date', { ascending: false }),
  ])

  if (!holding.data) return NextResponse.json({ error: 'Not found' }, { status: 404 })

  // A holding two funds commit to is one company row; the gate admitted the caller on either.
  // Everything per-entity — terms, notices, statements — is shown for THEIR entities only.
  const access = await loadAccessContext(admin, gate.fundId, gate.userId, gate.role)
  const visible = visibleVehicleIds(access)
  terms.data = scopeCompanyRows((terms.data as any[]) ?? [], visible, 'vehicle_id')
  events.data = scopeCompanyRows((events.data as any[]) ?? [], visible, 'vehicle_id')
  navs.data = scopeCompanyRows((navs.data as any[]) ?? [], visible, 'vehicle_id')

  // THE ENTITIES THAT HOLD THIS FUND, of those the caller can see — from its register rows (nothing
  // on `companies` carries the vehicle). The panel shows one entity at a time: two entities' positions
  // in one fund are two positions (lib/portfolio/fof-holdings.ts).
  const entityIds = Array.from(new Set([
    ...((terms.data as any[]) ?? []), ...((events.data as any[]) ?? []), ...((navs.data as any[]) ?? []),
  ].map(r => r.vehicle_id).filter(Boolean))) as string[]
  const requested = req.nextUrl.searchParams.get('entity')
  const lookup = Array.from(new Set([...entityIds, ...(requested ? [requested] : [])]))
  const { data: vehicleRows } = lookup.length > 0
    ? await admin.from('fund_vehicles' as any).select('id, name').eq('fund_id', gate.fundId).in('id', lookup)
    : { data: [] as any[] }
  const names = new Map(((vehicleRows as any[]) ?? []).map(v => [v.id as string, v.name as string]))
  const entities = entityIds.filter(id => names.has(id))
    .map(id => ({ id, name: names.get(id)! }))
    .sort((a, b) => a.name.localeCompare(b.name))

  // The one asked for when it is in this fund and the caller's (it may hold nothing here yet — the
  // first notice or statement names it), else the holding's first entity, else none.
  const selected = requested && names.has(requested) && canSeeVehicle(access, requested)
    ? requested
    : entities[0]?.id ?? null
  // Legacy rows naming no entity belong with the holding's only entity, or stand alone when it has none.
  const forEntity = (rows: any[]) => rows.filter(r =>
    (r.vehicle_id ?? null) === selected || (r.vehicle_id == null && entities.length <= 1))

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
    holding: holding.data,
    terms: forEntity((terms.data as any[]) ?? []).sort((a, b) => (a.vehicle_id ? 0 : 1) - (b.vehicle_id ? 0 : 1))[0] ?? null,
    events: forEntity((events.data as any[]) ?? []),
    navStatements: forEntity((navs.data as any[]) ?? []),
    /** The entity shown; null until the holding's first notice or statement names one. */
    vehicleId: selected,
    /** Every entity of this holding the caller can see, by name. */
    vehicles: entities,
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

// DELETE — the holding, cascading its terms, register and NAV statements.
//
// REFUSED once anything has posted. A register row carrying an investment_transaction_id is
// represented in the ledger; deleting the holding behind the ledger's back leaves postings
// referencing a holding that no longer exists.
export async function DELETE(_req: NextRequest, props: { params: Promise<{ id: string }> }) {
  const params = await props.params;
  const supabase = await createClient()
  const admin = createAdminClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  const gate = await assertWriteAccess(admin, user.id)
  if (gate instanceof NextResponse) return gate

  // Deleting removes the holding for every entity that commits to it, so a member may delete only
  // a holding wholly theirs.
  const deleteDenied = await companyDeleteDenial(admin, await loadEntityScope(admin, gate), params.id)
  if (deleteDenied) return NextResponse.json({ error: deleteDenied.replace('this company', 'this fund') }, { status: 403 })

  const { count } = await (admin as any)
    .from('fund_capital_events')
    .select('id', { count: 'exact', head: true })
    .eq('fund_id', gate.fundId)
    .eq('company_id', params.id)
    .not('investment_transaction_id', 'is', null)

  if ((count ?? 0) > 0) {
    return NextResponse.json({
      error: `This holding has ${count} confirmed event(s) posted to the ledger. `
           + `Reverse those entries before deleting the holding.`,
    }, { status: 409 })
  }

  const { count: navCount } = await (admin as any)
    .from('fund_nav_statements')
    .select('id', { count: 'exact', head: true })
    .eq('fund_id', gate.fundId)
    .eq('company_id', params.id)
    .not('investment_transaction_id', 'is', null)
  if ((navCount ?? 0) > 0) {
    return NextResponse.json({
      error: `This holding has ${navCount} NAV statement(s) with a mark on the ledger. `
           + `Delete its NAV statements first — deleting one takes its mark off the ledger.`,
    }, { status: 409 })
  }

  // The holding's own accounts (1100-<id>, 1200-<id>, …). chart_of_accounts.company_id is
  // ON DELETE SET NULL, so deleting the company ORPHANS these rather than removing them —
  // they linger in the chart with a null company_id, named after a holding that no longer
  // exists. Remove them here instead, but only once we know they carry nothing.
  const { data: acctRows } = await admin
    .from('chart_of_accounts' as any)
    .select('id, code')
    .eq('fund_id', gate.fundId)
    .eq('company_id', params.id)
  const acctIds = ((acctRows as any[]) ?? []).map(a => a.id)

  if (acctIds.length > 0) {
    // A posting against one of these accounts means this holding is in the ledger by some
    // path the register checks above do not cover — a transaction recorded directly, say.
    // Deleting then would strand postings pointing at accounts for a deleted holding.
    const { count: postingCount } = await admin
      .from('journal_postings' as any)
      .select('id', { count: 'exact', head: true })
      .eq('book', ACTUAL_BOOK)
      .eq('fund_id', gate.fundId)
      .in('account_id', acctIds)

    if ((postingCount ?? 0) > 0) {
      return NextResponse.json({
        error: `This holding's accounts carry ${postingCount} ledger posting(s). `
             + `Reverse the entries behind them before deleting the holding.`,
      }, { status: 409 })
    }
  }

  const { error } = await admin
    .from('companies').delete().eq('id', params.id).eq('fund_id', gate.fundId)
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })

  // After the company is gone: its accounts now have a null company_id, so delete by id.
  if (acctIds.length > 0) {
    const { error: acctErr } = await admin
      .from('chart_of_accounts' as any).delete().eq('fund_id', gate.fundId).in('id', acctIds)
    // The holding is already gone; a failure here leaves tidy-up, not corruption.
    if (acctErr) {
      return NextResponse.json({
        ok: true,
        warning: `The holding was deleted, but ${acctIds.length} of its chart accounts could not be removed: ${acctErr.message}`,
      })
    }
  }

  return NextResponse.json({ ok: true, accountsRemoved: acctIds.length })
}
