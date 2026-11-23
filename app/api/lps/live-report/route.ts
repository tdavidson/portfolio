// GET /api/lps/live-report
//
// Derives the LP capital report from the books (ledger vehicles) and dated positions
// (LP-tracking vehicles), rolled up per investor. Writes nothing.
//
//   ?asOf=YYYY-MM-DD    live report as of this date (defaults to latest)
//   ?fresh=1            latest only: never serve a stored report the books have moved past
//
// The latest report comes from the stored whole-fund report (lib/accounting/live-report-cache),
// the same one the MCP lp_live_report tool and the report cards read. Without `fresh`, a stored
// report the books have since moved past is served at once with `stale: true`, and the page then
// asks again with `fresh=1`, which rebuilds and stores it. A past date is built as before.

import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { assertReadAccess } from '@/lib/api-helpers'
import { generateLiveReport, type LiveReport } from '@/lib/accounting/live-report'
import { currentLiveReport } from '@/lib/accounting/live-report-cache'
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

  const fresh = req.nextUrl.searchParams.get('fresh') === '1'

  // The report, the caller's entity scope and the entity → investor mapping are independent
  // reads, so they run side by side.
  let built: LiveReport & { computedAt?: string; stale?: boolean }
  let scope: Awaited<ReturnType<typeof loadEntityScope>>
  let entRows: any[] | null
  try {
    ;[built, scope, entRows] = await Promise.all([
      // Built (or stored) fund-wide, then cut to the caller's entities below.
      asOf ? generateLiveReport(admin, fundId, asOf) : currentLiveReport(admin, fundId, { allowStale: !fresh }),
      loadEntityScope(admin, gate),
      // An LP report is aggregated per INVESTOR (who may hold through several entities, across
      // several vehicles), so the client needs the entity → investor mapping to roll up.
      (admin
        .from('lp_entities' as any)
        .select('id, entity_name, investor_id, lp_investors!inner(id, name)')
        .eq('fund_id', fundId) as unknown as Promise<{ data: any[] | null }>).then(r => r.data),
    ])
  } catch (e) {
    console.error('[live-report]', e)
    return NextResponse.json({ error: 'Could not build the report.' }, { status: 500 })
  }
  const live = scopeLiveReport(built, scope.vehicleNames)

  const investorByEntity = new Map<string, { id: string; name: string }>()
  for (const e of (entRows ?? [])) {
    if (e.lp_investors) investorByEntity.set(e.id, { id: e.lp_investors.id, name: e.lp_investors.name })
  }

  return NextResponse.json({
    asOf: live.asOf,
    computedAt: built.computedAt ?? null,
    stale: built.stale ?? false,
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
