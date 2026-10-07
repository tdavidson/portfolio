import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
// management_company domain (lib/access/route-domains.ts). The middleware has already checked the
// caller's grant for this route + method; these resolve identity and keep the demo out of writes.
import { assertReadAccess, assertWriteAccess } from '@/lib/api-helpers'
import { dbError } from '@/lib/api-error'
import { listMancoVehicles } from '@/lib/accounting/load'
import { chartForVehicleKind } from '@/lib/accounting/chart'
import { MANCO_KIND } from '@/lib/vehicle-kinds'
import { loadAccessContext } from '@/lib/access/effective'
import { canSeeVehicle } from '@/lib/access/scope'

// GET — the fund's management companies, with enough state for the section's landing page to
// distinguish "not set up yet" from "set up and empty".
export async function GET() {
  const supabase = await createClient()
  const admin = createAdminClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  const gate = await assertReadAccess(admin, user.id)
  if (gate instanceof NextResponse) return gate

  // Only the caller's entities.
  const access = await loadAccessContext(admin, gate.fundId, gate.userId, gate.role)
  const vehicles = (await listMancoVehicles(admin, gate.fundId)).filter(v => canSeeVehicle(access, v.id))
  if (vehicles.length === 0) return NextResponse.json([])

  // WHICH MANCO ACCOUNTS ARE MISSING, not merely whether a chart exists.
  //
  // "Has it any accounts at all" is the wrong question, and a vehicle CONVERTED from a fund to a
  // management company is why: it arrives here carrying a full fund chart — investments at cost,
  // partners' capital, unrealized appreciation — and not one of the accounts a management company
  // needs. A test for emptiness reads that as set up, offers Open instead of Set up books, and
  // leaves it with no salaries account and no way to ask for one.
  //
  // Comparing CODES instead makes the button mean "seed what is missing", which is also what the
  // seeder does. It stays correct for a firm that has added accounts of its own (extra codes are
  // not missing ones), and it is one query for every entity rather than one each.
  const chart = chartForVehicleKind(MANCO_KIND)
  const { data: accounts } = await admin
    .from('chart_of_accounts' as any)
    .select('vehicle_id, code')
    .eq('fund_id', gate.fundId)
    .in('vehicle_id', vehicles.map(v => v.id))
  const codes = new Map<string, Set<string>>()
  for (const a of ((accounts as any[]) ?? [])) {
    const set = codes.get(a.vehicle_id) ?? new Set<string>()
    set.add(a.code as string)
    codes.set(a.vehicle_id, set)
  }

  return NextResponse.json(vehicles.map(v => {
    const have = codes.get(v.id) ?? new Set<string>()
    const missing = chart.filter(a => !have.has(a.code)).length
    return {
      ...v,
      accountCount: have.size,
      missingAccounts: missing,
      chartSeeded: missing === 0,
      // A chart that exists but is not the manco one — the converted-vehicle case. The landing page
      // says so, because "Set up books" on an entity that plainly has accounts needs an explanation.
      convertedFromOtherChart: missing > 0 && have.size > 0,
      expectedAccounts: chart.length,
    }
  }))
}

/**
 * POST — create a management company. { name }
 *
 * The general vehicle registry (/api/vehicles) can also create one, and does the same thing. This
 * exists because that route is gated on `accounting`: without it, someone granted only
 * `management_company` would open this section, be told there is no manco yet, and find that the
 * button to add one 403s. A route that can create exactly one kind of vehicle is a small price for
 * the section standing on its own grant.
 *
 * `kind` is not a parameter. This is the management-company section; anything else created here
 * would be a vehicle the section then refuses to show.
 */
export async function POST(req: NextRequest) {
  const supabase = await createClient()
  const admin = createAdminClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  const gate = await assertWriteAccess(admin, user.id)
  if (gate instanceof NextResponse) return gate

  const body = await req.json().catch(() => ({}))
  const name = typeof body?.name === 'string' ? body.name.trim() : ''
  if (!name) return NextResponse.json({ error: 'A name is required' }, { status: 400 })

  const { data, error } = await admin
    .from('fund_vehicles' as any)
    .insert({ fund_id: gate.fundId, name, kind: MANCO_KIND, aliases: [], active: true })
    .select('id, name, kind, active')
    .single()
  if (error) {
    // unique (fund_id, name) — and the clash may be with a FUND of the same name, so the message
    // says "vehicle" rather than "management company".
    if ((error as any).code === '23505') {
      return NextResponse.json({ error: 'A vehicle with that name already exists' }, { status: 409 })
    }
    return dbError(error, 'manco-vehicles')
  }
  return NextResponse.json(data)
}
