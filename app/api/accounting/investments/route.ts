import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
// accounting domain (lib/access/route-domains.ts). The middleware has already checked the caller's
// grant for this route + method; these resolve identity and keep the demo out of writes.
import { assertWriteAccess, assertReadAccess } from '@/lib/api-helpers'
import { resolveGroupOr400 } from '@/lib/accounting/http-vehicle'
import { ledgerByCompany } from '@/lib/accounting/investments'
import { buildSoiPositions, type SoiCompany } from '@/lib/accounting/soi'
import { backfillDerivedEntries, backfillAllVehicles } from '@/lib/accounting/investment-backfill'
import { visibleVehicleNames } from '@/lib/accounting/vehicle-visibility'

// GET — each tracked position for the vehicle, alongside what the LEDGER carries for
// it. The gap between the two is what needs booking.
export async function GET(req: NextRequest) {
  const supabase = await createClient()
  const admin = createAdminClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  const gate = await assertReadAccess(admin, user.id)
  if (gate instanceof NextResponse) return gate
  const group = await resolveGroupOr400(admin, gate, req.nextUrl.searchParams.get('group'))
  if (group instanceof NextResponse) return group

  const [{ data: txns }, { data: companies }, ledger] = await Promise.all([
    admin.from('investment_transactions' as any).select('*').eq('fund_id', gate.fundId),
    admin.from('companies' as any).select('*').eq('fund_id', gate.fundId),
    ledgerByCompany(admin, gate.fundId, group),
  ])

  const positions = buildSoiPositions(
    ((txns as any[]) ?? []),
    ((companies as any[]) ?? []) as SoiCompany[],
    group,
  )

  const rows = positions.map(p => {
    const l = ledger.get(p.companyId)
    return {
      ...p,
      ledgerCost: l?.cost ?? 0,
      ledgerUnrealized: l?.unrealized ?? 0,
      ledgerFairValue: l?.carrying ?? 0,
      onLedger: !!l,
      tiesOut: !!l && Math.abs(l.cost - p.cost) < 0.005 && Math.abs(l.carrying - p.fairValue) < 0.005,
    }
  })

  return NextResponse.json({
    positions: rows,
    trackerCost: rows.reduce((s, r) => s + r.cost, 0),
    trackerFairValue: rows.reduce((s, r) => s + r.fairValue, 0),
    ledgerCost: rows.reduce((s, r) => s + r.ledgerCost, 0),
    ledgerFairValue: rows.reduce((s, r) => s + r.ledgerFairValue, 0),
  })
}

// POST
//   { action: 'backfill', dryRun? } → adopt what's posted, derive what's missing, post what waits
//                                     (lib/accounting/investment-backfill.ts)
// Investments reach the ledger only through investment transactions (plans/spec-ledger-one-writer.md):
// bootstrap, history replay, single marks and FX revaluations were retired with that.
export async function POST(req: NextRequest) {
  const supabase = await createClient()
  const admin = createAdminClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  const gate = await assertWriteAccess(admin, user.id)
  if (gate instanceof NextResponse) return gate

  const body = await req.json().catch(() => ({}))

  // Every entity at once — the rollout's one run, and the firm index's "Put all on the ledger".
  // Admins only: it writes across entities. Still limited to the entities the caller can see.
  if (body?.action === 'backfill' && body?.all === true) {
    if (gate.role !== 'admin') return NextResponse.json({ error: 'Only an admin can put every entity on the ledger at once.' }, { status: 403 })
    const visible = await visibleVehicleNames(admin, gate)
    return NextResponse.json({ vehicles: await backfillAllVehicles(admin, gate.fundId, user.id, visible, { dryRun: !!body?.dryRun }) })
  }

  const group = await resolveGroupOr400(admin, gate, body?.group ?? req.nextUrl.searchParams.get('group'))
  if (group instanceof NextResponse) return group

  // Adopt posted investment entries, derive what's missing, post what waited. `dryRun` previews. Idempotent — see lib/accounting/investment-backfill.ts.
  if (body?.action === 'backfill') {
    try {
      return NextResponse.json(await backfillDerivedEntries(admin, gate.fundId, group, user.id, { dryRun: !!body?.dryRun }))
    } catch (e) {
      console.error('[accounting-investments-backfill]', e instanceof Error ? e.message : e)
      return NextResponse.json({ error: 'Part of the ledger could not be read, so nothing was put on it. Try again.' }, { status: 500 })
    }
  }

  return NextResponse.json({ error: "Unknown action. Record investments, marks and exits as transactions on each company; 'backfill' puts existing ones on the ledger." }, { status: 400 })
}
