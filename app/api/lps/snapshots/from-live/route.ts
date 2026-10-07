import { createHash } from 'node:crypto'
import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { dbError } from '@/lib/api-error'
// lp_capital domain (lib/access/route-domains.ts). The middleware has already checked the caller's
// grant for this route + method; this resolves identity and keeps the demo out of writes.
import { assertWriteAccess } from '@/lib/api-helpers'
import { generateLiveReport } from '@/lib/accounting/live-report'
import { loadAccessContext } from '@/lib/access/effective'
import { canSeeVehicle } from '@/lib/access/scope'

// Freeze the LIVE LP report into a snapshot, so it can be SHARED with LPs.
//
// The portal is document-based: an LP is shown a fixed statement, not a moving target. So to
// "share the live report" you first freeze it — this creates an `lp_snapshots` row and writes
// the current live figures into `lp_investments` for it. The caller then shares that snapshot
// through the normal snapshot share/send flow. Nothing about the live data changes.
//
// POST { name?, asOfDate? } → { snapshotId, name }

export async function POST(req: NextRequest) {
  const supabase = await createClient()
  const admin = createAdminClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  const gate = await assertWriteAccess(admin, user.id)
  if (gate instanceof NextResponse) return gate

  const body = await req.json().catch(() => ({}))
  const asOf = (typeof body?.asOfDate === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(body.asOfDate)) ? body.asOfDate : undefined

  // A snapshot is a fund-wide record every member reads, so freezing one needs sight of every
  // entity: a member who sees only some would freeze a partial report as if it were the fund's.
  const access = await loadAccessContext(admin, gate.fundId, gate.userId, gate.role)
  if (!canSeeVehicle(access, null)) {
    return NextResponse.json({ error: 'Only someone who can see every entity can freeze the fund\'s live report.' }, { status: 403 })
  }
  const report = await generateLiveReport(admin, gate.fundId, asOf)
  const asOfDate = report.asOf ?? new Date().toISOString().slice(0, 10)
  const fingerprint = createHash('sha256').update(JSON.stringify(report.rows)).digest('hex').slice(0, 12)
  const name = String(body?.name ?? '').trim() || `Live report — ${asOfDate} — ${fingerprint}`

  // Carry the fund-level live report header/footer onto the frozen snapshot.
  const { data: fs } = await (admin as any)
    .from('fund_settings').select('lp_report_description, lp_report_footer').eq('fund_id', gate.fundId).maybeSingle()

  // Identical default reports reuse an immutable content version; changed figures get a new
  // version. The RPC freezes the header and rows atomically.
  const rows = report.rows.map(r => ({
    fund_id: gate.fundId,
    entity_id: r.entity_id,
    portfolio_group: r.portfolio_group,
    commitment: r.commitment,
    called_capital: r.called_capital,
    paid_in_capital: r.paid_in_capital,
    distributions: r.distributions,
    nav: r.nav,
    total_value: r.total_value,
    outstanding_balance: r.outstanding_balance,
    dpi: r.dpi, rvpi: r.rvpi, tvpi: r.tvpi, irr: r.irr,
  }))
  const { data, error } = await admin.rpc('freeze_live_report' as any, {
    p_fund_id: gate.fundId, p_name: name, p_as_of: asOfDate,
    p_description: (fs as any)?.lp_report_description ?? null,
    p_footer: (fs as any)?.lp_report_footer ?? null,
    p_rows: rows,
  })
  if (error) return dbError(error, 'from-live')
  if (body?.name && !(data as any)?.created) return NextResponse.json({ error: 'That report name already exists. Choose a new name to preserve the earlier report.' }, { status: 409 })
  return NextResponse.json(data)
}
