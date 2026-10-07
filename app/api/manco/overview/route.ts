import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
// management_company domain (lib/access/route-domains.ts). The middleware has already checked the
// caller's grant for this route + method.
import { assertReadAccess } from '@/lib/api-helpers'
import { resolveMancoGroupOr400 } from '@/lib/accounting/http-vehicle'
import { vehicleIdByName } from '@/lib/accounting/vehicle-id'
import { loadMancoOverview } from '@/lib/accounting/manco-overview'
import { intercompanyBalances, listIntercompanyCharges } from '@/lib/accounting/intercompany'

/**
 * GET — the management company dashboard, in one request. `?group=<manco>&start=&end=`
 *
 * Cash, the quarterly revenue/expense cycle, the expense breakdown, the intercompany balances and
 * the charge register all in one payload, because they are one screen and four round trips to
 * render it is four chances for it to half-load.
 *
 * DEFAULT WINDOW: the trailing eight quarters, ending today. Two years is the shortest window in
 * which a quarterly cycle reads as a cycle — one year is four points, and four points do not show
 * you that last Q3's fee never arrived. It ends today rather than at the last closed period because
 * this is an operating view: a firm looking at its own cash wants this month included, unclosed.
 */
export async function GET(req: NextRequest) {
  const supabase = await createClient()
  const admin = createAdminClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  const gate = await assertReadAccess(admin, user.id)
  if (gate instanceof NextResponse) return gate

  const sp = req.nextUrl.searchParams
  const group = await resolveMancoGroupOr400(admin, gate, sp.get('group'))
  if (group instanceof NextResponse) return group

  const window = resolveWindow(sp.get('start'), sp.get('end'))
  const vehicleId = await vehicleIdByName(admin, gate.fundId, group)

  const [overview, balances, charges] = await Promise.all([
    loadMancoOverview(admin, gate.fundId, group, window),
    intercompanyBalances(admin, gate.fundId, group),
    vehicleId ? listIntercompanyCharges(admin, gate.fundId, vehicleId) : Promise.resolve([]),
  ])

  return NextResponse.json({
    ...overview,
    vehicleId,
    window,
    intercompany: {
      balances,
      charges: charges.map(c => ({
        id: c.id,
        kind: c.kind,
        chargeDate: c.charge_date,
        amount: Number(c.amount),
        memo: c.memo,
        status: c.status,
        settledDate: c.settled_date,
        // Which way round the charge runs, from THIS vehicle's point of view — the register is
        // read on one vehicle's page, and "we billed them" and "they billed us" are the first
        // thing a reader needs and the easiest thing to get backwards from two ids.
        direction: c.to_vehicle_id === vehicleId ? 'receivable' : 'payable',
        counterpartyVehicleId: c.to_vehicle_id === vehicleId ? c.from_vehicle_id : c.to_vehicle_id,
      })),
    },
  })
}

/** ISO date for a Date, in UTC — the ledger stores plain dates and this must not shift by a day. */
function iso(d: Date): string {
  return d.toISOString().slice(0, 10)
}

function resolveWindow(start: string | null, end: string | null): { start: string; end: string } {
  const isDate = (v: string | null): v is string => !!v && /^\d{4}-\d{2}-\d{2}$/.test(v)
  const endDate = isDate(end) ? end : iso(new Date())
  if (isDate(start)) {
    // An inverted window would produce no quarters and an empty chart with no explanation; treat
    // it as the caller meaning the two the other way round.
    return start <= endDate ? { start, end: endDate } : { start: endDate, end: start }
  }
  const d = new Date(`${endDate}T00:00:00Z`)
  d.setUTCMonth(d.getUTCMonth() - 23)
  d.setUTCDate(1)
  return { start: iso(d), end: endDate }
}
