import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
// accounting domain (lib/access/route-domains.ts).
import { assertWriteAccess } from '@/lib/api-helpers'
import { confirmFundCapitalEvent } from '@/lib/portfolio/fof-register'
import { loadAccessContext } from '@/lib/access/effective'
import { visibleVehicleIds } from '@/lib/access/scope'

/**
 * Confirm every draft register row up to a period end.
 *
 * Confirmation runs through the SAME confirmFundCapitalEvent the single-row path uses — this
 * route is a loop, not a second write path. A row that predates the vehicle's ledger start
 * date reports `skipped`, which is a success: it counts for every derived metric and posts
 * nothing, because the migrated system already posted it.
 */
export async function POST(req: NextRequest) {
  const supabase = await createClient()
  const admin = createAdminClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  const gate = await assertWriteAccess(admin, user.id)
  if (gate instanceof NextResponse) return gate

  const body = await req.json().catch(() => ({}))
  const periodEnd = typeof body?.periodEnd === 'string'
    ? body.periodEnd
    : new Date().toISOString().slice(0, 10)

  // Only the caller's entities' events.
  const access = await loadAccessContext(admin, gate.fundId, gate.userId, gate.role)
  const vehicleIds = visibleVehicleIds(access)
  let draftQuery = (admin as any)
    .from('fund_capital_events')
    .select('id')
    .eq('fund_id', gate.fundId)
    .eq('status', 'draft')
    .lte('event_date', periodEnd)
  if (vehicleIds !== null) draftQuery = draftQuery.in('vehicle_id', vehicleIds)
  const { data: drafts } = await draftQuery.order('event_date')

  const ids = ((drafts as any[]) ?? []).map(d => d.id)

  let confirmed = 0
  let skipped = 0
  const errors: string[] = []

  // Sequential on purpose: each confirm inserts a transaction and drafts a ledger entry, and
  // a burst of parallel writes against the same vehicle buys nothing but lock contention.
  for (const id of ids) {
    const result = await confirmFundCapitalEvent(admin, gate.fundId, user.id, id)
    if (!result.ok) { errors.push(result.error ?? 'Unknown error'); continue }
    if (result.skipped) skipped += 1
    else confirmed += 1
  }

  return NextResponse.json({ total: ids.length, confirmed, skipped, errors })
}
