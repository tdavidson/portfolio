import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { resolveHoldingVehicle } from '@/lib/portfolio/fof-register'
// portfolio domain, investments feature (lib/access/route-domains.ts).
import { assertReadAccess, assertWriteAccess } from '@/lib/api-helpers'
import { ACTUAL_BOOK } from '@/lib/accounting/books'
import { loadAccessContext } from '@/lib/access/effective'
import { canSeeVehicle, scopeCompanyRows, visibleVehicleIds } from '@/lib/access/scope'

// One fund holding and its terms.
export async function GET(_req: NextRequest, props: { params: Promise<{ id: string }> }) {
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

  // WHICH ENTITY HOLDS THIS FUND, so the panel can ask only when it does not already know. The
  // vehicle lives on the register rows (nothing on `companies` or `fund_holding_terms` carries
  // it), so it is derived from them rather than stored twice. More than one means the register
  // disagrees with itself and the panel asks.
  const vehicleIds = Array.from(new Set([
    ...((events.data as any[]) ?? []), ...((navs.data as any[]) ?? []),
  ].map(r => r.vehicle_id).filter(Boolean))) as string[]
  const { data: vehicleRows } = vehicleIds.length > 0
    ? await admin.from('fund_vehicles' as any).select('id, name').eq('fund_id', gate.fundId).in('id', vehicleIds)
    : { data: [] as any[] }

  return NextResponse.json({
    holding: holding.data,
    terms: ((terms.data as any[]) ?? [])[0] ?? null,
    events: events.data ?? [],
    navStatements: navs.data ?? [],
    /** Null until the first notice names one; a second entry means the register is inconsistent. */
    vehicleId: vehicleIds.length === 1 ? vehicleIds[0] : null,
    vehicles: ((vehicleRows as any[]) ?? []).map(v => ({ id: v.id as string, name: v.name as string })),
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
  // a holding none of the other entities is linked to.
  const access = await loadAccessContext(admin, gate.fundId, gate.userId, gate.role)
  if (!access.vehicles.all) {
    const { data: links } = await (admin as any).from('company_vehicles').select('vehicle_id').eq('company_id', params.id)
    if (((links as any[]) ?? []).some(l => !canSeeVehicle(access, l.vehicle_id))) {
      return NextResponse.json({ error: 'Another entity also holds this fund. Ask an admin to remove it.' }, { status: 403 })
    }
  }

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
      error: `This holding has ${navCount} posted valuation mark(s). Reverse them before deleting.`,
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
