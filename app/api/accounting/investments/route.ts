import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
// accounting domain (lib/access/route-domains.ts). The middleware has already checked the caller's
// grant for this route + method; these resolve identity and keep the demo out of writes.
import { assertWriteAccess, assertReadAccess } from '@/lib/api-helpers'
import { resolveGroupOr400 } from '@/lib/accounting/http-vehicle'
import { ledgerByCompany } from '@/lib/accounting/investments'
import { buildSoiPositions, type SoiCompany } from '@/lib/accounting/soi'
import { backfillDerivedEntries } from '@/lib/accounting/investment-backfill'

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
  const group = await resolveGroupOr400(admin, gate, body?.group ?? req.nextUrl.searchParams.get('group'))
  if (group instanceof NextResponse) return group

  // Derive the entries historical transactions never derived: marks post, cash entries draft and
  // wait for their bank match. `dryRun` previews. Idempotent — see lib/accounting/investment-backfill.ts.
  if (body?.action === 'backfill') {
    return NextResponse.json(await backfillDerivedEntries(admin, gate.fundId, group, user.id, { dryRun: !!body?.dryRun }))
  }

  return NextResponse.json({ error: "Unknown action. Record investments, marks and exits as transactions on each company; 'backfill' puts existing ones on the ledger." }, { status: 400 })
}
