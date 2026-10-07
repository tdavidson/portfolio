// GET /api/lps/live-report
//
// Derives the LP capital report from the books (ledger vehicles) and dated positions
// (LP-tracking vehicles), rolled up per investor. Writes nothing.
//
//   ?asOf=YYYY-MM-DD    live report as of this date (defaults to latest)

import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { assertReadAccess } from '@/lib/api-helpers'
import { generateLiveReport } from '@/lib/accounting/live-report'
import { loadEntityScope } from '@/lib/access/entity-scope'
import { scopeLiveReport } from '@/lib/access/lp-scope'

export async function GET(req: NextRequest) {
  const supabase = await createClient()
  const admin = createAdminClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  // ADMIN (or the read-only demo viewer), same as every accounting route — this pipes ledger
  // data (each LP's commitment / paid-in / distributions / NAV / ratios / IRR, plus the
  // associates look-through), so it takes the ledger's posture.
  const gate = await assertReadAccess(admin, user.id)
  if (gate instanceof NextResponse) return gate
  const fundId = gate.fundId

  const asOf = req.nextUrl.searchParams.get('asOf') || undefined
  // An `asOf` that isn't a date reaches Postgres and comes back as raw error text. Reject it here.
  if (asOf && !/^\d{4}-\d{2}-\d{2}$/.test(asOf)) {
    return NextResponse.json({ error: 'asOf must be YYYY-MM-DD.' }, { status: 400 })
  }

  let live
  try {
    // Built fund-wide, then cut to the caller's entities.
    live = scopeLiveReport(await generateLiveReport(admin, fundId, asOf), (await loadEntityScope(admin, gate)).vehicleNames)
  } catch (e) {
    console.error('[live-report]', e)
    return NextResponse.json({ error: 'Could not build the report.' }, { status: 500 })
  }

  // An LP report is aggregated per INVESTOR (who may hold through several entities, across
  // several vehicles), so the client needs the entity → investor mapping to roll up.
  const { data: entRows } = await admin
    .from('lp_entities' as any)
    .select('id, entity_name, investor_id, lp_investors!inner(id, name)')
    .eq('fund_id', fundId) as { data: any[] | null }

  const investorByEntity = new Map<string, { id: string; name: string }>()
  for (const e of (entRows ?? [])) {
    if (e.lp_investors) investorByEntity.set(e.id, { id: e.lp_investors.id, name: e.lp_investors.name })
  }

  return NextResponse.json({
    asOf: live.asOf,
    vehicles: live.vehicles,
    rows: live.rows.map(r => {
      const inv = investorByEntity.get(r.entity_id)
      return {
        ...r,
        entity_name: live.entityNames.get(r.entity_id) ?? r.entity_id,
        investor_id: inv?.id ?? r.entity_id,
        investor_name: inv?.name ?? live.entityNames.get(r.entity_id) ?? r.entity_id,
      }
    }),
  })
}
