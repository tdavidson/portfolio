import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { assertReadAccess } from '@/lib/api-helpers'
import { hasAccess, loadAccessContext } from '@/lib/access/effective'
import { fundEconomics } from '@/lib/accounting/fund-economics'
import { canSeeVehicle } from '@/lib/access/scope'

// Fund-level performance per vehicle, derived from the ledger.
//
// FUND-WIDE — it reports every vehicle, so there is no `group` to resolve. `asOf` is a real
// as-of: the terminal value in the IRR lands on that date, not on today.

export async function GET(req: NextRequest) {
  const supabase = await createClient()
  const admin = createAdminClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  const gate = await assertReadAccess(admin, user.id)
  if (gate instanceof NextResponse) return gate

  const access = await loadAccessContext(admin, gate.fundId, user.id, gate.role)

  const asOf = req.nextUrl.searchParams.get('asOf') ?? undefined
  if (asOf && !/^\d{4}-\d{2}-\d{2}$/.test(asOf)) {
    return NextResponse.json({ error: 'asOf must be YYYY-MM-DD' }, { status: 400 })
  }

  try {
    // Only the caller's entities.
    const vehicles = (await fundEconomics(admin, gate.fundId, asOf)).filter(v => canSeeVehicle(access, v.id))

    // `carryAccrued` and the GP-class block are gp_economics. The fund overview is otherwise
    // ordinary accounting, and the `lp` metrics are already net-to-LP with the carry removed —
    // so a bookkeeper still gets a complete, correct picture without the GP's economics in it.
    //
    // OMITTED, not zeroed: `carryAccrued: 0` would read as "no carry has accrued", which is a
    // lie rather than a redaction.
    const canReadCarry = hasAccess(access, 'gp_economics', 'read')
    const safe = canReadCarry
      ? vehicles
      : vehicles.map(({ gp: _gp, carryAccrued: _carry, ...rest }) => rest)

    return NextResponse.json({ asOf: asOf ?? null, vehicles: safe })
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : 'Failed' }, { status: 500 })
  }
}
