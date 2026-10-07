import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
// management_company domain (lib/access/route-domains.ts). The middleware has already checked the
// grant; this resolves identity and keeps the read-only demo out of writes.
import { assertWriteAccess } from '@/lib/api-helpers'
import { dbError } from '@/lib/api-error'
import { resolveMancoGroupOr400 } from '@/lib/accounting/http-vehicle'
import { vehicleIdByName } from '@/lib/accounting/vehicle-id'
import { chartForVehicleKind } from '@/lib/accounting/chart'
import { MANCO_KIND } from '@/lib/vehicle-kinds'

/**
 * POST — seed a management company's chart of accounts. Body: { group }
 *
 * The manco equivalent of /api/accounting/turn-on, and deliberately much smaller than it. That
 * route also creates a capital account per committed partner, carries a pasted LP snapshot in as
 * opening balances, and flips the vehicle's capital source to the ledger — every one of which is
 * about LPs, and a management company has none. What is left is the chart, so that is all this does.
 *
 * Additive and idempotent, like the accounting chart seeder: it creates what is missing and touches
 * nothing that exists, so it is also how an already-set-up manco picks up an account added to
 * MANAGEMENT_COMPANY_CHART later. Running it twice is a no-op, which matters because the landing
 * page offers the button whenever the chart looks incomplete.
 */
export async function POST(req: NextRequest) {
  const supabase = await createClient()
  const admin = createAdminClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  const gate = await assertWriteAccess(admin, user.id)
  if (gate instanceof NextResponse) return gate

  const body = await req.json().catch(() => ({}))
  const group = await resolveMancoGroupOr400(
    admin, gate, body?.group ?? req.nextUrl.searchParams.get('group'),
  )
  if (group instanceof NextResponse) return group

  const vehicleId = await vehicleIdByName(admin, gate.fundId, group)
  if (!vehicleId) return NextResponse.json({ error: `Unknown vehicle "${group}".` }, { status: 400 })

  const chart = chartForVehicleKind(MANCO_KIND)
  const { data: existing } = await admin
    .from('chart_of_accounts' as any)
    .select('code').eq('fund_id', gate.fundId).eq('vehicle_id', vehicleId)
  const have = new Set(((existing as any[]) ?? []).map(r => r.code as string))
  const missing = chart.filter(a => !have.has(a.code))
  if (missing.length === 0) {
    return NextResponse.json({ ok: true, seeded: 0, message: 'Chart already up to date' })
  }

  const { error } = await admin.from('chart_of_accounts' as any).insert(
    missing.map(a => ({
      fund_id: gate.fundId, portfolio_group: group, vehicle_id: vehicleId,
      code: a.code, name: a.name, type: a.type, subtype: a.subtype ?? null,
    })),
  )
  if (error) return dbError(error, 'manco-setup')

  return NextResponse.json({ ok: true, seeded: missing.length })
}
